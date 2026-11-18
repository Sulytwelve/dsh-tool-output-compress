# Operations

## Artifact layout

```
<state>/artifacts/<sessionId>/<callId>/
  stdout.raw      complete stdout (from the spill file when truncated)
  stderr.raw      complete stderr
  summary.txt     the deterministic summary
  manifest.json   tool, ids, timestamps, stream hashes/bytes/lines, markers, ranges, rule version
<state>/pinned/<ref>-<epoch>/   explicit pins (copied, never GC'd)
<state>/plugin-loaded.json      hook heartbeat: version, tools, self-test result
```

State directory defaults to `~/.local/state/dsh-tool-output-compress` (Linux) or the platform local
state directory; `DSH_TOOL_OUTPUT_COMPRESS_STATE_DIR` overrides it. The tree is owner-only.

## Retention and quota

- `retentionDays` (default 7, calibrate-required): `gc` removes call directories older than the
  limit; directories touched in the last 10 minutes are treated as in-flight and kept.
- `quotaBytes` (default 256 MiB, calibrate-required): checked before every write; a full store runs
  GC once and, if still full, keeps the original tool result instead of writing.
- `pin <ref> --for <owner>` copies an artifact to `pinned/` with the owner recorded; GC never touches
  it. Release is manual (delete the pinned directory).
- Expired references: `show`/`path` report `not found or expired`.

## Diagnose

```sh
dsh-tool-output-compress status
dsh-tool-output-compress doctor
dsh-tool-output-compress list --limit 20
dsh-tool-output-compress show <ref> --lines 10-40 --stream stderr
```

`doctor` checks the state directory, the loaded hook heartbeat (`selfTest.ok`, tool allowlist), quota
usage and policy. `status` shows the same heartbeat plus artifact counts.

## Why a long output was not compressed

Check, in order:

1. the tool is in the allowlist (`tools`, default `bash`);
2. the result is not an execution error and has a single text block;
3. model-visible bytes exceed `thresholdBytes` (default 16 KiB);
4. each truncated stream has a readable, complete spill file (`[output truncated; full output: …]`);
5. the summary fits `maxSummaryBytes`;
6. quota has room.

Every declined case keeps the host's original result; the hook logs a warning only for readability,
budget and storage failures.

## Upgrade

```sh
# HMR hot-updates code inside an installed plugin, but DSH does not overwrite an installed package:
dsh plugin --profile web remove @sulytwelve/dsh-tool-output-compress
dsh plugin --profile web add github:Sulytwelve/dsh-tool-output-compress#v0.1.2
# restart the DSH process that serves the profile if the new module generation is not hot-loaded
```

Existing artifacts are not migrated; summaries carry `rule v1` and the manifest records the rule
version, so mixed versions stay distinguishable.

## Rollback

```sh
dsh plugin --profile web remove @sulytwelve/dsh-tool-output-compress
# restart the DSH process that serves the profile if the new module generation is not hot-loaded
rm -rf ~/.local/state/dsh-tool-output-compress   # optional: discard artifacts
```

The shipped spill policy remains active and continues to retain oversized results after removal.
