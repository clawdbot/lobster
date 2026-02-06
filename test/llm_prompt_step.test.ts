import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runWorkflowFile } from '../src/workflows/file.js';
import { decodeResumeToken, parseResumeArgs } from '../src/resume.js';

// ---------- validation ----------

test('validation allows step with prompt only', async () => {
  const workflow = {
    name: 'valid-prompt',
    steps: [{ id: 'ask', prompt: 'Hello?' }],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-valid-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  // Should not throw — prompt-only steps are valid
  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: 'tool',
    },
  });

  assert.equal(result.status, 'needs_llm');
});

test('validation rejects step with both command and prompt', async () => {
  const workflow = {
    name: 'invalid',
    steps: [{ id: 'bad', command: 'echo hi', prompt: 'also this' }],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-invalid-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env: { ...process.env, LOBSTER_STATE_DIR: path.join(tmpDir, 'state') },
          mode: 'tool',
        },
      }),
    /cannot have both command and prompt/,
  );
});

test('validation rejects step with neither command nor prompt', async () => {
  const workflow = {
    name: 'invalid',
    steps: [{ id: 'empty' }],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-neither-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env: { ...process.env, LOBSTER_STATE_DIR: path.join(tmpDir, 'state') },
          mode: 'tool',
        },
      }),
    /requires a command or prompt/,
  );
});

// ---------- prompt step halts and returns needs_llm ----------

test('prompt step halts with needs_llm and returns prompt + context', async () => {
  const workflow = {
    name: 'host-test',
    steps: [
      {
        id: 'data',
        command: 'echo "some raw data from search"',
      },
      {
        id: 'summarize',
        prompt: 'Summarize this data.',
        system: 'You are helpful.',
        stdin: '$data.stdout',
      },
      {
        id: 'output',
        command: 'echo "after llm: $summarize.stdout"',
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-host-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };

  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: 'tool',
    },
  });

  // Should halt at the prompt step
  assert.equal(first.status, 'needs_llm');
  assert.ok(first.requiresLlm);
  assert.equal(first.requiresLlm.type, 'llm_request');
  assert.equal(first.requiresLlm.prompt, 'Summarize this data.');
  assert.equal(first.requiresLlm.system, 'You are helpful.');
  assert.ok(first.requiresLlm.context?.includes('some raw data'));
  assert.ok(first.requiresLlm.resumeToken);
});

// ---------- resume with llm response ----------

test('resume with llm response continues workflow to completion', async () => {
  const workflow = {
    name: 'resume-test',
    steps: [
      {
        id: 'data',
        command: 'echo "raw input"',
      },
      {
        id: 'summarize',
        prompt: 'Summarize this.',
        stdin: '$data.stdout',
      },
      {
        id: 'output',
        command: `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({summary:d.trim()})))"`,
        stdin: '$summarize.stdout',
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-resume-llm-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };

  // First run — halts at prompt step
  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: 'tool',
    },
  });

  assert.equal(first.status, 'needs_llm');
  const payload = decodeResumeToken(first.requiresLlm!.resumeToken);
  assert.equal(payload.kind, 'workflow-file');

  // Resume with the LLM response
  const second = await runWorkflowFile({
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: 'tool',
    },
    resume: payload,
    llmResponse: 'Here is the summary from the host LLM.',
  });

  assert.equal(second.status, 'ok');
  assert.ok(second.output.length > 0);
  const outputText = JSON.stringify(second.output[0]);
  assert.ok(outputText.includes('Here is the summary from the host LLM'));
});

// ---------- prompt step with args and step refs ----------

test('prompt resolves args and step refs in template', async () => {
  const workflow = {
    name: 'template-test',
    args: {
      topic: { default: 'AI safety' },
    },
    steps: [
      {
        id: 'ask',
        prompt: 'Tell me about ${topic}.',
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-template-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: 'tool',
    },
  });

  assert.equal(result.status, 'needs_llm');
  assert.equal(result.requiresLlm!.prompt, 'Tell me about AI safety.');
});

// ---------- multiple prompt steps resume sequentially ----------

test('workflow with two prompt steps resumes through both', async () => {
  const workflow = {
    name: 'multi-prompt',
    steps: [
      { id: 'data', command: 'echo "raw data"' },
      { id: 'step1', prompt: 'First analysis.', stdin: '$data.stdout' },
      { id: 'step2', prompt: 'Second analysis.', stdin: '$step1.stdout' },
      { id: 'done', command: 'echo "final: $step2.stdout"' },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-multi-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
  const ctx = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env, mode: 'tool' as const };

  // First halt — step1
  const r1 = await runWorkflowFile({ filePath, ctx });
  assert.equal(r1.status, 'needs_llm');
  assert.equal(r1.requiresLlm!.prompt, 'First analysis.');

  // Resume step1 — should halt at step2
  const p1 = decodeResumeToken(r1.requiresLlm!.resumeToken);
  const r2 = await runWorkflowFile({ ctx, resume: p1, llmResponse: 'First result.' });
  assert.equal(r2.status, 'needs_llm');
  assert.equal(r2.requiresLlm!.prompt, 'Second analysis.');
  assert.ok(r2.requiresLlm!.context?.includes('First result'));

  // Resume step2 — should complete
  const p2 = decodeResumeToken(r2.requiresLlm!.resumeToken);
  const r3 = await runWorkflowFile({ ctx, resume: p2, llmResponse: 'Final insight.' });
  assert.equal(r3.status, 'ok');
  assert.ok(String(r3.output[0]).includes('Final insight'));
});

// ---------- parseResumeArgs edge cases ----------

test('parseResumeArgs rejects --llm-response with no value', () => {
  assert.throws(
    () => parseResumeArgs(['--token', 'abc', '--llm-response']),
    /--llm-response requires a value/,
  );
});

test('parseResumeArgs rejects empty --llm-response', () => {
  assert.throws(
    () => parseResumeArgs(['--token', 'abc', '--llm-response', '']),
    /--llm-response cannot be empty/,
  );
});

test('parseResumeArgs rejects whitespace-only --llm-response', () => {
  assert.throws(
    () => parseResumeArgs(['--token', 'abc', '--llm-response', '   ']),
    /--llm-response cannot be empty/,
  );
});

test('parseResumeArgs accepts --llm-response=value form', () => {
  const result = parseResumeArgs(['--token', 'abc', '--llm-response=hello world']);
  assert.equal(result.token, 'abc');
  assert.equal(result.approved, true);
  assert.equal(result.llmResponse, 'hello world');
});
