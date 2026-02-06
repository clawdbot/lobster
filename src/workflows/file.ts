import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { randomUUID } from 'node:crypto';

import { encodeToken } from '../token.js';
import { readStateJson, writeStateJson } from '../state/store.js';

export type WorkflowFile = {
  name?: string;
  description?: string;
  args?: Record<string, { default?: unknown; description?: string }>;
  env?: Record<string, string>;
  cwd?: string;
  steps: WorkflowStep[];
};

export type WorkflowStep = {
  id: string;
  command?: string;
  prompt?: string;
  system?: string;
  env?: Record<string, string>;
  cwd?: string;
  stdin?: unknown;
  approval?: boolean | 'required';
  condition?: unknown;
  when?: unknown;
};

export type WorkflowStepResult = {
  id: string;
  stdout?: string;
  json?: unknown;
  approved?: boolean;
  skipped?: boolean;
};

export type WorkflowRunResult = {
  status: 'ok' | 'needs_approval' | 'needs_llm' | 'cancelled';
  output: unknown[];
  requiresApproval?: {
    type: 'approval_request';
    prompt: string;
    items: unknown[];
    preview?: string;
    resumeToken?: string;
  };
  requiresLlm?: {
    type: 'llm_request';
    prompt: string;
    system?: string;
    context?: string;
    resumeToken: string;
  };
};

type RunContext = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
  mode: 'human' | 'tool' | 'sdk';
};

export type WorkflowResumePayload = {
  protocolVersion: 1;
  v: 1;
  kind: 'workflow-file';
  stateKey?: string;
  filePath?: string;
  resumeAtIndex?: number;
  steps?: Record<string, WorkflowStepResult>;
  args?: Record<string, unknown>;
  approvalStepId?: string;
  llmStepId?: string;
};

type WorkflowResumeState = {
  filePath: string;
  resumeAtIndex: number;
  steps: Record<string, WorkflowStepResult>;
  args: Record<string, unknown>;
  approvalStepId?: string;
  llmStepId?: string;
  createdAt: string;
};

export async function loadWorkflowFile(filePath: string): Promise<WorkflowFile> {
  const text = await fsp.readFile(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  const parsed = ext === '.json' ? JSON.parse(text) : parseYaml(text);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Workflow file must be a JSON/YAML object');
  }

  const steps = (parsed as WorkflowFile).steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Workflow file requires a non-empty steps array');
  }

  const seen = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step !== 'object') {
      throw new Error('Workflow step must be an object');
    }
    if (!step.id || typeof step.id !== 'string') {
      throw new Error('Workflow step requires an id');
    }
    const hasCommand = step.command && typeof step.command === 'string';
    const hasPrompt = step.prompt && typeof step.prompt === 'string';
    if (!hasCommand && !hasPrompt) {
      throw new Error(`Workflow step ${step.id} requires a command or prompt string`);
    }
    if (hasCommand && hasPrompt) {
      throw new Error(`Workflow step ${step.id} cannot have both command and prompt`);
    }
    if (seen.has(step.id)) {
      throw new Error(`Duplicate workflow step id: ${step.id}`);
    }
    seen.add(step.id);
  }

  return parsed as WorkflowFile;
}

export function resolveWorkflowArgs(
  argDefs: WorkflowFile['args'],
  provided: Record<string, unknown> | undefined,
) {
  const resolved: Record<string, unknown> = {};
  if (argDefs) {
    for (const [key, def] of Object.entries(argDefs)) {
      if (def && typeof def === 'object' && 'default' in def) {
        resolved[key] = def.default;
      }
    }
  }
  if (provided) {
    for (const [key, value] of Object.entries(provided)) {
      resolved[key] = value;
    }
  }
  return resolved;
}

