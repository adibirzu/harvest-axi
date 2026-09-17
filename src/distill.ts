/**
 * Distill — P1/P2 of the harvest pipeline: ledger → triage → dedup → queue.
 *
 * Ported from the LifeOS auto-documentation pipeline (SolutionDistiller.ts)
 * into the standalone harvest-axi CLI. Reads new records from the capture
 * ledger, extracts a candidate knowledge note from each record's source prose,
 * applies deterministic triage, checks for near-duplicates, and stages EVERY
 * surviving candidate into `<queue>/Research/` (staging only).
 *
 * It NEVER writes into a knowledge store directly. A note leaves the queue
 * only through an explicit human review/promote action.
 *
 * Staged notes carry `source_kind: operational` (the operations-outcome class:
 * an internal result, mapped to `entity_type: research`) and
 * `source_session: <home-kind>/<task-id>` so provenance survives promotion.
 *
 * Queue default: $HARVEST_QUEUE, else $LIFEOS_DIR/MEMORY/KNOWLEDGE/_harvest-queue
 * (pass --queue to use any path).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join as pathJoin, resolve as pathResolve } from "node:path";
import {
  LIFEOS_DIR,
  readLedger,
  resolveSources,
  type SolutionRecord,
} from "./capture.js";

const KNOWLEDGE_DIR = pathJoin(LIFEOS_DIR, "MEMORY", "KNOWLEDGE");
export const DEFAULT_QUEUE =
  process.env.HARVEST_QUEUE || pathJoin(KNOWLEDGE_DIR, "_harvest-queue");
export const DOMAIN = "Research"; // ops notes -> research
export const SOURCE_KIND = "operational"; // the operations-outcome class
const MAX_SOURCE_CHARS = 12_000;
const DEDUP_THRESHOLD = 18; // BM25 top-1 above this is a possible duplicate

// ── Triage ────────────────────────────────────────────────────────────────

const HEX_TOKEN = /\b[0-9a-f]{7,40}\b/g;

/** A git SHA-like token: hex, with at least one letter AND one digit (so plain
 *  dates such as 20260913 and all-letter words are not misread). */
function looksLikeSha(token: string): boolean {
  return /[a-f]/.test(token) && /[0-9]/.test(token);
}

