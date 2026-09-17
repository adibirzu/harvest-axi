import { runAxiCli } from "axi-sdk-js";
import {
  captureCommand,
  distillCommand,
  listCommand,
  recordCommand,
  statusCommand,
} from "./commands.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Task landings into a durable solution ledger, then deterministic distillation into staged knowledge candidates.";

export const TOP_HELP = `usage: harvest-axi [command] [flags]
commands[5]:
  (none)=status, capture, record, list, distill
flags[6]:
  --home <path>, --ledger <path>, --queue <path>, --record-json <json>, --extract <none|pi|codex>, --limit <n>, --force, --dry-run, --include-unlanded-reports, --json, --help, -v/--version
examples:
  harvest-axi status
  harvest-axi capture --home <orchestrator-home> --dry-run
  harvest-axi record --record-json '{"id":"t-1","title":"..."}'
  harvest-axi distill --dry-run
  harvest-axi distill --extract none --limit 10
`;

export const CAPTURE_HELP = `usage: harvest-axi capture --home <path> [--home ...] [flags]
description:
  Ingest landed[] rows (and optionally unlanded scout reports) from one or more
  orchestrator homes into the solution ledger. Idempotent by record id.
flags[5]:
  --home <path>, --ledger <path>, --include-unlanded-reports, --dry-run, --json
examples:
  harvest-axi capture --home /path/to/home --dry-run
`;

export const RECORD_HELP = `usage: harvest-axi record --record-json '<json>' [--ledger <path>] [--json]
description:
  Append one explicit capture record ({id,kind,title,outcome,source_paths,
  pr_url,event,ts,home}) - the push path for completion hooks.
  (Porting note: the LifeOS copy used --json for input; here --json is always
  the output flag, so input moved to --record-json.)
flags[3]:
  --record-json <json>, --ledger <path>, --json
examples:
  harvest-axi record --record-json '{"id":"t-1","title":"Fix X"}'
`;

export const LIST_HELP = `usage: harvest-axi list [--ledger <path>] [--json]
description:
  Print the ledger, one record per line (or JSON with --json).
flags[2]:
  --ledger <path>, --json
examples:
  harvest-axi list --json
`;

export const DISTILL_HELP = `usage: harvest-axi distill [--ledger <path>] [--queue <path>] [--extract <none|pi|codex>] [--limit <n>] [--force] [--dry-run] [--json]
description:
  Process undistilled ledger records: deterministic fallback extraction (or a
  headless pi/codex extractor), deterministic triage, duplicate check, then
  stage survivors into <queue>/Research/ as pending-review notes.
  Staging only: nothing is promoted into a knowledge store by this tool.
flags[7]:
  --ledger <path>, --queue <path>, --extract <none|pi|codex>, --limit <n>, --force, --dry-run, --json
examples:
  harvest-axi distill --dry-run
  harvest-axi distill --extract none --limit 10
`;

export const STATUS_HELP = `usage: harvest-axi status [--ledger <path>] [--queue <path>] [--json]
description:
  Ledger / processed / queued counts.
flags[3]:
  --ledger <path>, --queue <path>, --json
examples:
  harvest-axi status
  harvest-axi status --json
`;

type MainOptions = {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
  binPath?: string;
};

const COMMANDS = ["capture", "record", "list", "distill", "status"] as const;

export async function main(options: MainOptions = {}): Promise<void> {
  const binPath = options.binPath ?? process.argv[1] ?? "harvest-axi";
  const argv = normalizeArgv(options.argv ?? process.argv.slice(2));

  await runAxiCli<{ binPath: string }>({
    argv,
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    commands: {
      capture: (args, context) => captureCommand(args, context),
      record: (args, context) => recordCommand(args, context),
      list: (args, context) => listCommand(args, context),
      distill: (args, context) => distillCommand(args, context),
      status: (args, context) => statusCommand(args, context),
    },
    home: (args, context) => statusCommand(args, context),
    resolveContext: () => ({ binPath }),
    getCommandHelp: (command) => COMMAND_HELP[command],
  });
}

const COMMAND_HELP: Record<string, string> = {
  capture: CAPTURE_HELP,
  record: RECORD_HELP,
  list: LIST_HELP,
  distill: DISTILL_HELP,
  status: STATUS_HELP,
};

/** Bare `harvest-axi` (and bare flags) route to the `status` command;
 *  runAxiCli routes on argv[0] and rejects a leading flag. */
export function normalizeArgv(raw: string[]): string[] {
  if (raw.length === 0) return ["status"];
  if (raw.includes("--help") || raw.includes("-h")) return ["--help"];
  const versionIndex = raw.findIndex((a) => a === "-v" || a === "-V" || a === "--version");
  if (versionIndex >= 0) return [raw[versionIndex]];
  const commandIndex = raw.findIndex((a) => (COMMANDS as readonly string[]).includes(a));
  if (commandIndex > 0) {
    return [raw[commandIndex], ...raw.slice(0, commandIndex), ...raw.slice(commandIndex + 1)];
  }
  const first = raw[0];
  if (first === "update") return raw;
  if ((COMMANDS as readonly string[]).includes(first)) return raw;
  if (first.startsWith("-")) return ["status", ...raw];
  return raw;
}
