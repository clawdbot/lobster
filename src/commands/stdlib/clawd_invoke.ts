export const clawdInvokeCommand = {
  name: 'clawd.invoke',
  meta: {
    description: 'Call a local OpenClaw tool endpoint',
    argsSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'OpenClaw control URL (or CLAWD_URL)' },
        token: { type: 'string', description: 'Bearer token (or CLAWD_TOKEN)' },
        tool: { type: 'string', description: 'Tool name (e.g. message, cron, github, etc.)' },
        action: { type: 'string', description: 'Tool action' },
        'args-json': { type: 'string', description: 'JSON string of tool args' },
        sessionKey: { type: 'string', description: 'Optional session key attribution' },
        'session-key': { type: 'string', description: 'Alias for sessionKey' },
        dryRun: { type: 'boolean', description: 'Dry run' },
        'dry-run': { type: 'boolean', description: 'Alias for dryRun' },
        _: { type: 'array', items: { type: 'string' } },
      },
      required: ['tool', 'action'],
    },
    sideEffects: ['calls_clawd_tool'],
  },
  help() {
    return `clawd.invoke — call a local OpenClaw tool endpoint\n\n` +
      `Usage:\n` +
      `  clawd.invoke --tool message --action send --args-json '{"provider":"telegram","to":"...","message":"..."}'\n` +
      `  clawd.invoke --tool message --action send --args-json '{...}' --dry-run\n` +
      `  ... | clawd.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'\n\n` +
      `Config:\n` +
      `  - Uses CLAWD_URL env var by default (or pass --url).\n` +
      `  - Optional Bearer token via CLAWD_TOKEN env var (or pass --token).\n` +
      `  - Optional attribution via --session-key <sessionKey>.\n\n` +
      `Notes:\n` +
      `  - This is a thin transport bridge. Lobster should not own OAuth/secrets.\n`;
  },
  async run({ input, args, ctx }) {
    const each = Boolean(args.each);
    const itemKey = String(args.itemKey ?? args['item-key'] ?? 'item');

    const url = String(args.url ?? ctx.env.CLAWD_URL ?? '').trim();
    if (!url) throw new Error('clawd.invoke requires --url or CLAWD_URL');

    const tool = args.tool;
    const action = args.action;
    if (!tool || !action) throw new Error('clawd.invoke requires --tool and --action');

    const token = String(args.token ?? ctx.env.CLAWD_TOKEN ?? '').trim();

    let toolArgs = {};
    if (args['args-json']) {
      try {
        toolArgs = JSON.parse(String(args['args-json']));
      } catch (_err) {
        throw new Error('clawd.invoke --args-json must be valid JSON');
      }
    }

    if (each && (toolArgs === null || typeof toolArgs !== 'object' || Array.isArray(toolArgs))) {
      throw new Error('clawd.invoke --each requires --args-json to be an object');
    }

    const endpoint = new URL('/tools/invoke', url);
    const sessionKey = args.sessionKey ?? args['session-key'] ?? null;
    const dryRun = args.dryRun ?? args['dry-run'] ?? null;

    const invokeOnce = async (argsValue) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : null),
        },
        body: JSON.stringify({
          tool: String(tool),
          action: String(action),
          args: argsValue,
          ...(sessionKey ? { sessionKey: String(sessionKey) } : null),
          ...(dryRun !== null ? { dryRun: Boolean(dryRun) } : null),
        }),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`clawd.invoke failed (${res.status}): ${text.slice(0, 400)}`);
      }

      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (_err) {
        throw new Error('clawd.invoke expected JSON response');
      }

      // Preferred: { ok: true, result: ... }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'ok' in parsed) {
        if (parsed.ok !== true) {
          const msg = parsed?.error?.message ?? 'Unknown error';
          throw new Error(`clawd.invoke tool error: ${msg}`);
        }
        const result = parsed.result;
        return Array.isArray(result) ? result : [result];
      }

      // Compatibility: raw JSON result
      return Array.isArray(parsed) ? parsed : [parsed];
    };

    if (!each) {
      // Drain input: for now we don't stream input into clawd calls.
      for await (const _item of input) {
        // no-op
      }
      const items = await invokeOnce(toolArgs);
      return { output: asStream(items) };
    }

    return {
      output: (async function* () {
        for await (const item of input) {
          const argsValue = { ...toolArgs, [itemKey]: item };
          const items = await invokeOnce(argsValue);
          for (const outputItem of items) yield outputItem;
        }
      })(),
    };
  },
};

async function* asStream(items) {
  for (const item of items) yield item;
}
