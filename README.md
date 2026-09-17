# harvest-axi

AXI CLI that turns task-landing records into a durable solution ledger, then distills staged knowledge candidates with deterministic triage.

- `capture` ingests `landed[]` rows (and optional unlanded scout reports) from orchestrator homes. Idempotent by record id.
- `record` pushes one explicit record (the completion-hook path).
- `list` prints the ledger.
- `distill` extracts a candidate note per new record (deterministic fallback, or headless `pi`/`codex`), applies deterministic triage and a duplicate check, and stages survivors into `<queue>/Research/` as `pending-review` notes.
- `status` reports ledger / processed / queued counts.

Staging only: nothing is promoted into a knowledge store by this tool. A staged note leaves the queue through an explicit human review action.

## Install

Published to npm eventually; until then git-install:

```sh
npm install -g github:adibirzu/harvest-axi
```

Requires Node >= 22. No global install needed for one-shots: `npx -y github:adibirzu/harvest-axi status`.

## Usage

```sh
harvest-axi status
harvest-axi capture --home /path/to/orchestrator-home --dry-run
harvest-axi capture --home /path/to/home
harvest-axi record --record-json '{"id":"t-1","title":"Fix X","kind":"ship"}'
harvest-axi distill --dry-run
harvest-axi distill --extract none --limit 10
harvest-axi list --json
```

Ledger default: `$HARVEST_LEDGER`, else `$LIFEOS_DIR/MEMORY/STATE/solution-log.jsonl`.
Queue default: `$HARVEST_QUEUE`, else `$LIFEOS_DIR/MEMORY/KNOWLEDGE/_harvest-queue`.
`--ledger` / `--queue` override per invocation. `--json` prints machine-readable output on every command.

## Porting notes (from the LifeOS in-tree copy)

- Runtime is Node (the in-tree copy ran on Bun). The optional `MemorySystem.find` dedup probe still shells to `bun` when present and fail-softs to slug checks when absent.
- `record --json '<...>'` (input) became `record --record-json '<...>'` so `--json` is always the output flag, AXI-wide. `list --json` now works (the in-tree copy only honored `--jsonOut`).
- `source_session:` provenance is `harvest/<task-id>` instead of `firstmate/<task-id>`; deterministic-fallback tags are `operational, harvest`.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Tests run against synthetic fixtures under `test/fixtures/` (obviously-fake placeholder values only, never real credentials).

## License

MIT
