# Tool output compression

A deterministic post-execute hook for long shell output.

## Behavior

- Watches `tools/post-execute` for the tools in its allowlist (default `bash`).
- Above 16 KiB of model-visible text, reads the complete stdout/stderr (from the bash renderer's
  spill file when the stream was truncated), summarizes with rules v1, stores an artifact, and
  replaces the content with the summary plus one artifact pointer.
- Small output, non-allowlisted tools, failed results, structured results and results without a
  complete source are returned untouched.
- No model-facing tool is registered, no command is executed, no approval is involved.

## Composition

The shipped spill policy (`maxInlineTokens: 12500` in the `web` profile) runs outside this hook and
no longer retains results this hook already shortened. If this hook declines, the spill policy
remains the fallback.

## Configuration

`enabled`, `tools`, `thresholdBytes`, `targetBytes`, `maxSummaryBytes`, `maxRawBytes`,
`retentionDays`, `quotaBytes`, `stateDir` — see README for defaults and provenance. Numeric defaults
are calibrate-required unless measured there.

## Boundaries

- Linux `bash` only. `pwsh` was used as a Windows test environment, not a supported target.
- Background jobs (`job_output`) are outside the hook.
- Already-truncated streams with no complete spill are left as the host rendered them.
- The artifact tree holds raw output and is owner-only; it is not an export feature.
