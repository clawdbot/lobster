import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDefaultRegistry } from '../src/commands/registry.js';

function streamOf(items: any[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

async function collect(iterable: AsyncIterable<any>) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test('llm_task.invoke posts to /tools/invoke (clawd) and normalizes result', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd, 'llm_task.invoke should be registered');
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const bodyLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      const parsed = JSON.parse(buf || '{}');
      bodyLog.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            ok: true,
            result: {
              runId: 'task_1',
              model: parsed.args?.model,
              prompt: parsed.args?.prompt,
              output: {
                text: 'done',
                data: { summary: 'hello world' },
              },
              usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
            },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([{ kind: 'text', text: 'doc' }]),
      args: {
        _: [],
        token: 'test-token',
        model: 'claude-3-sonnet',
        prompt: 'Summarize',
      },
      ctx: baseCtx({ LOBSTER_CACHE_DIR: cacheDir, CLAWD_URL: `http://localhost:${port}` }, registry),
    } as any);

    const items = await collect(result.output!);
    assert.equal(items.length, 1);
    const payload = items[0];
    assert.equal(payload.kind, 'llm_task.invoke');
    assert.equal(payload.runId, 'task_1');
    assert.equal(payload.output.data.summary, 'hello world');
    assert.equal(payload.model, 'claude-3-sonnet');
    assert.equal(payload.source, 'clawd');
    assert.equal(payload.cached, false);
    assert.ok(payload.cacheKey);

    assert.equal(bodyLog.length, 1);
    assert.equal(bodyLog[0].tool, 'llm-task');
    assert.equal(bodyLog[0].action, 'invoke');
    assert.equal(bodyLog[0].args.prompt, 'Summarize');
    assert.equal(bodyLog[0].args.model, 'claude-3-sonnet');
    assert.equal(bodyLog[0].args.artifacts.length, 1);
    assert.equal(bodyLog[0].args.artifactHashes.length, 1);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke retries when schema validation fails', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  let calls = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end();
      return;
    }
    calls += 1;
    const valid = calls >= 2;
    const payload = {
      ok: true,
      result: {
        ok: true,
        result: {
          runId: `attempt_${calls}`,
          output: valid ? { data: { decision: 'send' } } : { data: { foo: 'bar' } },
        },
      },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([]),
      args: {
        _: [],
        model: 'claude-3-opus',
        prompt: 'Decide',
        'output-schema': '{"type":"object","required":["decision"]}',
        'max-validation-retries': 2,
      },
      ctx: baseCtx({ LOBSTER_CACHE_DIR: cacheDir, CLAWD_URL: `http://localhost:${port}` }, registry),
    } as any);

    const items = await collect(result.output!);
    assert.equal(items.length, 1);
    assert.equal(items[0].runId, 'attempt_2');
    assert.equal(items[0].output.data.decision, 'send');
    assert.equal(calls, 2);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke persists to run state so resume skips remote call', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'lobster-state-'));
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      void buf;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, result: { ok: true, result: { runId: 'state_run', output: { data: { ok: true } } } } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));
  const ctxEnv = { LOBSTER_STATE_DIR: stateDir, LOBSTER_CACHE_DIR: cacheDir };

  try {
    const first = await cmd.run({
      input: streamOf([{ foo: 'bar' }]),
      args: {
        _: [],
        model: 'claude',
        prompt: 'Do thing',
        'state-key': 'run123',
      },
      ctx: baseCtx({ ...ctxEnv, CLAWD_URL: `http://localhost:${port}` }, registry),
    } as any);
    const firstItems = await collect(first.output!);
    assert.equal(firstItems[0].source, 'clawd');

    await closeServer(server);

    const second = await cmd.run({
      input: streamOf([{ foo: 'bar' }]),
      args: {
        _: [],
        model: 'claude',
        prompt: 'Do thing',
        'state-key': 'run123',
      },
      ctx: baseCtx({ ...ctxEnv, CLAWD_URL: `http://localhost:${port}` }, registry),
    } as any);
    const secondItems = await collect(second.output!);
    assert.equal(secondItems.length, 1);
    assert.equal(secondItems[0].source, 'run_state');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke reuses file cache when URL unavailable', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      void buf;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, result: { ok: true, result: { runId: 'cache_run', output: { text: 'cached' } } } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const ctxEnv = { LOBSTER_CACHE_DIR: cacheDir, CLAWD_URL: `http://localhost:${port}` };

  try {
    const first = await cmd.run({
      input: streamOf([]),
      args: {
        _: [],
        model: 'claude',
        prompt: 'Cache me',
      },
      ctx: baseCtx({ ...ctxEnv, CLAWD_URL: `http://localhost:${port}` }, registry),
    } as any);
    const firstItems = await collect(first.output!);
    assert.equal(firstItems[0].source, 'clawd');

    await closeServer(server);

    const second = await cmd.run({
      input: streamOf([]),
      args: {
        _: [],
        model: 'claude',
        prompt: 'Cache me',
      },
      ctx: baseCtx({ ...ctxEnv, CLAWD_URL: `http://localhost:${port}` }, registry),
    } as any);
    const secondItems = await collect(second.output!);
    assert.equal(secondItems.length, 1);
    assert.equal(secondItems[0].source, 'cache');
    assert.equal(secondItems[0].cached, true);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm_task.invoke uses CLAWD_URL (/tools/invoke) without requiring --url/--model', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm_task.invoke');
  assert.ok(cmd);

  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const bodyLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      const parsed = JSON.parse(buf || '{}');
      bodyLog.push(parsed);

      // This is the OpenClaw tool router envelope.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            ok: true,
            result: {
              runId: 'task_clawd_1',
              output: { data: { hello: 'world' } },
            },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([{ kind: 'text', text: 'doc' }]),
      args: {
        _: [],
        // no url, no model
        prompt: 'Summarize',
        refresh: true,
      },
      ctx: baseCtx({ CLAWD_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir }, registry),
    } as any);

    const items = await collect(result.output!);
    assert.equal(items.length, 1);
    assert.equal(items[0].source, 'clawd');
    assert.equal(items[0].cached, false);
    assert.equal(items[0].runId, 'task_clawd_1');
    assert.equal(items[0].output.data.hello, 'world');

    assert.equal(bodyLog.length, 1);
    assert.equal(bodyLog[0].tool, 'llm-task');
    assert.equal(bodyLog[0].action, 'invoke');
    assert.equal(bodyLog[0].args.prompt, 'Summarize');
    assert.ok(Array.isArray(bodyLog[0].args.artifactHashes));
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

function baseCtx(envOverrides: Record<string, string>, registry?) {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: { ...process.env, ...envOverrides },
    registry: registry ?? null,
    mode: 'tool',
    render: { json() {}, lines() {} },
  };
}

async function closeServer(server: http.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
