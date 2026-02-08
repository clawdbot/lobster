import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runWorkflowFile } from '../src/workflows/file.js';

async function runSimpleWorkflow(workflow: object, extraEnv?: Record<string, string>) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-env-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir, ...extraEnv };

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: 'tool',
    },
  });

  return result;
}

test('env var substitution resolves from process.env', async () => {
  const workflow = {
    name: 'env-from-process',
    env: { MY_TEST_VAR: '${MY_TEST_VAR}' },
    steps: [
      {
        id: 'check',
        command: 'node -e "process.stdout.write(process.env.MY_TEST_VAR || \'missing\')"',
      },
    ],
  };

  const result = await runSimpleWorkflow(workflow, { MY_TEST_VAR: 'hello' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['hello']);
});

test('workflow-level env overrides parent env', async () => {
  const workflow = {
    name: 'workflow-override',
    env: { MY_VAR: 'workflow' },
    steps: [
      {
        id: 'check',
        command: 'node -e "process.stdout.write(process.env.MY_VAR)"',
      },
    ],
  };

  const result = await runSimpleWorkflow(workflow, { MY_VAR: 'parent' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['workflow']);
});

test('step-level env overrides workflow-level env', async () => {
  const workflow = {
    name: 'step-override',
    env: { MY_VAR: 'workflow' },
    steps: [
      {
        id: 'check',
        command: 'node -e "process.stdout.write(process.env.MY_VAR)"',
        env: { MY_VAR: 'step' },
      },
    ],
  };

  const result = await runSimpleWorkflow(workflow);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['step']);
});

test('args take precedence over env in template substitution', async () => {
  const workflow = {
    name: 'args-precedence',
    args: { NAME: { default: 'arg-value' } },
    env: { NAME: '${NAME}' },
    steps: [
      {
        id: 'check',
        command: 'node -e "process.stdout.write(process.env.NAME)"',
      },
    ],
  };

  const result = await runSimpleWorkflow(workflow, { NAME: 'env-value' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['arg-value']);
});

test('env vars resolve in command templates', async () => {
  const workflow = {
    name: 'command-template-env',
    steps: [
      {
        id: 'check',
        command: 'node -e "process.stdout.write(\'${CMD_VAR}\')"',
      },
    ],
  };

  const result = await runSimpleWorkflow(workflow, { CMD_VAR: 'resolved' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['resolved']);
});

test('relative cwd resolves from workflow file directory', async () => {
  // Use realpath to resolve macOS /var -> /private/var symlink
  const tmpDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-cwd-')));
  const scriptsDir = path.join(tmpDir, 'scripts');
  await fsp.mkdir(scriptsDir, { recursive: true });

  const workflow = {
    name: 'relative-cwd',
    cwd: './scripts',
    steps: [
      {
        id: 'check',
        command: 'node -e "process.stdout.write(process.cwd())"',
      },
    ],
  };

  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const stateDir = path.join(tmpDir, 'state');
  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: 'tool',
    },
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [scriptsDir]);
});
