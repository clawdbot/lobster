type EmailLike = {
  id?: string;
  threadId?: string;
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  labels?: string[];
};

type NormalizedEmail = Required<Pick<EmailLike, 'id' | 'threadId' | 'from' | 'subject' | 'date' | 'snippet'>> & {
  labels: string[];
};

function normalizeEmail(raw: any): NormalizedEmail {
  const id = String(raw?.id ?? raw?.messageId ?? '').trim();
  const threadId = String(raw?.threadId ?? raw?.thread_id ?? id).trim();
  const from = String(raw?.from ?? raw?.sender ?? '').trim();
  const subject = String(raw?.subject ?? '').trim();
  const date = String(raw?.date ?? raw?.internalDate ?? raw?.timestamp ?? '').trim();
  const snippet = String(raw?.snippet ?? raw?.bodyPreview ?? '').trim();
  const labels = Array.isArray(raw?.labels) ? raw.labels.map((x: any) => String(x)) : [];

  return {
    id,
    threadId: threadId || id,
    from,
    subject,
    date,
    snippet,
    labels,
  };
}

function isLikelyNoReply(from: string) {
  const f = from.toLowerCase();
  return (
    f.includes('no-reply') ||
    f.includes('noreply') ||
    f.includes('do-not-reply') ||
    f.includes('donotreply')
  );
}

function extractEmailAddress(from: string): string {
  const m = String(from).match(/<([^>]+)>/);
  if (m?.[1]) return m[1].trim();
  // fallback: find first email-ish token
  const m2 = String(from).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return (m2?.[0] ?? '').trim();
}

function ensureRe(subject: string) {
  const s = String(subject ?? '').trim();
  if (!s) return 'Re:';
  return /^re:\s*/i.test(s) ? s : `Re: ${s}`;
}

type TriageCategory = 'needs_reply' | 'needs_action' | 'fyi';

type TriageDecision = {
  id: string;
  category: TriageCategory;
  rationale?: string;
  reply?: {
    subject?: string;
    body: string;
  };
};

type EmailTriageReport = {
  summary: string;
  buckets: {
    needsReply: string[];
    needsAction: string[];
    fyi: string[];
  };
  emails: NormalizedEmail[];
  decisions?: TriageDecision[];
  drafts?: { to: string; subject: string; body: string; emailId: string }[];
  mode: 'deterministic' | 'llm';
};

function buildDeterministicReport(emails: NormalizedEmail[]): EmailTriageReport {
  const buckets = {
    needsReply: [] as NormalizedEmail[],
    needsAction: [] as NormalizedEmail[],
    fyi: [] as NormalizedEmail[],
  };

  for (const e of emails) {
    const subjLower = e.subject.toLowerCase();
    const unread = e.labels.some((l) => l.toUpperCase() === 'UNREAD');

    if (subjLower.includes('action required') || subjLower.includes('urgent')) {
      buckets.needsAction.push(e);
      continue;
    }

    if (unread && !isLikelyNoReply(e.from)) {
      buckets.needsReply.push(e);
      continue;
    }

    buckets.fyi.push(e);
  }

  const summary = `${buckets.needsReply.length} need replies, ${buckets.needsAction.length} need action, ${buckets.fyi.length} FYI`;

  return {
    summary,
    buckets: {
      needsReply: buckets.needsReply.map((x) => x.id),
      needsAction: buckets.needsAction.map((x) => x.id),
      fyi: buckets.fyi.map((x) => x.id),
    },
    emails,
    mode: 'deterministic',
  };
}

function triagePrompt(emails: NormalizedEmail[]) {
  return (
    `You are an email triage assistant.\n` +
    `Given the following emails, return JSON that categorizes each email and (when category is needs_reply) drafts a short reply.\n` +
    `Guidelines:\n` +
    `- Keep replies concise, friendly, and professional.\n` +
    `- If sender appears to be automated (no-reply), do not draft a reply; categorize as fyi unless it is clearly urgent/actionable.\n` +
    `- Use one of categories: needs_reply, needs_action, fyi.\n` +
    `- The reply body should be plain text, no markdown.\n\n` +
    `Emails (JSON):\n` +
    JSON.stringify(
      emails.map((e) => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        date: e.date,
        snippet: e.snippet,
        labels: e.labels,
      })),
      null,
      2,
    )
  );
}

const TRIAGE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { type: 'string', enum: ['needs_reply', 'needs_action', 'fyi'] },
          rationale: { type: 'string' },
          reply: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              body: { type: 'string' },
            },
            required: ['body'],
            additionalProperties: false,
          },
        },
        required: ['id', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['decisions'],
  additionalProperties: false,
};

