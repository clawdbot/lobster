import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { runPipeline } from "../src/runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("gog.gmail.search | email.triage works end-to-end (mock gog)", async () => {
  const registry = createDefaultRegistry();

  // Tests run from dist/, but fixtures live in source tree.
  const repoRoot = join(__dirname, "..", "..");
  const mockGog = join(repoRoot, "test", "fixtures", "mock-gog.mjs");

  const result = await runPipeline({
    pipeline: [
      { name: "gog.gmail.search", args: { query: "newer_than:1d", max: 20 }, raw: "" },
      { name: "email.triage", args: { limit: 20 }, raw: "" },
    ],
    registry,
    input: [],
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: { ...process.env, GOG_BIN: mockGog },
    mode: "tool",
  } as any);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].summary, "1 need replies, 1 need action, 1 FYI");
});

test("email.triage buckets based on subject/from/labels", async () => {
  const registry = createDefaultRegistry();

  const emails = [
    {
      id: "m1",
      threadId: "t1",
      from: "Alice <alice@example.com>",
      subject: "Quick question",
      date: "2026-01-22T07:00:00Z",
      snippet: "Hey, can you take a look?",
      labels: ["INBOX", "UNREAD"],
    },
    {
      id: "m2",
      threadId: "t2",
      from: "no-reply@service.com",
      subject: "Your receipt",
      date: "2026-01-22T06:00:00Z",
      snippet: "Thanks",
      labels: ["INBOX", "UNREAD"],
    },
    {
      id: "m3",
      threadId: "t3",
      from: "Bob <bob@example.com>",
      subject: "Action required: NDA",
      date: "2026-01-21T23:00:00Z",
      snippet: "Please sign",
      labels: ["INBOX"],
    },
  ];

  const input = (async function* () {
    for (const e of emails) yield e;
  })();

  const result = await runPipeline({
    pipeline: [{ name: "email.triage", args: { limit: 20 }, raw: "" }],
    registry,
    input,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: "tool",
  } as any);

  assert.equal(result.items.length, 1);
  const out = result.items[0];
  assert.equal(out.summary, "1 need replies, 1 need action, 1 FYI");
  assert.deepEqual(out.buckets.needsReply, ["m1"]);
  assert.deepEqual(out.buckets.needsAction, ["m3"]);
  assert.deepEqual(out.buckets.fyi, ["m2"]);
});

test("email.triage --llm uses llm_task.invoke to draft replies (and can emit drafts)", async () => {
  const registry = createDefaultRegistry();

  const emails = [
    {
      id: "m1",
      threadId: "t1",
      from: "Alice <alice@example.com>",
      subject: "Quick question",
      date: "2026-01-22T07:00:00Z",
      snippet: "Hey, can you take a look?",
      labels: ["INBOX", "UNREAD"],
    },
    {
      id: "m2",
      threadId: "t2",
      from: "Bob <bob@example.com>",
      subject: "Action required: NDA",
      date: "2026-01-21T23:00:00Z",
      snippet: "Please sign",
      labels: ["INBOX"],
    },
  ];

  const cacheDir = await mkdtemp(join(tmpdir(), "lobster-cache-"));

  const bodyLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/tools/invoke") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (buf += d));
    req.on("end", () => {
      const parsed = JSON.parse(buf || "{}");
      bodyLog.push(parsed);

      res.writeHead(200, { "content-type": "application/json" });
      // OpenClaw tool router envelope -> llm-task tool envelope
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            ok: true,
            result: {
              runId: "triage_1",
              output: {
                data: {
                  decisions: [
                    {
                      id: "m1",
                      category: "needs_reply",
                      rationale: "Unclear question",
                      reply: { body: "Sure — what’s the deadline?" },
                    },
                    { id: "m2", category: "needs_action", rationale: "NDA" },
                  ],
                },
              },
            },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  try {
    // Report mode
    const input1 = (async function* () {
      for (const e of emails) yield e;
    })();

    const res1 = await runPipeline({
      pipeline: [{ name: "email.triage", args: { llm: true, model: "claude-test", limit: 20 }, raw: "" }],
      registry,
      input: input1,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: {
        ...process.env,
        CLAWD_URL: `http://127.0.0.1:${port}`,
        LOBSTER_CACHE_DIR: cacheDir,
        LLM_TASK_FORCE_REFRESH: "1",
      },
      mode: "tool",
    } as any);

    assert.equal(res1.items.length, 1);
    assert.equal(res1.items[0].mode, "llm");
    assert.equal(res1.items[0].buckets.needsReply.length, 1);
    assert.equal(res1.items[0].drafts.length, 1);
    assert.equal(res1.items[0].drafts[0].to, "alice@example.com");

    // Draft emit mode
    const input2 = (async function* () {
      for (const e of emails) yield e;
    })();

    const res2 = await runPipeline({
      pipeline: [
        {
          name: "email.triage",
          args: { llm: true, model: "claude-test", limit: 20, emit: "drafts" },
          raw: "",
        },
      ],
      registry,
      input: input2,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: {
        ...process.env,
        CLAWD_URL: `http://127.0.0.1:${port}`,
        LOBSTER_CACHE_DIR: cacheDir,
        LLM_TASK_FORCE_REFRESH: "1",
      },
      mode: "tool",
    } as any);

    assert.equal(res2.items.length, 1);
    assert.equal(res2.items[0].to, "alice@example.com");
    assert.ok(res2.items[0].subject.toLowerCase().startsWith("re:"));
    assert.equal(bodyLog.length >= 1, true);
    assert.equal(bodyLog[0].args?.model ?? bodyLog[0].model, "claude-test");
    assert.ok(bodyLog[0].prompt || bodyLog[0].args?.prompt);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});
