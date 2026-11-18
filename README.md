# dsh-tool-output-compress

Deterministic compression of long shell output for DeepSeek Harness 0.2.2-rc.3, profile `web`.
A `tools/post-execute` hook replaces oversized `bash` output with a small summary that keeps errors,
stack traces, transitions and line references, and stores the complete stdout/stderr as a recoverable
artifact. It adds no tool, runs no command, and asks for no approval.

## Verified host contract (not assumed)

| Contract | Verification |
|---|---|
| `tools/post-execute` waterfall; `{kind:'accept', content}` replaces model-visible content and preserves `isError`/`value`/`meta`; a throwing listener turns the result into an error | `@deepseek-ai/dsh-tools/src/pipeline.ts:483-533` |
| The shipped `spill-policy` is also a post-execute listener with `{prepend:true}`, so a normal listener runs before its retention | `@deepseek-ai/dsh-spill-policy/src/index.ts:134-157`; active in the `web` profile with `maxInlineTokens: 12500` |
| bash's model-visible text = stdout tail, `[stderr]` section, then status markers; a truncated stream carries `[output truncated; full output: <spill>]` | `@deepseek-ai/dsh-tool-bash/src/render.ts:11-15,28-66` |
| The spill file is the **complete** stream; bash defaults are 64,000 B in-memory tail and 64 MiB spill cap | `@deepseek-ai/dsh-subprocess/src/types.ts:21-29`; `@deepseek-ai/dsh-bash-local/src/index.ts:100-107,157-166` |
| `stdoutMaxBytes` is available to in-process consumers only; the bash tool does not expose it, so the hook reads the spill instead of raising capture | `@deepseek-ai/dsh-shell/src/types.ts:69-75` |
| Hook context: `exec.name/arguments/callId/agent.id/signal` | `dsh-tools/src/pipeline.ts:131-147` |
| Token estimate is the harness heuristic 4 chars/token (not the provider tokenizer) | `@deepseek-ai/dsh-token-meter/src/estimate.ts:12-13` |

Route chosen: **post-execute + spill file**, not a command wrapper. A wrapper would add execution
authority and duplicate the bash tool's sandbox/approval path. Coverage is therefore: foreground
`bash` only; background jobs, non-text results and results without a complete spill are untouched.

## Behavior

- Trigger: accepted, non-error, single-text-block result from a tool in `tools` (default `bash`),
  larger than `thresholdBytes`.
- Complete streams: when the renderer emitted a spill pointer, the hook reads that file (up to
  `maxRawBytes`); otherwise the rendered stream is complete and used as-is. If a pointer is
  `(unavailable)` or unreadable, the original result is kept.
- Output: a deterministic summary (rules v1) then one pointer line with the artifact directory.
- Artifact: `stdout.raw`, `stderr.raw`, `summary.txt`, `manifest.json` (SHA-256, bytes, lines,
  markers, stream identity, rule version) under `<state>/artifacts/<session>/<call>/`, mode 0600 in
  a 0700 tree.
- Failure: any storage, quota or summary-budget failure keeps the host's original result. No
  approval, no command execution, no new model-facing tool.
- Disabled (`enabled: false`): no hook and no artifact; model-facing behavior is byte-identical to
  the host's.

## Composition with the shipped spill policy

The `web` profile mounts `@deepseek-ai/dsh-spill-policy` with `maxInlineTokens: 12500`. This plugin
registers **without** `prepend`, so the waterfall order is:

1. this hook summarizes the original bash result;
2. `spill-policy` sees a result below its token cap and does not retain it again.

When this hook declines (small output, no complete spill, storage failure), `spill-policy` remains
the fallback retention path. The two systems do not share storage.

## Install

```sh
dsh plugin --profile web add github:Sulytwelve/dsh-tool-output-compress#v0.1.1
```

Restart the DSH process that serves the profile so it loads the new JavaScript. DSH's CLI does not
provide or manage a systemd unit; how that process is supervised is deployment-specific.

The row is inserted by the bundle patch with `tools: ['bash']` and the defaults below.

