# Changelog

## 0.1.0 — first working framework

Reimplemented from the archived `codex-project-memory` runtime, the
`codex-memory-design` archive and the uncommitted downstream patch found
installed in `bigfat投研项目astra`. Nothing was ported wholesale: every mechanism
kept below is here because it survived the audit, and every defect listed as
fixed has a regression test.

### Added after auditing the archived stores

The audit (`tools/audit-legacy.mjs`) was written to answer "is any of this true?"
before importing it, and it found defects in this framework as well as in the
data. Everything below came out of that audit.

- **Core memory: corroborated cross-project lessons are injected unconditionally.**
  The query-gated resident layer empties when a turn carries no term to match —
  exactly what happens when the user replies "继续" mid-task. A record now also
  reaches the prompt through a second section when it is domain-scoped,
  confirmed, not inferred, and corroborated by at least two distinct workspaces.
  Both sections share the one byte budget, so the guarantee re-allocates prompt
  rather than growing it, and `coreMaxRecords: 0` disables it.
- **Identity no longer includes the title.** The fingerprint hashed
  `kind + title + body`, but the title is a generated label: the audit found 28
  pairs of records with identical bodies and different labels. Those produced
  different identities, so the corroboration table never counted them and the
  same lesson learned in two projects could never be promoted to domain scope —
  which silently disabled cross-project accumulation. Identity is now
  `kind + body`.
- **Copies of a store are excluded from migration.** `.codex/project-memory-backups/`,
  `.dev-packages/`, `.eval-pilots/` and directories named backup/snapshot/copy/
  rehearsal hold a copy of another store. Importing them multiplied a lesson by
  the number of snapshots that happened to exist: the archived tree had 62
  exact-duplicate groups, one of them a single record stored 34 times. Of the 23
  stores the scanner found, 6 were live and 19 were copies. Exclusions are
  reported with a reason rather than dropped silently.
- **Repeated writes inside one store are merged.** A migrated store holds each
  record twice — once in `entries.jsonl`, once in `memory.sqlite3` — and repeated
  runs appended it more often than that. The de-duplication key deliberately
  omits the timestamp: writing the same assertion again is not new knowledge.
- **Tool-outcome events are filtered by body shape, not by `type`.** When a tool
  call failed the old runtime recorded `type: fact` with
  `admission.proof.kind: tool`, so the record arrived carrying the *strongest*
  evidence grade and `status: confirmed` while its entire content was
  `Tool call_00_... exited 1` — no command, no error, no fix. There were 98 of
  them across the live stores, and because importance is dominated by the
  evidence grade they would have outranked every real lesson in the digest.
  Filtering events by `type` alone could never catch them.
- **A selection file separates judgement from mechanics.** `--selection` takes the
  `legacy-memory-selection.json` the audit writes, so the importer obeys a list
  instead of re-deriving the funnel (which could drift from it). The file is plain
  JSON meant to be edited, identities are `(workspaceId, contentFingerprint)` so an
  entry cannot ambiguously name two records, a dry run reports what the list
  excludes before anything is written, and an empty list imports nothing rather
  than everything.
- **Boot acceptance, and the reason it needed inventing.** `--dump-config` proves
  the tree composes but not that the loader imports the bundle, and the import is
  exactly what failed before. Booting a profile whose `dbPath` overlay points at
  a file that does not exist yet makes successful loading observable: the file
  appearing proves the loader resolved the package by name, imported it, resolved
  both injected services against the real base tree, and ran `apply()`. That
  second point is not checkable from `--dump-config` — a plugin whose `inject`
  dependencies are absent from the tree simply never activates, silently.
- **`tools/preview.mjs`** prints what the model would actually see for a given
  database, directory and query, by driving the real assembly path. "Not in the
  store" and "in the store but not in the prompt" have different fixes and neither
  is visible from the tools alone.
- **The provenance line no longer repeats the evidence grade.** `explain()` began
  with the grade and `renderDetail` already labelled it, so every `memory_recall`
  spent tokens printing `证据: verified-file · 重要性 5.9 · verified-file · 6 天未使用`.
  Found by running the preview tool against the imported records.
- **`tools/audit-legacy.mjs`** reports external validity (does a referenced path
  or command still exist), internal consistency (exact and near duplicates,
  opposite-polarity pairs on one subject) and quality signals, and writes every
  record out as TSV for review. It answers with a funnel rather than a verdict,
  so the cost of each restriction stays visible, and it measures whether the
  records it recommends would actually be injected by calling this framework's
  own `importance` / `eligibleForResident` rather than assuming either way.

