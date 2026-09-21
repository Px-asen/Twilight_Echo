# Duplicate Detection

Duplicate detection is an inspection-only feature. The renderer can request a result through
`window.api.library.detectDuplicates()`, but that API exposes no merge, delete, tag-write, or
library mutation operation.

The **曲库整理收件箱** entry also exposes this read-only detection through an explicit button.
It shows numbered evidence groups, candidate paths and confidence, with 50 candidate rows per
page and an unreadable-hash count. Results returned after a library snapshot replacement are
discarded. Ignore/review decisions apply only to the candidate issue and evidence fingerprint;
changed membership invalidates them. Marking an issue reviewed never chooses a keeper, merges,
or deletes a file. Existing duplicate review also pages flattened members in groups rather than
rendering every member at once.

Evidence is applied from strongest to weakest:

1. Canonical local path and complete-file SHA-256 are exact evidence. SHA-256 is streamed only
   after the main process has resolved the track through the authorized local-library path policy.
2. A fingerprint is acoustic evidence only when the scanner explicitly labels it
   `evidence: 'verifiedAcoustic'`. The host does not currently generate acoustic fingerprints.
3. Legacy, missing-provenance, or metadata-derived fingerprints are `metadataCandidate` groups
   for human review. Technical and logical metadata follow the same review-only rule.

Every result includes non-destructive suggestions. Exact groups are `mergeSuggestion` records,
but they never select a keeper or an affected set; all other groups are `mark` records. A future
mutation flow must collect an explicit selection and confirmation in a separate authorized IPC.

## Local Library Review UI

The local music view exposes **Duplicate review** as an inspection surface. It groups candidates
by the evidence and confidence returned by the host, shows every candidate path, and labels a
merge suggestion as requiring human review. This screen deliberately has no delete, merge, or
tag-write command.

The same local selection toolbar opens **Edit tags** for one or more authorized local files. A
batch form previews before/after values before a separate write confirmation and only sends
nonblank fields; an unfilled or cleared field cannot erase existing tags. The
editor validates PNG/JPEG type and the 8 MiB client-side size limit before upload, while the main
process remains authoritative for MIME, dimensions, pixel count, authorization, backups, and
journal recovery. Results are presented per path as success, failed, rolled back, or not
attempted. Only confirmed successes refresh the renderer's cached title/artist/album fields.

## Performance Evidence

Run `pnpm run benchmark:duplicate-detection` to execute the TypeScript benchmark and write the
current 10,000-row unique and high-collision results to
`docs/audit-evidence/te-4.4-duplicate-detection-2026-07-18.json` plus its `.manifest.json`.
The runner performs three unmeasured warmups followed by twenty measured iterations per scenario,
emits every measured timing and p50/p95 values, and fails when either scenario exceeds its declared
p95 budget. The evidence records SHA-256 hashes for the production implementation, shared contract,
runner, runner contract, `package.json`, and `pnpm-lock.yaml`; the manifest additionally hashes the
exact evidence JSON. Provenance hashes canonicalize CRLF line endings to LF so the same checkout
authenticates on Windows and POSIX hosts. `pnpm run test:duplicate-detection-benchmark` rejects
stale or hand-edited evidence by recomputing those hashes and the manifest summary.

Required CI runs the tag/duplicate behavior suite, the evidence/benchmark contract, and a fresh
10k benchmark as separate sequential steps. `pnpm run benchmark:duplicate-detection:ci` is the
non-archiving live gate used by CI and `test:no-real-device`; do not run this benchmark concurrently
with other performance tests because shared-runner CPU contention would make latency evidence noisy.