export async function runWorkflowFile({
  filePath,
  args,
  ctx,
  resume,
  approved,
  llmResponse,
}: {
  filePath?: string;
  args?: Record<string, unknown>;
  ctx: RunContext;
  resume?: WorkflowResumePayload;
  approved?: boolean;
  llmResponse?: string;
}): Promise<WorkflowRunResult> {
  const resumeState = resume?.stateKey
    ? await loadWorkflowResumeState(ctx.env, resume.stateKey)
    : resume ?? null;
  const resolvedFilePath = filePath ?? resumeState?.filePath;
  if (!resolvedFilePath) {
    throw new Error('Workflow file path required');
  }
  const workflow = await loadWorkflowFile(resolvedFilePath);
  const resolvedArgs = resolveWorkflowArgs(workflow.args, args ?? resumeState?.args);
  const steps = workflow.steps;
  const results: Record<string, WorkflowStepResult> = resumeState?.steps
    ? cloneResults(resumeState.steps)
    : {};
  const startIndex = resumeState?.resumeAtIndex ?? 0;

  if (resumeState?.approvalStepId && typeof approved === 'boolean') {
    const previous = results[resumeState.approvalStepId] ?? { id: resumeState.approvalStepId };
    previous.approved = approved;
    results[resumeState.approvalStepId] = previous;
  }

  // Resume from a host LLM callback — inject the response as the step's output
  if (resumeState?.llmStepId && typeof llmResponse === 'string') {
    let json: unknown;
    try { json = JSON.parse(llmResponse.trim()); } catch { json = undefined; }
    results[resumeState.llmStepId] = {
      id: resumeState.llmStepId,
      stdout: llmResponse,
      json,
    };
  }

  let lastStepId: string | null = null;

  for (let idx = startIndex; idx < steps.length; idx++) {
    const step = steps[idx];

    if (!evaluateCondition(step.when ?? step.condition, results)) {
      results[step.id] = { id: step.id, skipped: true };
      continue;
    }

    const stdinValue = resolveStdin(step.stdin, resolvedArgs, results);
    const env = mergeEnv(ctx.env, workflow.env, step.env, resolvedArgs, results);

    let stdout: string;
    let json: unknown;

    if (isPromptStep(step)) {
      const promptText = resolveTemplate(step.prompt!, resolvedArgs, results);
      const systemText = step.system
        ? resolveTemplate(step.system, resolvedArgs, results)
        : undefined;

      // Halt execution and delegate to the calling agent's LLM
      const contextText = stdinValue || undefined;

      const stateKey = await saveWorkflowResumeState(env as Record<string, string | undefined>, {
        filePath: resolvedFilePath,
        resumeAtIndex: idx + 1,
        steps: results,
        args: resolvedArgs,
        llmStepId: step.id,
        createdAt: new Date().toISOString(),
      });

      const resumeToken = encodeToken({
        protocolVersion: 1,
        v: 1,
        kind: 'workflow-file',
        stateKey,
      } satisfies WorkflowResumePayload);

      return {
        status: 'needs_llm',
        output: [],
        requiresLlm: {
          type: 'llm_request',
          prompt: promptText,
          system: systemText,
          context: contextText,
          resumeToken,
        },
      };
    } else {
      const command = resolveTemplate(step.command!, resolvedArgs, results);
      const cwd = resolveCwd(step.cwd ?? workflow.cwd, resolvedArgs);
      const shellResult = await runShellCommand({ command, stdin: stdinValue, env, cwd });
      stdout = shellResult.stdout;
      json = parseJson(stdout);
    }

    results[step.id] = { id: step.id, stdout, json };
    lastStepId = step.id;

    if (isApprovalStep(step.approval)) {
      const approval = extractApprovalRequest(step, results[step.id]);

      if (ctx.mode === 'tool' || !isInteractive(ctx.stdin)) {
        const stateKey = await saveWorkflowResumeState(ctx.env, {
          filePath: resolvedFilePath,
          resumeAtIndex: idx + 1,
          steps: results,
          args: resolvedArgs,
          approvalStepId: step.id,
          createdAt: new Date().toISOString(),
        });

        const resumeToken = encodeToken({
          protocolVersion: 1,
          v: 1,
          kind: 'workflow-file',
          stateKey,
        } satisfies WorkflowResumePayload);

        return {
          status: 'needs_approval',
          output: [],
          requiresApproval: {
            ...approval,
            resumeToken,
          },
        };
      }

      ctx.stdout.write(`${approval.prompt} [y/N] `);
      const answer = await readLine(ctx.stdin);
      if (!/^y(es)?$/i.test(String(answer).trim())) {
        throw new Error('Not approved');
      }
      results[step.id].approved = true;
    }
  }

  const output = lastStepId ? toOutputItems(results[lastStepId]) : [];
  return { status: 'ok', output };
}

