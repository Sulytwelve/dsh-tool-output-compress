# Measurements

Benchmark host: SULY-HPED800 (Arch Linux, 4 GB RAM, Node v26.13.1, DSH 0.2.2-rc.3), 2026-11-18.
Command: `dsh-tool-output-compress bench --stdout <out> --stderr <err> [--exit N]`.

Token figures are **DSH's harness heuristic** (fixed 4 chars/token, `dsh-token-meter/estimate.ts`),
not the provider tokenizer. They are comparable to DSH's own context-pressure estimate and are
labelled as estimates everywhere they appear.

| Command class | Raw | Raw lines | Raw est. tokens | Summary | Summary lines | Summary est. tokens | Saved | Ranges | Elapsed |
|---|---|---|---|---|---|---|---|---|---|
| `journalctl -u dsh-web -n 800 --no-pager -o short-iso` | 125,414 B (incl. 194 B stderr) | 805 | ~31,354 | 2,234 B | 11 | ~559 | 123,180 B / 98.2% | 9 | 8.3 ms |
| local test run (`node test/*.mjs` loop) | 3,495 B | 95 | ~874 | 579 B | 4 | ~145 | 2,916 B / 83.4% | 2 | 2.1 ms |
| `systemctl status dsh-web --no-pager` | 905 B | 15 | ~227 | 847 B | 4 | ~212 | 58 B / 6.4% | 2 | 2.5 ms |

Notes:

- The `systemctl status` case is **below the 16 KiB production threshold**, so the hook would not
  transform it; the row shows what the rules would do if asked.
- The journal case is a real 800-line unit journal including startup lines; the test-run case is the
  plugin's own TAP output. Both are sanitized: no credentials, no hostnames beyond the local host.
- "Summary" columns include the pointer line for the production path? No: `bench` adds a fixed
  pointer placeholder to the after-token count (the CLI prints `after` including the pointer); the
  table's summary bytes are the summary text alone, the pointer is ~110 B.
- Negative or negligible savings are reported as measured; a command class below the threshold is
  not compressed at all.
- The complete raw bytes are stored in artifacts, so the line references in the summary remain
  recoverable with `show --lines`.

## Determinism check

The same stdout/stderr bytes and marker set produce byte-identical summaries under the same rule
version (test `summarize.mjs` "the same bytes and markers produce byte-identical output").
