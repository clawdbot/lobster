export const workflowRegistry = {
  'github.pr.monitor': {
    name: 'github.pr.monitor',
    description: 'Fetch PR state via gh, diff against last run, emit only on change.',
    argsSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/repo (e.g. openclaw/openclaw)' },
        pr: { type: 'number', description: 'Pull request number' },
        key: { type: 'string', description: 'Optional state key override.' },
        changesOnly: { type: 'boolean', description: 'If true, suppress output when unchanged.' },
        summaryOnly: { type: 'boolean', description: 'If true, return only a compact change summary (smaller output).' },
      },
      required: ['repo', 'pr'],
    },
    examples: [
      {
        args: { repo: 'openclaw/openclaw', pr: 1152 },
        description: 'Monitor a PR and report when it changes.',
      },
    ],
    sideEffects: [],
  },
  'github.pr.monitor.notify': {
    name: 'github.pr.monitor.notify',
    description: 'Monitor a PR and emit a single human-friendly message when it changes.',
    argsSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/repo (e.g. openclaw/openclaw)' },
        pr: { type: 'number', description: 'Pull request number' },
        key: { type: 'string', description: 'Optional state key override.' },
      },
      required: ['repo', 'pr'],
    },
    examples: [
      {
        args: { repo: 'openclaw/openclaw', pr: 1152 },
        description: 'Emit "PR updated" message only when changed.',
      },
    ],
    sideEffects: [],
  },
};

export function listWorkflows() {
  return Object.values(workflowRegistry).map((w) => ({
    name: w.name,
    description: w.description,
    argsSchema: w.argsSchema,
    examples: w.examples,
    sideEffects: w.sideEffects,
  }));
}