export function decodeWorkflowResumePayload(payload: unknown): WorkflowResumePayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Partial<WorkflowResumePayload>;
  if (data.kind !== 'workflow-file') return null;
  if (data.protocolVersion !== 1 || data.v !== 1) throw new Error('Unsupported token version');
  if (data.stateKey && typeof data.stateKey === 'string') {
    return data as WorkflowResumePayload;
  }
  if (!data.filePath || typeof data.filePath !== 'string') throw new Error('Invalid workflow token');
  if (typeof data.resumeAtIndex !== 'number') throw new Error('Invalid workflow token');
  if (!data.steps || typeof data.steps !== 'object') throw new Error('Invalid workflow token');
  if (!data.args || typeof data.args !== 'object') throw new Error('Invalid workflow token');
  return data as WorkflowResumePayload;
}

async function saveWorkflowResumeState(env: Record<string, string | undefined>, state: WorkflowResumeState) {
  const stateKey = `workflow_resume_${randomUUID()}`;
  await writeStateJson({ env, key: stateKey, value: state });
  return stateKey;
}

async function loadWorkflowResumeState(env: Record<string, string | undefined>, stateKey: string) {
  const stored = await readStateJson({ env, key: stateKey });
  if (!stored || typeof stored !== 'object') {
    throw new Error('Workflow resume state not found');
  }
  const data = stored as Partial<WorkflowResumeState>;
  if (!data.filePath || typeof data.filePath !== 'string') throw new Error('Invalid workflow resume state');
  if (typeof data.resumeAtIndex !== 'number') throw new Error('Invalid workflow resume state');
  if (!data.steps || typeof data.steps !== 'object') throw new Error('Invalid workflow resume state');
  if (!data.args || typeof data.args !== 'object') throw new Error('Invalid workflow resume state');
  return data as WorkflowResumeState;
}

function mergeEnv(
  base: Record<string, string | undefined>,
  workflowEnv: WorkflowFile['env'],
  stepEnv: WorkflowStep['env'],
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
) {
  const env = { ...base } as Record<string, string | undefined>;
  const apply = (source?: Record<string, string>) => {
    if (!source) return;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') {
        env[key] = resolveTemplate(value, args, results);
      }
    }
  };
  apply(workflowEnv);
  apply(stepEnv);
  return env;
}

function resolveCwd(cwd: string | undefined, args: Record<string, unknown>) {
  if (!cwd) return undefined;
  return resolveArgsTemplate(cwd, args);
}

function resolveStdin(
  stdin: unknown,
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
) {
  if (stdin === null || stdin === undefined) return null;
  if (typeof stdin === 'string') {
    const ref = parseStepRef(stdin.trim());
    if (ref) return getStepRefValue(ref, results, true);
    return resolveTemplate(stdin, args, results);
  }
  return JSON.stringify(stdin);
}

function resolveTemplate(
  input: string,
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
) {
  const withArgs = resolveArgsTemplate(input, args);
  return resolveStepRefs(withArgs, results);
}

function resolveArgsTemplate(input: string, args: Record<string, unknown>) {
  return input.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    if (key in args) return String(args[key]);
    return match;
  });
}

function resolveStepRefs(input: string, results: Record<string, WorkflowStepResult>) {
  return input.replace(/\$([A-Za-z0-9_-]+)\.(stdout|json|approved)/g, (match, id, field) => {
    const step = results[id];
    if (!step) return match;
    if (field === 'stdout') return step.stdout ?? '';
    if (field === 'json') return step.json !== undefined ? JSON.stringify(step.json) : '';
    if (field === 'approved') return step.approved === true ? 'true' : 'false';
    return match;
  });
}

function parseStepRef(value: string) {
  const match = value.match(/^\$([A-Za-z0-9_-]+)\.(stdout|json)$/);
  if (!match) return null;
  return { id: match[1], field: match[2] as 'stdout' | 'json' };
}

