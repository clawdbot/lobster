function getByPath(obj: any, path: string): any {
  if (path === '.' || path === 'this') return obj;
  const parts = path.split('.').filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function renderTemplate(tpl: string, ctx: any): string {
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr) => {
    const key = String(expr ?? '').trim();
    const val = getByPath(ctx, key);
    if (val === undefined || val === null) return '';
    if (typeof val === 'string') return val;
    return JSON.stringify(val);
  });
}

function parseAssignments(tokens: any[]): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const tok of tokens ?? []) {
    const s = String(tok);
    const idx = s.indexOf('=');
    if (idx === -1) continue;
    const key = s.slice(0, idx).trim();
    const value = s.slice(idx + 1);
    if (!key) continue;
    out.push({ key, value });
  }
  return out;
}

export const mapCommand = {
  name: 'map',
  meta: {
    description: 'Transform items (wrap/unwrap/add fields)',
    argsSchema: {
      type: 'object',
      properties: {
        wrap: { type: 'string', description: 'Wrap each item as {wrap: item}' },
        unwrap: { type: 'string', description: 'Unwrap a field (yield item[unwrap])' },
        _: { type: 'array', items: { type: 'string' }, description: 'Optional assignments like key=value (value supports {{path}})' },
      },
      required: [],
    },
    sideEffects: [],
  },
  help() {
    return (
      `map — transform items\n\n` +
      `Usage:\n` +
      `  ... | map --wrap item\n` +
      `  ... | map --unwrap item\n` +
      `  ... | map foo=bar id={{id}}\n\n` +
      `Notes:\n` +
      `  - Assignments are added to an object item (preserves existing fields).\n` +
      `  - Assignment values support template placeholders like {{id}} and {{nested.field}}.\n`
    );
  },
  async run({ input, args }: any) {
    const wrap = typeof args.wrap === 'string' ? args.wrap : undefined;
    const unwrap = typeof args.unwrap === 'string' ? args.unwrap : undefined;
    const assignments = parseAssignments(Array.isArray(args._) ? args._ : []);

    if (wrap && unwrap) throw new Error('map cannot use both --wrap and --unwrap');

    return {
      output: (async function* () {
        for await (const item of input) {
          let cur: any = item;

          if (unwrap) {
            if (cur && typeof cur === 'object') cur = cur[unwrap];
            else cur = undefined;
            yield cur;
            continue;
          }

          if (wrap) {
            cur = { [wrap]: cur };
          }

          if (assignments.length > 0) {
            if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
              // If current is not an object, turn it into one so we can attach fields.
              cur = { value: cur };
            }
            for (const { key, value } of assignments) {
              cur[key] = renderTemplate(String(value), item);
            }
          }

          yield cur;
        }
      })(),
    };
  },
};
