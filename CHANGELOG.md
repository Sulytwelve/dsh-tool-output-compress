# Changelog

## 0.1.2 — 2026-11-18

Distribution only; no runtime behavior change.

### Added

- A tag-triggered npm publish workflow (`.github/workflows/publish.yml`, `NPM_TOKEN` secret) so a
  tagged release can be published with provenance instead of being installed only from a GitHub tag.

## 0.1.1 — 2026-11-18

Repository hygiene only; no runtime behavior change.

### Fixed

- Removed a benchmark shell script that was accidentally committed as `.tmp-bench.sh`, and ignored
  `.tmp-*` going forward. The npm package never included it (the `files` allowlist is unchanged).

## 0.1.0 — 2026-11-18

First release. Deterministic compression of long `bash` output for DSH 0.2.2-rc.3, profile `web`.

### Why

Long service, journal and test output entered the model verbatim and cost the most tokens for the
least information; the operator needed the error lines, the stack, the transitions and the ability
to retrieve any original line later.

### Added

- `tools/post-execute` hook (normal order, not `prepend`) that replaces oversized `bash` content with
  a rules-v1 summary and one artifact pointer.
- Complete stdout/stderr artifacts with manifest (SHA-256, bytes, lines, markers, stream identity,
  rule version) under an owner-only tree; quota, retention, pin and CLI retrieval by line range.
- Deterministic summarizer: anomalies and continuations, head/tail, sampled timestamps, repeated-line
  collapse with line references, verbatim status markers, soft-byte-budget degradation.
- Fail-open behavior: storage/quota/budget/spill problems keep the host's original result.
- CLI `status/list/show/path/pin/gc/bench/doctor/version`; no GUI, no new model-facing tool, no
  command execution, no approval path.
- Heartbeat with an in-process summarizer self-test, so a loaded row is verifiable without a session.
- 7 test files / 38 assertions, runnable from the packed tarball.

### Verified on the target host

SULY-HPED800, Arch Linux, DSH 0.2.2-rc.3, 2026-11-18:

- The `web` profile already mounts the shipped `spill-policy` (`maxInlineTokens: 12500`); this hook
  runs before it and the short summary is not retained again.
- Benchmarks: an 805-line unit journal (125,414 B, ~31,354 estimated tokens) became 2,234 B
  (~559 estimated tokens) in 8.3 ms; a test run shrank 83.4%.
- The hook path imports no process API; `nosample.mjs` asserts no `child_process`, no `spawn`,
  no `execFile`, and no tool registration.

### Limits

- Linux `bash` only; `pwsh` was only a Windows test environment.
- Background jobs and non-text results are outside the hook.
- A stream whose spill was discarded (over the 64 MiB cap) or unreadable keeps the original result.
- Token figures in the docs are the harness 4 chars/token heuristic, not provider tokenization.
- Thresholds are calibrate-required until per-host measurements exist.