/** Reasons a candidate body is routine noise rather than durable knowledge. */
export function rejectReasons(text: string): string[] {
  const reasons: string[] = [];
  if ((text.match(HEX_TOKEN) ?? []).some(looksLikeSha)) reasons.push("commit-sha");
  if (/\bPR\s*#\d+/i.test(text)) reasons.push("pr-number");
  if (/https?:\/\/\S*\/pull\/\d+/.test(text)) reasons.push("pull-url");
  if (/\bchecks?\s+(passed|green)\b/i.test(text)) reasons.push("checks-green");
  if (/(?:^|\s)(?:fm|feat|fix|chore|docs|refactor)\/[a-z0-9._-]+/i.test(text)) reasons.push("branch-name");
  if (/\b(in progress|TODO)\b/.test(text)) reasons.push("in-progress");
  return reasons;
}

const IDENTIFIER_PATTERNS: RegExp[] = [
  /\b[\w.-]+\.\w+:\d+\b/, // file.ts:123
  /\b\w+\(\)/, // function()
  /--[a-z][a-z0-9-]+/, // --flag
  /\b[1-5]\d\d\b/, // HTTP status
  /\bv?\d+\.\d+(?:\.\d+)?\b/, // semver / version
  /\b[A-Z][A-Z0-9_]{3,}\b/, // ENV_VAR / constant
];

const CONNECTOR_PATTERNS: RegExp[] = [
  /\b(because|instead|workaround|the fix|root cause|so that|therefore|that's why|turned out)\b/i,
];

export interface Triage {
  candidate: boolean;
  score: number;
  matched: string[];
  rejectedBy: string[];
}

/** Deterministic noise filter. Candidate = not rejected AND >=2 signals. */
export function triage(text: string): Triage {
  const rejectedBy = rejectReasons(text);
  const matched: string[] = [];
  if (IDENTIFIER_PATTERNS.some((re) => re.test(text))) matched.push("identifier");
  if (CONNECTOR_PATTERNS.some((re) => re.test(text))) matched.push("connector");
  if (text.trim().length >= 400) matched.push("length>=400");
  const score = matched.length;
  return { candidate: rejectedBy.length === 0 && score >= 2, score, matched, rejectedBy };
}

// ── Source text / extraction ──────────────────────────────────────────────

/** Strip a leading YAML frontmatter block. */
export function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/** Bound a source to MAX_SOURCE_CHARS on a line boundary. */
export function capSource(text: string, max = MAX_SOURCE_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return (nl > max * 0.6 ? cut.slice(0, nl) : cut) + "\n\n[... truncated ...]";
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export interface Candidate {
  title: string;
  content: string;
  confidence: number;
  tags: string[];
  related: Array<{ slug: string; type: string }>;
}

/** Deterministic fallback: title from the record, body from the source prose. */
export function deterministicCandidate(record: SolutionRecord, sourceText: string): Candidate {
  const body = stripFrontmatter(sourceText).trim();
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#") && !p.startsWith("**Task") && !p.startsWith("> "));
  const outcome = record.outcome ? `${record.outcome}\n\n` : "";
  const excerpt = paragraphs.slice(0, 6).join("\n\n").slice(0, 4000);
  return {
    title: record.title,
    content: `${outcome}${excerpt}`,
    confidence: 0.6,
    tags: ["operational", "harvest"],
    related: [],
  };
}

const EXTRACTION_PROMPT = `You extract ONE durable knowledge note from a task report.
Return ONLY a JSON object, no prose, with keys:
  "title": string, a specific durable fact (cause -> fix/behavior). No task ids, no dates.
  "content": string, a self-contained markdown body of at least 400 characters. Keep concrete
    identifiers (file names, flags, env vars, API endpoints, version numbers), the cause, and the
    fix/workaround. State the generalizable rule. Never include secret VALUES.
  "confidence": number 0..1, how durable and generalizable the fact is.
  "tags": array of 2-6 lowercase kebab-case tags.
  "related": array of {"slug","type"} (may be empty; type usually "related").
If the text is routine progress with no durable fact, return {"skip": true}.`;

/** Run a headless extractor over the source text; returns null on any failure. */
export function modelCandidate(kind: string, sourceText: string): Candidate | null {
  const prompt = `${EXTRACTION_PROMPT}\n\n--- REPORT ---\n${sourceText}`;
  const bin = kind === "pi" ? "pi" : kind === "codex" ? "codex" : kind;
  const args = kind === "codex" ? ["exec", prompt] : ["-p", "--mode", "text", prompt];
  let r;
  try {
    r = spawnSync(bin, args, { encoding: "utf-8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
  if (r.status !== 0 || !r.stdout) return null;
  const start = r.stdout.indexOf("{");
  const end = r.stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  const p = parsed as Record<string, unknown>;
  if (p.skip || !p.title || !p.content) return null;
  return {
    title: String(p.title).replace(/[\r\n]+/g, " ").trim(),
    content: String(p.content).trim(),
    confidence: typeof p.confidence === "number" ? p.confidence : 0.7,
    tags: Array.isArray(p.tags) ? p.tags.map((t: unknown) => String(t)) : ["operational"],
    related: Array.isArray(p.related)
      ? (p.related as unknown[])
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && "slug" in x)
          .map((x) => ({ slug: String(x.slug), type: String(x.type ?? "related") }))
      : [],
  };
}

// ── Dedup ─────────────────────────────────────────────────────────────────

export interface Dedup {
  duplicateOf: string | null;
  score: number;
  slugExists: boolean;
}

function knowledgeSlugExists(slug: string): boolean {
  return ["People", "Companies", "Ideas", "Research"].some((d) =>
    existsSync(pathJoin(KNOWLEDGE_DIR, d, `${slug}.md`)),
  );
}

function defaultQueue(): string {
  return process.env.HARVEST_QUEUE || DEFAULT_QUEUE;
}

/** Thin wrapper over a `MemorySystem.ts find` runner; fail-soft when absent.
 *  Prefers bun (the runner MemorySystem ships for); without it, no model
 *  dedup signal — slug checks still apply. */
function findSimilar(query: string): { path: string; score: number } | null {
  const ms = pathJoin(LIFEOS_DIR, "TOOLS", "MemorySystem.ts");
  if (!existsSync(ms)) return null;
  let r;
  try {
    r = spawnSync("bun", [ms, "find", query, "--top", "3"], {
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (!r || r.status !== 0 || !r.stdout) return null;
  try {
    const arr = JSON.parse(r.stdout) as Array<{ path: string; score: number }>;
    return Array.isArray(arr) && arr[0] ? { path: arr[0].path, score: arr[0].score } : null;
  } catch {
    return null;
  }
}

export function dedup(slug: string, title: string, queue?: string): Dedup {
  const q = queue ?? defaultQueue();
  const slugExists = knowledgeSlugExists(slug) || existsSync(pathJoin(q, DOMAIN, `${slug}.md`));
  const hit = findSimilar(title);
  const duplicateOf = hit && hit.score >= DEDUP_THRESHOLD ? hit.path : null;
  return { duplicateOf, score: hit?.score ?? 0, slugExists };
}

// ── Staging (nothing enters a knowledge store unattended) ─────────────────

export function renderStagedNote(record: SolutionRecord, c: Candidate, d: Dedup): string {
  const today = new Date().toISOString().split("T")[0];
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const related = c.related.length
    ? `\nrelated:\n${c.related.map((r) => `  - slug: ${r.slug}\n    type: ${r.type}`).join("\n")}`
    : "";
  const dupLine = d.duplicateOf ? `\npossible_duplicate_of: ${d.duplicateOf}` : "";
  return `---
title: "${esc(c.title)}"
type: research
domain: research
tags: [${c.tags.map((t) => t.trim().replace(/\s+/g, "-")).filter(Boolean).join(", ") || "untagged"}]
status: pending-review
quality: 5
source_kind: ${SOURCE_KIND}
source_session: harvest/${record.id}
confidence: ${c.confidence}${dupLine}
created: ${today}
updated: ${today}
harvested_from: ${resolveSources(record)[0] ?? record.source_paths[0] ?? "unknown"}${related}
---

# ${c.title}

${c.content.trim()}
`;
}

function stageNote(record: SolutionRecord, c: Candidate, d: Dedup, queue: string): string {
  const slug = slugify(c.title);
  const dir = pathJoin(queue, DOMAIN);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = pathJoin(dir, `${slug}.md`);
  writeFileSync(target, renderStagedNote(record, c, d));
  return slug;
}

// ── Cursor ────────────────────────────────────────────────────────────────

function cursorPath(ledger: string): string {
  return `${ledger}.distilled`;
}

export function loadProcessed(ledger: string): Set<string> {
  const p = cursorPath(ledger);
  if (!existsSync(p)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

export function saveProcessed(ledger: string, ids: Set<string>): void {
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(cursorPath(ledger), JSON.stringify([...ids].sort(), null, 2) + "\n");
}

// ── Distill run ───────────────────────────────────────────────────────────

export interface DistillOptions {
  ledger: string;
  queue: string;
  extractor?: string;
  limit?: number;
  force?: boolean;
  dryRun?: boolean;
}

export interface DistillOutcome {
  line: string;
  kind: "STAGE" | "STAGE(dry)" | "DROP" | "SKIP";
  recordId: string;
}

/** Process undistilled ledger records. Pure FS aside from the optional model
 *  extractor and MemorySystem dedup probe (both fail-soft). */
export function distillRecords(options: DistillOptions): { outcomes: DistillOutcome[]; staged: number; dropped: number; skipped: number } {
  const { ledger, queue } = options;
  const records = readLedger(ledger);
  const processed = options.force ? new Set<string>() : loadProcessed(ledger);
  const limit = options.limit ?? Infinity;
  const extractor = (options.extractor ?? "none").toLowerCase();

  let staged = 0;
  let dropped = 0;
  let skipped = 0;
  const outcomes: DistillOutcome[] = [];

  for (const record of records) {
    if (processed.has(record.id)) continue;
    if (staged >= limit) break;

    const sources = resolveSources(record);
    const sourceText =
      sources.map((p) => readFileSync(p, "utf-8")).join("\n\n").slice(0, MAX_SOURCE_CHARS) || record.title;

    let candidate: Candidate | null = null;
    if (extractor !== "none") candidate = modelCandidate(extractor, capSource(sourceText));
    if (!candidate) candidate = deterministicCandidate(record, sourceText);

    const t = triage(`${candidate.title}\n${candidate.content}`);
    if (!t.candidate) {
      dropped++;
      outcomes.push({ line: `DROP  ${record.id}  [${t.rejectedBy.join(",") || `score=${t.score}`}]`, kind: "DROP", recordId: record.id });
      processed.add(record.id);
      continue;
    }

    const slug = slugify(candidate.title);
    const d = dedup(slug, candidate.title, queue);
    if (d.slugExists) {
      skipped++;
      outcomes.push({ line: `SKIP  ${record.id}  already present: ${slug}`, kind: "SKIP", recordId: record.id });
      processed.add(record.id);
      continue;
    }

    if (options.dryRun) {
      outcomes.push({ line: `STAGE(dry) ${record.id} -> ${DOMAIN}/${slug}.md  score=${t.score} conf=${candidate.confidence}`, kind: "STAGE(dry)", recordId: record.id });
    } else {
      stageNote(record, candidate, d, queue);
      outcomes.push({ line: `STAGE ${record.id} -> ${DOMAIN}/${slug}.md  score=${t.score} conf=${candidate.confidence}${d.duplicateOf ? ` dup~${d.score.toFixed(1)}` : ""}`, kind: "STAGE", recordId: record.id });
    }
    staged++;
    processed.add(record.id);
  }

  if (!options.dryRun) saveProcessed(ledger, processed);
  return { outcomes, staged, dropped, skipped };
}

/** Resolve the queue path for a command invocation. */
export function resolveQueue(flagValue?: string | null): string {
  return flagValue ? pathResolve(flagValue) : defaultQueue();
}