function getStepRefValue(
  ref: { id: string; field: 'stdout' | 'json' },
  results: Record<string, WorkflowStepResult>,
  strict: boolean,
) {
  const step = results[ref.id];
  if (!step) {
    if (strict) throw new Error(`Unknown step reference: ${ref.id}.${ref.field}`);
    return '';
  }
  if (ref.field === 'stdout') return step.stdout ?? '';
  return step.json !== undefined ? JSON.stringify(step.json) : '';
}

function evaluateCondition(
  condition: unknown,
  results: Record<string, WorkflowStepResult>,
) {
  if (condition === undefined || condition === null) return true;
  if (typeof condition === 'boolean') return condition;
  if (typeof condition !== 'string') throw new Error('Unsupported condition type');

  const trimmed = condition.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  const match = trimmed.match(/^\$([A-Za-z0-9_-]+)\.(approved|skipped)$/);
  if (!match) throw new Error(`Unsupported condition: ${condition}`);

  const step = results[match[1]];
  if (!step) return false;

  return match[2] === 'approved' ? step.approved === true : step.skipped === true;
}

function isApprovalStep(approval: WorkflowStep['approval']) {
  if (approval === true) return true;
  if (typeof approval === 'string' && approval.toLowerCase() === 'required') return true;
  return false;
}

function extractApprovalRequest(step: WorkflowStep, result: WorkflowStepResult) {
  const fallbackPrompt = `Approve ${step.id}?`;
  const json = result.json;

  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const candidate = json as {
      requiresApproval?: { prompt?: string; items?: unknown[]; preview?: string };
      prompt?: string;
      items?: unknown[];
      preview?: string;
    };
    if (candidate.requiresApproval?.prompt) {
      return {
        type: 'approval_request' as const,
        prompt: candidate.requiresApproval.prompt,
        items: candidate.requiresApproval.items ?? [],
        ...(candidate.requiresApproval.preview ? { preview: candidate.requiresApproval.preview } : null),
      };
    }
    if (candidate.prompt) {
      return {
        type: 'approval_request' as const,
        prompt: candidate.prompt,
        items: candidate.items ?? [],
        ...(candidate.preview ? { preview: candidate.preview } : null),
      };
    }
  }

  return {
    type: 'approval_request' as const,
    prompt: fallbackPrompt,
    items: [],
    ...(result.stdout ? { preview: result.stdout.trim().slice(0, 2000) } : null),
  };
}

function parseJson(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function toOutputItems(result: WorkflowStepResult | undefined) {
  if (!result) return [];
  if (result.json !== undefined) {
    return Array.isArray(result.json) ? result.json : [result.json];
  }
  if (result.stdout !== undefined) {
    return result.stdout === '' ? [] : [result.stdout];
  }
  return [];
}

function cloneResults(results: Record<string, WorkflowStepResult>) {
  const out: Record<string, WorkflowStepResult> = {};
  for (const [key, value] of Object.entries(results)) {
    out[key] = { ...value };
  }
  return out;
}

function isInteractive(stdin: NodeJS.ReadableStream) {
  return Boolean((stdin as NodeJS.ReadStream).isTTY);
}

function readLine(stdin: NodeJS.ReadableStream) {
  return new Promise((resolve) => {
    let buf = '';

    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        stdin.off('data', onData);
        resolve(buf.slice(0, idx));
      }
    };

    stdin.on('data', onData);
  });
}

async function runShellCommand({
  command,
  stdin,
  env,
  cwd,
}: {
  command: string;
  stdin: string | null;
  env: Record<string, string | undefined>;
  cwd?: string;
}) {
  const { spawn } = await import('node:child_process');

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-lc', command], {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    if (typeof stdin === 'string') {
      child.stdin.setDefaultEncoding('utf8');
      child.stdin.write(stdin);
    }
    child.stdin.end();

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`workflow command failed (${code}): ${stderr.trim() || stdout.trim() || command}`));
    });
  });
}

function isPromptStep(step: { prompt?: string; command?: string }): boolean {
  return typeof step.prompt === 'string' && step.prompt.trim().length > 0 && !step.command;
}
