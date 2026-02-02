import type { CommandMeta, LobsterCommand } from './types.js';

function parseDescriptionFromHelp(helpText: string): string {
  const firstLine = helpText.split('\n').find((l) => l.trim().length > 0) ?? '';
  // Expected pattern: "name — description" but fall back to the line as-is.
  return firstLine.includes('—') ? firstLine.split('—').slice(1).join('—').trim() : firstLine.trim();
}

export const commandsListCommand: LobsterCommand = {
  name: 'commands.list',
  help() {
    return (
      `commands.list — list available Lobster pipeline commands\n\n` +
      `Usage:\n` +
      `  commands.list\n\n` +
      `Notes:\n` +
      `  - Intended for agents (e.g. OpenClaw) to discover available pipeline stages dynamically.\n` +
      `  - Output includes name/description plus optional metadata (argsSchema/examples/sideEffects) when provided by commands.\n`
    );
  },
  meta: {
    description: 'List available Lobster pipeline commands',
    argsSchema: { type: 'object', properties: {}, required: [] },
    sideEffects: [],
  } satisfies CommandMeta,
  async run({ input, ctx }) {
    // Drain input
    for await (const _ of input) {
      // no-op
    }

    const names = ctx.registry.list();
    const output = names.map((name) => {
      const cmd = ctx.registry.get(name) as LobsterCommand | undefined;
      const help = typeof cmd?.help === 'function' ? String(cmd.help()) : '';
      const description = cmd?.meta?.description ?? parseDescriptionFromHelp(help);

      return {
        name,
        description,
        argsSchema: cmd?.meta?.argsSchema ?? null,
        examples: cmd?.meta?.examples ?? null,
        sideEffects: cmd?.meta?.sideEffects ?? null,
      };
    });

    return {
      output: (async function* () {
        for (const item of output) yield item;
      })(),
    };
  },
};
