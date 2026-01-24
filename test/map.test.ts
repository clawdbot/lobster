import test from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline } from '../src/runtime.js';
import { createDefaultRegistry } from '../src/commands/registry.js';
import { parsePipeline } from '../src/parser.js';

async function run(pipelineText: string, input: any[]) {
  const pipeline = parsePipeline(pipelineText);
  const registry = createDefaultRegistry();
  const res = await runPipeline({
    pipeline,
    registry,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: 'tool',
    input: (async function* () { for (const x of input) yield x; })(),
  });
  return res.items;
}

test('map --wrap wraps items', async () => {
  const out = await run('map --wrap item', [1, 2]);
  assert.deepEqual(out, [{ item: 1 }, { item: 2 }]);
});

test('map --unwrap unwraps fields', async () => {
  const out = await run('map --unwrap x', [{ x: 1 }, { x: 2 }]);
  assert.deepEqual(out, [1, 2]);
});

test('map adds fields via assignments with template values', async () => {
  const out = await run('map kind=pr id={{id}}', [{ id: 123, title: 't' }]);
  // assignment overwrites existing id with rendered string
  assert.deepEqual(out, [{ id: '123', title: 't', kind: 'pr' }]);
});

test('map converts non-object items to {value: item} when adding fields', async () => {
  const out = await run('map kind=num', [5]);
  assert.deepEqual(out, [{ value: 5, kind: 'num' }]);
});