### Packaging

- **The published entry is JavaScript, not TypeScript.** `main` first pointed at
  `src/index.ts`, which worked for `link:` development and for the source tests
  but failed on a real tarball install: Node refuses to strip types for files
  under `node_modules` and throws `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
  `tools/build.mjs` now emits `lib/` and `main` points at `lib/index.js`.
- **The build has no build dependency.** It uses `node:module`'s
  `stripTypeScriptTypes`, so the zero-dependency claim covers the build as well
  as the runtime.
- **The build rewrites module specifiers itself**, because
  `stripTypeScriptTypes` leaves `./x.ts` untouched and a surviving `.ts`
  specifier resolves in the source tree but not for a consumer. The build fails
  when nothing was rewritten or when any relative `.ts` specifier survives.
- **Two new acceptance tests**: `tests/built.mjs` runs the built artifact under
  plain `node` with no flags and asserts export parity with `src/` plus identical
  record/recall/retire behaviour; `tools/verify-install.mjs` repeats the check
  from inside a real profile so that bare-specifier resolution out of
  `node_modules` is covered, which is exactly what the old entry broke.

### Kept

- Evidence-graded admission, but **automatic** instead of requiring an operator
  hash ceremony. The archived version promoted nothing in 139 work cycles
  because promotion cost a human review.
- L1 resident digest / L2 authoritative body separation.
- Two-stage deletion: retire (reversible) versus purge (deletes bytes).
- Event-driven staleness: expiry, review windows, source invalidation.
- Hard byte budgets with an explicit over-budget outcome.
- The downstream `identifier` ranking signal, recovered from the astra install
  and repaired (see below).

### Fixed, each with a regression test

- **Two tokenizers that disagreed.** The old JSONL path searched the record body
  and could match Cyrillic; the old SQLite path searched `summary` — which is
  `text[:150]` — and dropped every non-ASCII, non-CJK script. Migrating silently
  changed which memories were reachable, in both directions. One tokenizer now
  serves every path, and it indexes any script.
- **Fail-open visibility.** `visible()` read
  `not session or session_id in ('', session)`, so an empty session skipped
  filtering, and the documented manual workflow passed no session. Visibility is
  now fail-closed: an unidentified workspace sees nothing.
- **Ordering by random identifier.** The resident pack sorted candidates by
  `uuid4` string, so the records that reached the model were an arbitrary frozen
  sample and new memories had an `8/n` chance of appearing. Ordering is one
  documented function.
- **An uncapped identifier boost.** The recovered downstream patch ordered on
  `identifier_matches DESC` with no ceiling and accepted any span as an
  identifier, so plain English prose outranked BM25. The boost saturates, and a
  multi-word span counts only with a structural signal.
- **`INSERT OR REPLACE` against a cascading foreign key.** The archived upsert
  relied on the implicit delete being undone by the next statement. `ON CONFLICT
  ... DO UPDATE` is used instead.
- **Foreign keys enabled in one path and not the other.** On in the read path,
  off in migration. Now enabled in the single place that opens a connection.
- **Identity keyed without the workspace.** The first schema here made two
  workspaces reporting the same lesson collide — the exact observation domain
  promotion counts. Identity is now per scope.
- **Promotion that promoted nothing.** Corroboration moved a record to domain
  scope without changing its status, so it stayed a candidate and candidates are
  never injected. Two independent workspaces now confirm the record.
- **Promotion that left duplicates.** Promoting the second workspace copy left
  the first one live, so one lesson existed at two scopes. Copies are now merged
  and retired with a supersession link.
- **A question treated as an assertion.** Evidence grading judged the quoted
  passage alone, so `部署在 F 盘` inside `部署在 F 盘吗？` verified. The containing
  sentence is judged instead.
- **Silently demoting a migration.** Routing imported records through the
  recording path would grade every one as `inferred`, since a migration has no
  session to quote from. Imports are written directly and keep their grade.

### Deliberately not ported

The dual backend, the migration sentinel, the two recovery paths, the batch
import pipeline, the evaluation-profile and hash-pinned replay machinery, the
WebSocket capture bridge, transcript parsing, and the ten-way type vocabulary.
The archived design tree accumulated 334 files and 79 audit scripts against
2,665 lines of implementation while the memory store itself stayed empty; none
of that apparatus is reproduced here.