export const emailTriageCommand = {
  name: 'email.triage',
  meta: {
    description: 'Email triage (deterministic by default, optionally LLM-assisted via llm_task.invoke)',
    argsSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum items to consume from input stream', default: 20 },
        llm: { type: 'boolean', description: 'Use llm_task.invoke for categorization + draft replies (requires LLM_TASK_URL)' },
        model: { type: 'string', description: 'Model for llm_task.invoke (required when --llm true)' },
        url: { type: 'string', description: 'llm-task base URL (or LLM_TASK_URL)' },
        token: { type: 'string', description: 'Bearer token (or LLM_TASK_TOKEN)' },
        temperature: { type: 'number', description: 'LLM temperature' },
        'max-output-tokens': { type: 'number', description: 'Max completion tokens' },
        emit: { type: 'string', description: "Output mode: 'report' (default) or 'drafts'", default: 'report' },
        'state-key': { type: 'string', description: 'Run-state key forwarded to llm_task.invoke' },
        _: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
    sideEffects: [],
  },
  help() {
    return (
      `email.triage — categorize emails and draft replies (optional LLM)\n\n` +
      `Usage (deterministic):\n` +
      `  gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage\n\n` +
      `Usage (LLM-assisted drafts):\n` +
      `  gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage --llm --model <model>\n\n` +
      `Send drafts (requires approval):\n` +
      `  ... | email.triage --llm --model <model> --emit drafts | approve --prompt 'Send replies?' | gog.gmail.send\n\n` +
      `Notes:\n` +
      `  - Read-only by default: does not send anything.\n` +
      `  - LLM mode uses llm_task.invoke (and its cache/resume semantics).\n`
    );
  },
  async run({ input, args, ctx }) {
    const limit = Number(args.limit ?? 20);
    const emit = String(args.emit ?? 'report').trim() || 'report';

    const emails: NormalizedEmail[] = [];
    for await (const item of input) {
      emails.push(normalizeEmail(item));
      if (emails.length >= limit) break;
    }

    const wantLlm = Boolean(args.llm ?? false);
    const env = ctx?.env ?? process.env;
    const hasClawdUrl = Boolean(String(env.CLAWD_URL ?? '').trim());

    if (!wantLlm || !hasClawdUrl) {
      const report = buildDeterministicReport(emails);
      if (emit === 'drafts') {
        return { output: streamOf([]) };
      }
      return { output: streamOf([report]) };
    }

    const model = String(args.model ?? '').trim();
    // Model is optional when running under OpenClaw (llm_task.invoke will use OpenClaw defaults).

    if (!ctx?.registry) throw new Error('email.triage (LLM mode) requires ctx.registry');
    const llmCmd = ctx.registry.get('llm_task.invoke');
    if (!llmCmd) throw new Error('email.triage requires llm_task.invoke to be registered');

    const llmRes = await llmCmd.run({
      input: streamOf(emails),
      args: {
        _: [],
        url: args.url,
        token: args.token,
        ...(model ? { model } : null),
        prompt: triagePrompt(emails),
        'output-schema': JSON.stringify(TRIAGE_OUTPUT_SCHEMA),
        'schema-version': 'email_triage.v1',
        temperature: args.temperature,
        'max-output-tokens': args['max-output-tokens'],
        'state-key': args['state-key'] ?? env.LOBSTER_RUN_STATE_KEY,
      },
      ctx,
    } as any);

    const llmItems: any[] = [];
    for await (const it of llmRes.output) llmItems.push(it);
    const first = llmItems[0];
    const data = first?.output?.data;
    const decisionsRaw = Array.isArray(data?.decisions) ? data.decisions : [];
    const decisions: TriageDecision[] = decisionsRaw.map((d: any) => ({
      id: String(d?.id ?? '').trim(),
      category: String(d?.category ?? 'fyi') as TriageCategory,
      rationale: d?.rationale ? String(d.rationale) : undefined,
      reply: d?.reply && typeof d.reply === 'object' ? { subject: d.reply.subject, body: String(d.reply.body ?? '') } : undefined,
    })).filter((d: any) => d.id);

    const byId = new Map(emails.map((e) => [e.id, e] as const));
    const buckets = {
      needsReply: [] as string[],
      needsAction: [] as string[],
      fyi: [] as string[],
    };

    const drafts: { to: string; subject: string; body: string; emailId: string }[] = [];

    for (const d of decisions) {
      if (d.category === 'needs_reply') buckets.needsReply.push(d.id);
      else if (d.category === 'needs_action') buckets.needsAction.push(d.id);
      else buckets.fyi.push(d.id);

      if (d.category === 'needs_reply' && d.reply?.body) {
        const email = byId.get(d.id);
        const to = email ? extractEmailAddress(email.from) : '';
        if (to && !isLikelyNoReply(email?.from ?? '')) {
          drafts.push({
            emailId: d.id,
            to,
            subject: d.reply.subject ? String(d.reply.subject) : ensureRe(email?.subject ?? ''),
            body: String(d.reply.body),
          });
        }
      }
    }

    const summary = `${buckets.needsReply.length} need replies, ${buckets.needsAction.length} need action, ${buckets.fyi.length} FYI`;

    if (emit === 'drafts') {
      return {
        output: (async function* () {
          for (const d of drafts) {
            // gog.gmail.send expects: {to, subject, body}
            yield { to: d.to, subject: d.subject, body: d.body, emailId: d.emailId };
          }
        })(),
      };
    }

    const report: EmailTriageReport = {
      summary,
      buckets,
      emails,
      decisions,
      drafts,
      mode: 'llm',
    };

    return { output: streamOf([report]) };
  },
};

async function* streamOf(items: any[]) {
  for (const item of items) yield item;
}
