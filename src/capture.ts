/**
 * Capture — P0 of the harvest pipeline: task landings into a durable,
 * harness-independent ledger.
 *
 * Ported from the LifeOS auto-documentation pipeline (SolutionCapture.ts) into
 * the standalone harvest-axi CLI. The trigger is the orchestrator's own landing
 * record, never a hook: hooks only fire inside sessions of one harness, while
 * fleet work runs under many.
 *
 * Sources it reads (all durable orchestrator state, no live pane peeking):
 *   - <home>/state/home-summary.json → landed[]  (ship teardown / scout report)
 *   - <home>/data/<id>/report.md                 (scout reports not yet landed)
 *   - an explicit record pushed by a caller (`record --json`), which is how
 *     completion hooks or a human can feed held answers.
 *
 * It only APPENDS structured capture records. It never distills, never judges
 * durability, and never writes to a knowledge store. The ledger is idempotent:
 * a record whose id is already present is skipped, so re-running is safe.
 *
 * Ledger default: $HARVEST_LEDGER, else $LIFEOS_DIR/MEMORY/STATE/solution-log.jsonl
 * ($LIFEOS_DIR defaults to ~/.claude/LIFEOS for continuity with existing
 * installs; pass --ledger to use any path).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join as pathJoin, resolve as pathResolve } from "node:path";

export const LIFEOS_DIR =
  process.env.LIFEOS_DIR || pathJoin(homedir(), ".claude", "LIFEOS");

export const DEFAULT_LEDGER =
  process.env.HARVEST_LEDGER || pathJoin(LIFEOS_DIR, "MEMORY", "STATE", "solution-log.jsonl");

export interface SolutionRecord {
  /** Stable, human-readable identity — the task id (dedup key). */
  id: string;
  /** ship | scout | decision | report */
  kind: string;
  title: string;
  /** One-line outcome when the landing carried one; "" otherwise. */
  outcome: string;
  /** Home-relative or absolute paths to the source prose. */
  source_paths: string[];
  pr_url: string | null;
  /** Terminal verb that produced the landing (done/reported/...). */
  event: string;
  /** ISO date or timestamp of the landing. */
  ts: string;
  /** Absolute home this landing came from (for source resolution). */
  home: string | null;
}

function sha8(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/** Read the ledger, tolerating an absent file and skipping blank/corrupt lines. */
export function readLedger(ledger: string): SolutionRecord[] {
  if (!existsSync(ledger)) return [];
  const out: SolutionRecord[] = [];
  for (const line of readFileSync(ledger, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as SolutionRecord);
    } catch {
      /* corrupt line — leave it on disk, skip for dedup */
    }
  }
  return out;
}

/** Append only records whose id is not already present. Returns how many landed. */
export function appendRecords(ledger: string, records: SolutionRecord[]): number {
  const existing = new Set(readLedger(ledger).map((r) => r.id));
  const fresh = records.filter((r) => r.id && !existing.has(r.id));
  if (fresh.length === 0) return 0;
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(ledger, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", { flag: "a" });
  return fresh.length;
}

interface HomeSummaryLanded {
  id?: string;
  title?: string;
  pr_url?: string | null;
  report_path?: string | null;
  completion?: { verb?: string; date?: string };
}

/** Build capture records from one home's durable landing state.
 *  By default only `landed[]` rows are captured (the authoritative landing
 *  signal). Pass `includeUnlanded` to also pick up scout reports that exist on
 *  disk but have not reached `landed[]` yet. */
export function captureHome(home: string, includeUnlanded = false): SolutionRecord[] {
  const summaryPath = pathJoin(home, "state", "home-summary.json");
  const records: SolutionRecord[] = [];
  const seen = new Set<string>();

  if (!existsSync(summaryPath)) {
    throw new Error(`no home-summary.json under ${home}`);
  }
  let summary: { landed?: HomeSummaryLanded[] };
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`unreadable home-summary.json: ${msg}`);
  }

  for (const row of summary.landed ?? []) {
    if (!row.id) continue;
    const verb = row.completion?.verb ?? "done";
    const kind = row.report_path ? (verb === "reported" ? "scout" : "ship") : "ship";
    const sources: string[] = [];
    if (row.report_path) sources.push(row.report_path);
    records.push({
      id: row.id,
      kind,
      title: row.title ?? row.id,
      outcome: "",
      source_paths: sources,
      pr_url: row.pr_url ?? null,
      event: verb,
      ts: row.completion?.date ?? new Date().toISOString(),
      home,
    });
    seen.add(row.id);
  }

  // Scout reports that exist on disk but have not (yet) reached landed[].
  const dataDir = pathJoin(home, "data");
  if (includeUnlanded && existsSync(dataDir)) {
    for (const entry of readdirSync(dataDir)) {
      if (seen.has(entry)) continue;
      const report = pathJoin(dataDir, entry, "report.md");
      if (!existsSync(report)) continue;
      records.push({
        id: entry,
        kind: "scout",
        title: entry,
        outcome: "",
        source_paths: [pathJoin("data", entry, "report.md")],
        pr_url: null,
        event: "report",
        ts: new Date().toISOString(),
        home,
      });
    }
  }
  return records;
}

/** Resolve a record's source paths to readable absolute files, first match wins. */
export function resolveSources(record: SolutionRecord): string[] {
  const roots = [record.home, process.cwd()].filter(Boolean) as string[];
  const out: string[] = [];
  for (const p of record.source_paths ?? []) {
    const candidates = p.startsWith("/") ? [p] : roots.map((r) => pathJoin(r, p));
    const hit = candidates.find((c) => existsSync(c));
    if (hit) out.push(hit);
  }
  return out;
}

/** Normalize a captured record, filling identity/ts/home defaults. */
export function normalizeRecord(raw: Partial<SolutionRecord>): SolutionRecord {
  const title = (raw.title ?? raw.id ?? "untitled").toString().trim();
  const home = raw.home ?? null;
  const id =
    raw.id ??
    (home ? `${sha8(home)}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}` : title);
  return {
    id,
    kind: (raw.kind ?? "ship").toString(),
    title,
    outcome: (raw.outcome ?? "").toString(),
    source_paths: Array.isArray(raw.source_paths) ? raw.source_paths.map(String) : [],
    pr_url: raw.pr_url ? String(raw.pr_url) : null,
    event: (raw.event ?? "manual").toString(),
    ts: (raw.ts ?? new Date().toISOString()).toString(),
    home,
  };
}

/** Resolve the ledger path for a command invocation. */
export function resolveLedger(flagValue?: string | null): string {
  return flagValue ? pathResolve(flagValue) : DEFAULT_LEDGER;
}
