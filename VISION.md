# Lobster: Vision & Value Proposition

## One-liner

**Lobster is safe automation for OpenClaw — workflows that ask before acting.**

---

## What is Lobster?

Lobster is a workflow runtime for OpenClaw. It lets you define multi-step automations that:

- Run deterministically (no LLM re-planning each step)
- Halt at checkpoints and ask for approval before side effects
- Resume exactly where they left off
- Remember what they've already processed

Think of it as **IFTTT/Zapier for OpenClaw, but with human checkpoints**.

---

## The Problem Lobster Solves

### Today's workflow in OpenClaw

```
User: "Check my email, draft replies to anything urgent, and send them"

What happens:
1. LLM plans: "I should search emails first"
2. Tool call: gmail.search
3. LLM interprets results, plans next step
4. Tool call: gmail.get (for each email)
5. LLM drafts replies
6. LLM decides to send
7. Tool call: gmail.send
... repeat for each email
```

**Problems:**
- Many tool calls = many tokens = expensive
- LLM decides when to send = risky (what if it misunderstands?)
- No memory = tomorrow it re-triages the same emails
- Not repeatable = you can't save this as an automation

### With Lobster

```
OpenClaw calls: lobster.run("email.triage")

What happens:
1. Lobster fetches emails (deterministic)
2. Lobster classifies them (rule-based)
3. Lobster drafts replies (optional LLM step)
4. Lobster HALTS: "Send 3 drafts? [approve/reject]"
5. User approves
6. Lobster sends

Tomorrow: Lobster remembers cursor, only processes new emails
```

**One call. Deterministic. Safe. Stateful.**

---

## Why Lobster Makes OpenClaw Better

| Without Lobster | With Lobster |
|-----------------|--------------|
| LLM orchestrates every step | Deterministic pipeline, LLM only for judgment |
| 10+ tool calls per workflow | 1 call to Lobster |
| "Don't send until I confirm" (hope it listens) | `approve` halts execution until explicit resume |
| Forgets what it did yesterday | Stateful — tracks cursors/checkpoints |
| Hard to share automations | Workflows are code — shareable, versionable |

### Token savings (real)
A 10-step workflow today might cost 10 tool calls × LLM planning overhead.
With Lobster: 1 tool call + compact structured output.

### Safety (the killer feature)
The `approve` primitive isn't a prompt hint — it's a **hard stop**. The workflow literally cannot continue until you resume it. No "oops, it sent 50 emails."

### Memory (underrated)
Workflows can persist state: "last processed email ID", "last PR SHA seen", etc. Tomorrow's run picks up where yesterday left off.

---

## How Lobster Fits with OpenClaw

```
┌─────────────────────────────────────────────────┐
│                   User                          │
│         "triage my email daily"                 │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│                 OpenClaw                        │
│   - Understands intent                          │
│   - Chooses appropriate tool/workflow           │
│   - Presents results and approval prompts       │
└─────────────────────┬───────────────────────────┘
                      │ lobster.run("email.triage")
                      ▼
┌─────────────────────────────────────────────────┐
│                  Lobster                        │
│   - Executes deterministic pipeline             │
│   - Calls OpenClaw tools (gmail, trello, etc)   │
│   - Halts at approval checkpoints               │
│   - Returns structured result + resume token    │
└─────────────────────────────────────────────────┘
```

**Key insight:** Lobster doesn't replace OpenClaw. It's the execution layer that makes OpenClaw's automations safe and efficient.

- **OpenClaw** = the brain (understands what you want)
- **Lobster** = the hands (executes workflows safely)
- **Tools/Skills** = the capabilities (gmail, trello, github, etc.)

---

## Who Should Use Lobster?

### Average OpenClaw users (invisible benefit)
They don't need to know Lobster exists. They just notice:
- "Set up daily email triage" works better
- Automations ask before sending/posting
- Things don't get re-processed every day

### Power users / tinkerers
They can:
- Customize workflows ("I want triage to also create Trello cards")
- Write new workflows for their specific needs
- Share workflows with the community

### The OpenClaw ecosystem
- Workflow recipes become a new category of shareable assets
- Skills stay simple (just expose APIs)
- Lobster handles the orchestration layer

---

## Analogies That Work

| If you know... | Lobster is like... |
|----------------|-------------------|
| IFTTT/Zapier | Multi-step version with approval checkpoints |
| GitHub Actions | But for personal automation, not CI/CD |
| AWS Step Functions | But local-first and human-in-the-loop |
| Unix pipes | But for JSON objects, not text bytes |
| Temporal | But 80/20 version for personal workflows |

**Best analogy for most people:**
> "Lobster is Zapier for OpenClaw, except it asks you before doing anything irreversible."

---

## Why Not Build This Into OpenClaw Core?

It could be. But the plugin architecture is intentional:

1. **Core stays small** — OpenClaw is already complex
2. **Faster iteration** — Lobster can evolve without core releases
3. **Opt-in** — Not everyone needs workflow automation
4. **Community** — Easier to contribute workflows than core changes
5. **Ecosystem proof** — If plugins work for Lobster, they work for other capabilities

Pete (OpenClaw creator, formerly Clawdbot) explicitly built the plugin boundary to enable this pattern. Lobster is the first proof that it works.

---

## Example Workflows

### Email triage (flagship)
```
gog.gmail.search --query "newer_than:1d" 
  | email.normalize 
  | email.classify 
  | where bucket==needs_reply 
  | draft.reply 
  | approve --prompt "Send N replies?" 
  | gog.gmail.send
```

### PR monitor
```
github.pr.get --repo org/repo --pr 123
  | diff.last
  | where changed==true
  | notify --channel telegram --message "PR updated: {summary}"
```

### Daily planning
```
calendar.today
  | join tasks.today
  | prioritize
  | format.plan
  | approve --prompt "Post to #daily?"
  | message.send --channel slack --to "#daily"
```

### Inbox → Trello
```
email.triage
  | where bucket==needs_action
  | to.trelloCard
  | approve --prompt "Create N cards?"
  | trello.card.create --list "Inbox"
```

---

## The USP (Unique Selling Proposition)

**"Automations that ask before acting."**

Other automation tools either:
- Run blindly (IFTTT, Zapier) — scary for important actions
- Require complex configuration for approvals
- Don't integrate with your AI assistant

Lobster is:
- Native to OpenClaw (uses the same tools you already have)
- Safe by default (approvals are a language primitive)
- Invisible when you want (OpenClaw uses it automatically)
- Customizable when you need (write your own workflows)

---

## What Lobster Is NOT

- **Not a terminal replacement** — You don't switch your shell to Lobster
- **Not a general programming language** — It's for workflows, not apps
- **Not trying to replace OpenClaw** — It makes OpenClaw better
- **Not managing your secrets** — OpenClaw handles auth, Lobster orchestrates

---

## Summary

| Question | Answer |
|----------|--------|
| What is it? | Workflow runtime for OpenClaw |
| One-liner? | Safe automation — workflows that ask before acting |
| Why use it? | Cheaper, safer, stateful automations |
| Who uses it? | Everyone (invisibly) or power users (directly) |
| Why not in core? | Plugin architecture — core stays small, capabilities are extensions |
| Best analogy? | Zapier for OpenClaw, but with approval checkpoints |
