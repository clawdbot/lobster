import { execCommand } from "./stdlib/exec.js";
import { headCommand } from "./stdlib/head.js";
import { jsonCommand } from "./stdlib/json.js";
import { pickCommand } from "./stdlib/pick.js";
import { tableCommand } from "./stdlib/table.js";
import { whereCommand } from "./stdlib/where.js";
import { sortCommand } from "./stdlib/sort.js";
import { dedupeCommand } from "./stdlib/dedupe.js";
import { templateCommand } from "./stdlib/template.js";
import { mapCommand } from "./stdlib/map.js";
import { approveCommand } from "./stdlib/approve.js";
import { clawdInvokeCommand } from "./stdlib/clawd_invoke.js";
import { stateGetCommand, stateSetCommand } from "./stdlib/state.js";
import { diffLastCommand } from "./stdlib/diff_last.js";
import { workflowsListCommand } from "./workflows/workflows_list.js";
import { workflowsRunCommand } from "./workflows/workflows_run.js";
import { commandsListCommand } from "./commands_list.js";
import { gogGmailSearchCommand } from "./stdlib/gog_gmail_search.js";
import { gogGmailSendCommand } from "./stdlib/gog_gmail_send.js";
import { emailTriageCommand } from "./stdlib/email_triage.js";

export function createDefaultRegistry() {
  const commands = new Map();

  for (const cmd of [
    execCommand,
    headCommand,
    jsonCommand,
    pickCommand,
    tableCommand,
    whereCommand,
    sortCommand,
    dedupeCommand,
    templateCommand,
    mapCommand,
    approveCommand,
    clawdInvokeCommand,
    stateGetCommand,
    stateSetCommand,
    diffLastCommand,
    workflowsListCommand,
    workflowsRunCommand,
    commandsListCommand,
    gogGmailSearchCommand,
    gogGmailSendCommand,
    emailTriageCommand,
  ]) {
    commands.set(cmd.name, cmd);
  }

  return {
    get(name) {
      return commands.get(name);
    },
    list() {
      return [...commands.keys()].sort();
    },
  };
}
