---
name: harvest-axi
description: "Turn task-landing records into a durable solution ledger, then distill staged knowledge candidates with deterministic triage - capture/record/list/distill/status via the harvest-axi CLI. Use when harvesting durable facts from completed work, or when asking about the harvest queue, ledger, or triage."
user-invocable: false
author: Adrian Birzu
---

# harvest-axi

Task landings into a durable solution ledger, then deterministic distillation into staged knowledge candidates.

You do not need harvest-axi installed globally - invoke it with `npx -y harvest-axi` (once published; until then `npm install -g github:adibirzu/harvest-axi`).

harvest-axi stages only: it never promotes a note into a knowledge store. A staged note leaves `<queue>/Research/` only through an explicit human review action.

## When to use

Use harvest-axi whenever completed work should leave a durable trace: after a task lands, to record what was durable; to see what is waiting in the harvest queue; or to run the distill pass that turns new ledger records into pending-review candidates.

## Workflow

1. Run `harvest-axi status` for ledger / processed / queued counts.
2. Run `harvest-axi capture --home <orchestrator-home> --dry-run` to preview what a home's landings would append, then without `--dry-run` to append.
3. Run `harvest-axi record --record-json '{"id":"t-1","title":"..."}'` to push one explicit record (the completion-hook path).
4. Run `harvest-axi distill --dry-run` to preview triage outcomes, then without `--dry-run` to stage survivors. `--extract pi|codex` enables headless-model extraction; default `none` uses the deterministic fallback.

## Contract

- Ledger default is `$HARVEST_LEDGER`, else `$LIFEOS_DIR/MEMORY/STATE/solution-log.jsonl`. Queue default is `$HARVEST_QUEUE`, else `$LIFEOS_DIR/MEMORY/KNOWLEDGE/_harvest-queue`. Pass `--ledger`/`--queue` to point anywhere.
- `--json` on any command prints machine-readable output.
- Staged notes carry `source_kind: operational`, `status: pending-review`, and `source_session: harvest/<task-id>` provenance.