## Configuration (row `config`)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | false = no hook, no artifacts |
| `tools` | `['bash']` | allowlist of tool names |
| `thresholdBytes` | `16384` | compress above this model-visible byte count |
| `targetBytes` | `2048` | soft summary target |
| `maxSummaryBytes` | `8192` | hard cap; above it the original is kept |
| `maxRawBytes` | `67108864` | spill-file read cap (matches bash's 64 MiB spill) |
| `retentionDays` | `7` | artifact GC age |
| `quotaBytes` | `268435456` | artifact + pinned store budget |
| `stateDir` | platform state dir | override; `DSH_TOOL_OUTPUT_COMPRESS_STATE_DIR` also works |

`pwsh` is **not** a supported target: it is only used as a test environment on Windows. The product
target is Linux `bash`.

## Summary rules v1

Deterministic; the same streams, markers and rule version produce byte-identical output.

- anomalies first: fatal/error/warn/failed/panic lines, exception lines, stack frames, `File "...",
  line N`, `Caused by:`, denied/refused/timed out/not found;
- up to four continuation lines after an anomaly;
- head (3 lines) and tail (5 lines);
- sampled timestamp lines (at most 4);
- ≥3 identical anomaly lines collapse to one occurrence with `repeated ×N (lines …)`;
- overlapping ranges merge; every range is rendered as `stdout A-B: …` / `stderr A-B: …`;
- the original exit/signal/timeout/stop/sandbox marker lines are carried through verbatim;
- soft budget: least informative ranges drop first (timestamps, tail, head, extra anomalies); if a
  minimal summary still exceeds `maxSummaryBytes`, the original result is kept.

## CLI

```sh
dsh-tool-output-compress status        # hook heartbeat/self-test, artifacts, quota
dsh-tool-output-compress list          # recent artifacts
dsh-tool-output-compress show <ref>    # stored summary; --lines A-B --stream stdout|stderr for raw lines
dsh-tool-output-compress path <ref>    # raw file paths
dsh-tool-output-compress pin <ref> --for <owner>
dsh-tool-output-compress gc [--dry-run]
dsh-tool-output-compress bench --stdout FILE [--stderr FILE] [--exit N]
dsh-tool-output-compress doctor
dsh-tool-output-compress version
```

`doctor` reports writability, the loaded hook's self-test, quota and policy. `bench` prints raw and
summary bytes, line counts, estimated tokens (harness heuristic), ranges and elapsed time.

## Defaults: measured or calibrate-required

Measured on **SULY-HPED800** (Arch Linux, Node v26.13.1, DSH 0.2.2-rc.3) on 2026-11-18:

| Measurement | Result | Provenance |
|---|---|---|
| `journalctl -u dsh-web -n 800` (real run) | 125,414 B / 805 lines → 2,234 B / 11 lines; ~31,354 → ~559 estimated tokens; 9 ranges; 8.3 ms | [MEASUREMENTS.md](docs/MEASUREMENTS.md) |
| local test-run output | 3,495 B / 95 lines → 579 B / 4 lines; ~874 → ~145 estimated tokens; 2 ranges; 2.1 ms | same |
| `systemctl status dsh-web` | 905 B → 847 B (below the 16 KiB threshold; production keeps the original) | same |
| bash spill cap used as `maxRawBytes` | 64 MiB | installed `dsh-bash-local` default |

All other numbers are **calibrate-required**: threshold 16 KiB, target 2 KiB, max summary 8 KiB,
retention 7 days, quota 256 MiB, rules v1 thresholds. Token figures use DSH's 4 chars/token
heuristic and are **not** provider-tokenizer counts.

## Tests

```sh
npm test        # 7 files, 38 assertions, no dependencies
```

Covers: stderr identity and pointer parsing, stack traces, repeated warnings with a late error, a
single huge line, determinism, budget fallback, artifact hashes/line counts, quota failure, spill
reads, missing sources, allowlist/error/value/multi-block passthrough, CLI retrieval by line range,
GC/pin, and the guarantee that the hook path spawns no process and adds no tool.

Clean install used on the target host:

```sh
mkdir /tmp/dsh-t3 && tar -xzf sulytwelve-dsh-tool-output-compress-0.1.1.tgz -C /tmp/dsh-t3
cd /tmp/dsh-t3/package && node test/*.mjs
```

## Security and failure semantics

- Stores full command output, which may contain secrets: the artifact tree is owner-only
  (`0700`/`0600`); the command line is not stored. Pin/export explicitly to keep longer.
- No shell, no subprocess, no approval interception, no execution authority; static tests assert no
  `child_process` import in the hook path.
- A storage failure, quota exhaustion, missing spill, or budget overflow keeps the original host
  result — the hook fails open, never blocks the call.
- Expired artifact references are reported as `not found or expired`.

## Rollback

```sh
dsh plugin --profile web remove @sulytwelve/dsh-tool-output-compress
# restart the DSH process that serves the profile
```

Artifacts live under `~/.local/state/dsh-tool-output-compress/`; remove that directory to discard
them. No other plugin's data is touched.

## License

MIT — see [LICENSE](LICENSE).
