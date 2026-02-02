import { parsePipeline } from './parser.js';
import { createDefaultRegistry } from './commands/registry.js';
import { runPipeline } from './runtime.js';
import { encodeToken } from './token.js';
import { decodeResumeToken, parseResumeArgs } from './resume.js';
import { runWorkflowFile } from './workflows/file.js';

export async function runCli(argv) {
  const registry = createDefaultRegistry();

  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(helpText());
    return;
  }

  if (argv[0] === 'help') {
    const topic = argv[1];
    if (!topic) {
      process.stdout.write(helpText());
      return;
    }
    const cmd = registry.get(topic);
    if (!cmd) {
      process.stderr.write(`Unknown command: ${topic}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(cmd.help());
    return;
  }

  if (argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${await readVersion()}\n`);
    return;
  }

  if (argv[0] === 'doctor') {
    await handleDoctor({ argv: argv.slice(1), registry });
    return;
  }

  if (argv[0] === 'run') {
    await handleRun({ argv: argv.slice(1), registry });
    return;
  }

  if (argv[0] === 'resume') {
    await handleResume({ argv: argv.slice(1), registry });
    return;
  }

  // Default: treat argv as a pipeline string.
  await handleRun({ argv, registry });
}

async function handleRun({ argv, registry }) {
  const { mode, rest, filePath, argsJson } = parseRunArgs(argv);
  const normalizedMode = normalizeMode(mode);

  const workflowFile = filePath
    ? await resolveWorkflowFile(filePath)
    : await detectWorkflowFile(rest);
  if (workflowFile) {
    let parsedArgs = {};
    if (argsJson) {
      try {
        parsedArgs = JSON.parse(argsJson);
      } catch {
        if (mode === 'tool') {
          writeToolEnvelope({ ok: false, error: { type: 'parse_error', message: 'run --args-json must be valid JSON' } });
          process.exitCode = 2;
          return;
        }
        process.stderr.write('run --args-json must be valid JSON\n');
        process.exitCode = 2;
        return;
      }
    }

    try {
      const output = await runWorkflowFile({
        filePath: workflowFile,
        args: parsedArgs,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env: process.env,
          mode: normalizedMode,
        },
      });

      if (normalizedMode === 'tool') {
        if (output.status === 'needs_approval') {
          writeToolEnvelope({
            ok: true,
            status: 'needs_approval',
            output: [],
            requiresApproval: output.requiresApproval ?? null,
          });
          return;
        }

        writeToolEnvelope({
          ok: true,
          status: 'ok',
          output: output.output,
          requiresApproval: null,
        });
        return;
      }

      if (output.status === 'ok' && output.output.length) {
        process.stdout.write(JSON.stringify(output.output, null, 2));
        process.stdout.write('\n');
      }
      return;
    } catch (err) {
      if (normalizedMode === 'tool') {
        writeToolEnvelope({ ok: false, error: { type: 'runtime_error', message: err?.message ?? String(err) } });
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const pipelineString = rest.join(' ');

  let pipeline;
  try {
    pipeline = parsePipeline(pipelineString);
  } catch (err) {
    if (mode === 'tool') {
      writeToolEnvelope({ ok: false, error: { type: 'parse_error', message: err?.message ?? String(err) } });
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`Parse error: ${err?.message ?? String(err)}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const output = await runPipeline({
      pipeline,
      registry,
      input: [],
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      mode: normalizedMode,
    });

    if (normalizedMode === 'tool') {
      const approval = output.halted && output.items.length === 1 && output.items[0]?.type === 'approval_request'
        ? output.items[0]
        : null;

      if (approval) {
        const resumeToken = encodeToken({
          protocolVersion: 1,
          v: 1,
          pipeline,
          resumeAtIndex: (output.haltedAt?.index ?? -1) + 1,
          items: approval.items,
          prompt: approval.prompt,
        });

        writeToolEnvelope({
          ok: true,
          status: 'needs_approval',
          output: [],
          requiresApproval: {
            ...approval,
            resumeToken,
          },
        });
        return;
      }

      writeToolEnvelope({
        ok: true,
        status: 'ok',
        output: output.items,
        requiresApproval: null,
      });
      return;
    }

    // Human mode: if the last command didn't render, print JSON.
    if (!output.rendered) {
      process.stdout.write(JSON.stringify(output.items, null, 2));
      process.stdout.write('\n');
    }
  } catch (err) {
    if (normalizedMode === 'tool') {
      writeToolEnvelope({ ok: false, error: { type: 'runtime_error', message: err?.message ?? String(err) } });
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}

function parseRunArgs(argv) {
  const rest = [];
  let mode = 'human';
  let filePath = null;
  let argsJson = null;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];

    if (tok === '--mode') {
      const value = argv[i + 1];
      if (value) {
        mode = value;
        i++;
      }
      continue;
    }

    if (tok.startsWith('--mode=')) {
      mode = tok.slice('--mode='.length) || 'human';
      continue;
    }

    if (tok === '--file') {
      const value = argv[i + 1];
      if (value) {
        filePath = value;
        i++;
      }
      continue;
    }

    if (tok.startsWith('--file=')) {
      filePath = tok.slice('--file='.length);
      continue;
    }

    if (tok === '--args-json') {
      const value = argv[i + 1];
      if (value) {
        argsJson = value;
        i++;
      }
      continue;
    }

    if (tok.startsWith('--args-json=')) {
      argsJson = tok.slice('--args-json='.length);
      continue;
    }

    rest.push(tok);
  }

  return { mode, rest, filePath, argsJson };
}

function normalizeMode(mode) {
  return mode === 'tool' ? 'tool' : 'human';
}

async function detectWorkflowFile(rest) {
  if (rest.length !== 1) return null;
  const candidate = rest[0];
  if (!candidate || candidate.includes('|')) return null;
  try {
    return await resolveWorkflowFile(candidate);
  } catch {
    return null;
  }
}

async function resolveWorkflowFile(candidate) {
  const { promises: fsp } = await import('node:fs');
  const { resolve, extname, isAbsolute } = await import('node:path');
  const resolved = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error('Workflow path is not a file');

  const ext = extname(resolved).toLowerCase();
  if (!['.lobster', '.yaml', '.yml', '.json'].includes(ext)) {
    throw new Error('Workflow file must end in .lobster, .yaml, .yml, or .json');
  }

  return resolved;
}

async function handleResume({ argv, registry }) {
  const mode = 'tool';
  const { token, approved } = parseResumeArgs(argv);
  const payload = decodeResumeToken(token);

  if (!approved) {
    writeToolEnvelope({ ok: true, status: 'cancelled', output: [], requiresApproval: null });
    return;
  }

  if (payload.kind === 'workflow-file') {
    try {
      const output = await runWorkflowFile({
        filePath: payload.filePath,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env: process.env,
          mode: 'tool',
        },
        resume: payload,
        approved: true,
      });

      if (output.status === 'needs_approval') {
        writeToolEnvelope({
          ok: true,
          status: 'needs_approval',
          output: [],
          requiresApproval: output.requiresApproval ?? null,
        });
        return;
      }

      writeToolEnvelope({ ok: true, status: 'ok', output: output.output, requiresApproval: null });
      return;
    } catch (err) {
      writeToolEnvelope({ ok: false, error: { type: 'runtime_error', message: err?.message ?? String(err) } });
      process.exitCode = 1;
      return;
    }
  }

  const remaining = payload.pipeline.slice(payload.resumeAtIndex);
  const input = (async function* () {
    for (const item of payload.items) yield item;
  })();

  try {
    const output = await runPipeline({
      pipeline: remaining,
      registry,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      mode,
      input,
    });

    const approval = output.halted && output.items.length === 1 && output.items[0]?.type === 'approval_request'
      ? output.items[0]
      : null;

    if (approval) {
      const resumeToken = encodeToken({
        protocolVersion: 1,
        v: 1,
        pipeline: remaining,
        resumeAtIndex: (output.haltedAt?.index ?? -1) + 1,
        items: approval.items,
        prompt: approval.prompt,
      });

      writeToolEnvelope({
        ok: true,
        status: 'needs_approval',
        output: [],
        requiresApproval: { ...approval, resumeToken },
      });
      return;
    }

    writeToolEnvelope({ ok: true, status: 'ok', output: output.items, requiresApproval: null });
  } catch (err) {
    writeToolEnvelope({ ok: false, error: { type: 'runtime_error', message: err?.message ?? String(err) } });
    process.exitCode = 1;
  }
}

async function readVersion() {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', '..', 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  return pkg.version ?? '0.0.0';
}

async function handleDoctor({ argv, registry }) {
  const mode = 'tool';
  const pipeline = "exec --json --shell 'echo [1]'";
  const output: any = await (async () => {
    try {
      const parsed = parsePipeline(pipeline);
      return await runPipeline({
        pipeline: parsed,
        registry,
        input: [],
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        mode,
      });
    } catch (err: any) {
      return { error: err };
    }
  })();

  if (output?.error) {
    writeToolEnvelope({
      ok: false,
      error: { type: 'doctor_error', message: output.error?.message ?? String(output.error) },
    });
    process.exitCode = 1;
    return;
  }

  writeToolEnvelope({
    ok: true,
    status: 'ok',
    output: [{
      toolMode: true,
      protocolVersion: 1,
      version: await readVersion(),
      notes: argv.length ? argv : undefined,
    }],
    requiresApproval: null,
  });
}

function writeToolEnvelope(payload) {
  const envelope = {
    protocolVersion: 1,
    ...payload,
  };
  process.stdout.write(JSON.stringify(envelope, null, 2));
  process.stdout.write('\n');
}

function helpText() {
  return `lobster — OpenClaw-native typed shell\n\n` +
    `Usage:\n` +
    `  lobster '<pipeline>'\n` +
    `  lobster run --mode tool '<pipeline>'\n` +
    `  lobster run path/to/workflow.lobster\n` +
    `  lobster run --file path/to/workflow.lobster --args-json '{...}'\n` +
    `  lobster resume --token <token> --approve yes|no\n` +
    `  lobster doctor\n` +
    `  lobster version\n` +
    `  lobster help <command>\n\n` +
    `Modes:\n` +
    `  - human (default): renderers can write to stdout\n` +
    `  - tool: prints a single JSON envelope for easy integration\n\n` +
    `Examples:\n` +
    `  lobster 'exec --json "echo [1,2,3]" | json'\n` +
    `  lobster run --mode tool 'exec --json "echo [1]" | approve --prompt "ok?"'\n\n` +
    `Commands:\n` +
    `  exec, head, json, pick, table, where, approve, clawd.invoke, state.get, state.set, diff.last, commands.list, workflows.list, workflows.run\n`;
}
