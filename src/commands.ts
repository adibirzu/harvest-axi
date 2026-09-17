import { parseArgs } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import {
  appendRecords,
  captureHome,
  normalizeRecord,
  readLedger,
  resolveLedger,
  type SolutionRecord,
} from "./capture.js";
import {
  DEFAULT_QUEUE,
  DOMAIN,
  distillRecords,
  loadProcessed,
  resolveQueue,
} from "./distill.js";
import { DEFAULT_LEDGER } from "./capture.js";

type Context = { binPath: string };

function binOf(context: Context | undefined): string {
  return context?.binPath ?? "harvest-axi";
}

function fail(message: string): never {
  const err = new Error(message) as Error & { exitCode?: number };
  err.exitCode = 2;
  throw err;
}

const SHARED = {
  ledger: { type: "string" as const },
  queue: { type: "string" as const },
  json: { type: "boolean" as const, short: "j" as const },
};

export async function captureCommand(args: string[], context: Context | undefined): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      ...SHARED,
      home: { type: "string", multiple: true },
      "include-unlanded-reports": { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (positionals[0] && positionals[0] !== "capture") fail(`unexpected argument: ${positionals[0]}`);
  const homes = values.home ?? [];
  if (homes.length === 0) fail("capture requires at least one --home <path>");
  const ledger = resolveLedger(values.ledger);
  let records: SolutionRecord[] = [];
  for (const h of homes) {
    try {
      records = records.concat(captureHome(h, !!values["include-unlanded-reports"]));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }
  if (values["dry-run"]) {
    if (values.json) return `${JSON.stringify(records, null, 2)}\n`;
    return `${records.map((r) => `CANDIDATE ${r.id} [${r.kind}] ${r.title}`).join("\n")}${records.length ? "\n" : ""}`;
  }
  const n = appendRecords(ledger, records);
  if (values.json) {
    return `${JSON.stringify({ candidates: records.length, added: n, ledger }, null, 2)}\n`;
  }
  return `capture: ${records.length} candidate record(s), ${n} new -> ${ledger}\n`;
}

export async function recordCommand(args: string[], context: Context | undefined): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    options: { ledger: SHARED.ledger, recordJson: { type: "string" }, json: SHARED.json },
    allowPositionals: true,
  });
  if (positionals[0] && positionals[0] !== "record") fail(`unexpected argument: ${positionals[0]}`);
  const raw = values.recordJson;
  if (!raw) fail("record requires --record-json '<record-json>' (renamed from --json '<...>' so --json stays the output flag)");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`invalid --record-json: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ledger = resolveLedger(values.ledger);
  const n = appendRecords(ledger, [normalizeRecord(parsed as Record<string, unknown>)]);
  if (values.json) return `${JSON.stringify({ added: n, ledger }, null, 2)}\n`;
  return `record: ${n} new -> ${ledger}\n`;
}

export async function listCommand(args: string[], context: Context | undefined): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    options: { ledger: SHARED.ledger, json: SHARED.json },
    allowPositionals: true,
  });
  if (positionals[0] && positionals[0] !== "list") fail(`unexpected argument: ${positionals[0]}`);
  const records = readLedger(resolveLedger(values.ledger));
  if (values.json) return `${JSON.stringify(records, null, 2)}\n`;
  return `${records.map((r) => `${r.ts}\t${r.kind}\t${r.id}\t${r.title}`).join("\n")}${records.length ? "\n" : ""}`;
}

export async function distillCommand(args: string[], _context: Context | undefined): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      ...SHARED,
      extract: { type: "string" },
      limit: { type: "string" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (positionals[0] && positionals[0] !== "distill") fail(`unexpected argument: ${positionals[0]}`);
  const ledger = resolveLedger(values.ledger);
  const queue = resolveQueue(values.queue);
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  if (values.limit && (!Number.isFinite(limit) || (limit as number) < 0)) fail(`invalid --limit: ${values.limit}`);
  const { outcomes, staged, dropped, skipped } = distillRecords({
    ledger,
    queue,
    extractor: values.extract ?? "none",
    ...(limit === undefined ? {} : { limit }),
    force: !!values.force,
    dryRun: !!values["dry-run"],
  });
  if (values.json) {
    return `${JSON.stringify({ staged, dropped, skipped, queue: pathJoin(queue, DOMAIN), outcomes: outcomes.map((o) => o.line) }, null, 2)}\n`;
  }
  const lines = outcomes.map((o) => o.line);
  lines.push(`\ndistill: ${staged} staged, ${dropped} dropped, ${skipped} skipped -> ${pathJoin(queue, DOMAIN)}`);
  return `${lines.join("\n")}\n`;
}

export async function statusCommand(args: string[], _context: Context | undefined): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    options: { ledger: SHARED.ledger, queue: SHARED.queue, json: SHARED.json },
    allowPositionals: true,
  });
  if (positionals[0] && positionals[0] !== "status") fail(`unexpected argument: ${positionals[0]}`);
  const ledger = resolveLedger(values.ledger);
  const queue = resolveQueue(values.queue);
  const records = readLedger(ledger);
  const processed = loadProcessed(ledger);
  const dir = pathJoin(queue, DOMAIN);
  const queued = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).length : 0;
  if (values.json) {
    return `${JSON.stringify({ ledger, records: records.length, processed: processed.size, queued, queueDir: dir }, null, 2)}\n`;
  }
  void binOf(_context);
  return `ledger:    ${records.length} record(s) (${ledger})\nprocessed: ${processed.size}\nqueued:    ${queued} note(s) in ${dir}\n`;
}

export { DEFAULT_LEDGER, DEFAULT_QUEUE };
