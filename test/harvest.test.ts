/**
 * harvest-axi parity tests: capture building, ledger idempotency, triage,
 * slugify, staged-note render, and the full capture -> distill loop against
 * synthetic fixtures. Never touches a live knowledge store; every fixture
 * value is an obviously-fake placeholder, never a real credential.
 */
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendRecords,
  captureHome,
  normalizeRecord,
  readLedger,
  resolveSources,
  type SolutionRecord,
} from "../src/capture.js";
import { distillRecords, slugify, triage, renderStagedNote, dedup } from "../src/distill.js";
import { recordCommand } from "../src/commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_HOME = pathJoin(HERE, "fixtures", "home");

let work: string;

beforeEach(() => {
  work = mkdtempSync(pathJoin(tmpdir(), "harvest-axi-test-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function fixtureHome(): string {
  const home = pathJoin(work, "home");
  cpSync(FIXTURE_HOME, home, { recursive: true });
  return home;
}

describe("capture", () => {
  test("builds records from landed[] only by default", () => {
    const home = pathJoin(work, "home");
    mkdirSync(pathJoin(home, "state"), { recursive: true });
    mkdirSync(pathJoin(home, "data", "scout-a"), { recursive: true });
    mkdirSync(pathJoin(home, "data", "unlanded-b"), { recursive: true });
    writeFileSync(pathJoin(home, "data", "scout-a", "report.md"), "# scout a\n");
    writeFileSync(pathJoin(home, "data", "unlanded-b", "report.md"), "# unlanded\n");
    writeFileSync(
      pathJoin(home, "state", "home-summary.json"),
      JSON.stringify({
        landed: [
          { id: "ship-a", title: "Ship A", pr_url: "https://example.invalid/pull/1", report_path: null, completion: { verb: "done", date: "2026-09-13" } },
          { id: "scout-a", title: "Scout A", report_path: "data/scout-a/report.md", completion: { verb: "reported", date: "2026-09-13" } },
        ],
      }),
    );
    const records = captureHome(home);
    expect(records.map((r) => r.id).sort()).toEqual(["scout-a", "ship-a"]);
    expect(records.find((r) => r.id === "scout-a")!.kind).toBe("scout");
    const withUnlanded = captureHome(home, true);
    expect(withUnlanded.some((r) => r.id === "unlanded-b")).toBe(true);
  });

  test("refuses a home without home-summary.json", () => {
    expect(() => captureHome(pathJoin(work, "nope"))).toThrow(/home-summary\.json/);
  });

  test("appendRecords is idempotent by id", () => {
    const ledger = pathJoin(work, "solution-log.jsonl");
    const r: SolutionRecord = normalizeRecord({ id: "a", title: "A" });
    expect(appendRecords(ledger, [r])).toBe(1);
    expect(appendRecords(ledger, [r])).toBe(0);
    expect(appendRecords(ledger, [normalizeRecord({ id: "b", title: "B" })])).toBe(1);
    expect(readLedger(ledger).map((x) => x.id)).toEqual(["a", "b"]);
  });

  test("resolveSources resolves home-relative paths", () => {
    const home = pathJoin(work, "home");
    mkdirSync(pathJoin(home, "data", "x"), { recursive: true });
    const report = pathJoin(home, "data", "x", "report.md");
    writeFileSync(report, "hello");
    const rec = normalizeRecord({ id: "x", title: "X", source_paths: ["data/x/report.md"], home });
    expect(resolveSources(rec)).toEqual([report]);
  });
});

describe("triage", () => {
  const good = [
    "The fix is a guard in verifyExample(): because exampleValidate accepts an empty placeholder,",
    "an unset EXAMPLE_SERVICE_TOKEN key silently validates an attacker signature instead of failing closed.",
    "Add `if (!token.trim()) return false` before the call in src/example.ts:42. The workaround applies to all HMAC helpers.",
  ].join(" ");

  test("keeps a durable, concrete candidate", () => {
    const t = triage(good);
    expect(t.candidate).toBe(true);
    expect(t.score).toBeGreaterThanOrEqual(2);
  });

  test("rejects pure progress noise", () => {
    expect(triage("Fixed a typo and checks are green now.").candidate).toBe(false);
    expect(triage("PR #123 merged, branch fm/foo in progress").rejectedBy).toContain("pr-number");
  });

  test("a plain date is not mistaken for a commit SHA", () => {
    const t = triage("On 20260913 we changed the config because the old flag misfired, see --retry flag docs and the fix.");
    expect(t.rejectedBy).not.toContain("commit-sha");
  });

  test("a real-looking SHA is rejected", () => {
    expect(triage("see commit 08b0316 for details because the fix landed").rejectedBy).toContain("commit-sha");
  });
});

describe("staging render", () => {
  test("slugify is kebab and bounded", () => {
    expect(slugify("exampleValidate accepts an EMPTY token!")).toBe("examplevalidate-accepts-an-empty-token");
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });

  test("rendered note carries operational provenance and pending-review status", () => {
    const rec = normalizeRecord({ id: "task-x", title: "X", source_paths: ["data/task-x/report.md"], home: work });
    const note = renderStagedNote(
      rec,
      { title: "A durable fix", content: "c".repeat(500), confidence: 0.8, tags: ["ops"], related: [{ slug: "x", type: "related" }] },
      { duplicateOf: null, score: 0, slugExists: false },
    );
    expect(note).toContain("source_kind: operational");
    expect(note).toContain("source_session: harvest/task-x");
    expect(note).toContain("status: pending-review");
    expect(note).toContain("type: research");
    expect(note).toContain("related:\n  - slug: x\n    type: related");
  });

  test("dedup flags an existing queued slug without a model call", () => {
    const queue = pathJoin(work, "queue");
    mkdirSync(pathJoin(queue, "Research"), { recursive: true });
    writeFileSync(pathJoin(queue, "Research", "known-note.md"), "---\n---\n");
    expect(dedup("known-note", "Known note", queue).slugExists).toBe(true);
  });
});

describe("end to end", () => {
  test("capture -> distill stages the fixture report", () => {
    const home = fixtureHome();
    const ledger = pathJoin(work, "solution-log.jsonl");
    const queue = pathJoin(work, "queue");
    const records = captureHome(home);
    expect(records.map((r) => r.id)).toEqual(["demo-ship"]);
    expect(appendRecords(ledger, records)).toBe(1);
    const { staged, dropped, skipped } = distillRecords({ ledger, queue, extractor: "none" });
    expect({ staged, dropped, skipped }).toEqual({ staged: 1, dropped: 0, skipped: 0 });
    const stagedFiles = readFileSync(pathJoin(queue, "Research", "demo-ship.md"), "utf-8");
    expect(stagedFiles).toContain("status: pending-review");
    expect(stagedFiles).toContain("source_kind: operational");
    // Re-run is idempotent: cursor skips the processed record.
    const again = distillRecords({ ledger, queue, extractor: "none" });
    expect(again.staged).toBe(0);
  });

  test("no fixture carries a real-looking secret", () => {
    const report = readFileSync(pathJoin(FIXTURE_HOME, "data", "demo-ship", "report.md"), "utf-8");
    expect(report).toContain("sk-test-placeholder");
    // Long random-looking suffixes would be real-shaped; the mandated
    // placeholder shape (short alpha suffix) must not trip this.
    expect(report).not.toMatch(/sk-(live|test)-[A-Za-z0-9]{20,}/);
  });
});

describe("record CLI", () => {
  test("records one landing with the documented --record-json flag", async () => {
    const ledger = pathJoin(work, "solution-log.jsonl");
    const payload = {
      id: "hook-landing-1",
      title: "Completion hook landing",
      kind: "ship",
    };
    const out = await recordCommand(
      ["--record-json", JSON.stringify(payload), "--ledger", ledger],
      undefined,
    );
    expect(out).toMatch(/^record: 1 new -> /);
    const records = readLedger(ledger);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "hook-landing-1",
      title: "Completion hook landing",
      kind: "ship",
    });
  });
});
