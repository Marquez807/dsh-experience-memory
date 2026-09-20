# Changelog

## 0.1.0 — unreleased

### Claims nobody was watching

A pass over every documented promise — checked against the code and against the
DSH host itself — found five statements that were not true. None was a lie told on
purpose; each was a claim that no test pinned, so nothing ever contradicted it.

- **The README said the two digest sections "together cap at five records".** The
  record ceiling is applied *per section* — the `.slice()` sits inside the section
  loop — so with the shipped configuration the real ceiling is 2 + 5 = 7, and only
  the *byte* budget is shared. The suite asserted that shared byte ceiling and never
  filled both sections at once, so the prose went unchallenged.
- **Four comments declared the model's tool surface to be four**, in files that
  register five tools. The tests said five all along; only the prose said four.
- **`cordis.patch.yml` described a domain fallback that does not exist** — a
  "directory name" level, and a `workspace:<id>` default. `inferDomain` ends at the
  git remote and then returns `''`, deliberately: inventing a domain from a folder
  name is what leaks one project's habits into every similarly named directory.
- **`/memory-audit` wrote four reports and named two.** The recommended catalogue
  and the full record dump reached the disk but never the operator, so the two
  reports a person most needs when deciding what to import were invisible.
- **The patch omitted `failStreakLimit`** while its own header states that a patch
  replaces the whole `config` object, which hid the effective value from the file
  that sets it.

The remedies matter more than the fixes:

- **`cordis.patch.yml` restates every key**, including the one it was silently
  defaulting.
- **Counts moved out of code comments.** A number written into a comment cannot be
  checked, so the counts now live in the README and the suite, which is where they
  can be tested.
- **`/memory-audit` lists every file it wrote**, enumerated from the same
  `AUDIT_FILES` record the writer uses.
- **A new `docs` suite makes the remaining claims executable**: the README config
  table is parsed and compared with `resolveConfig({})` in both directions, every
  config key must appear in the patch, only `coreMaxRecords` may be zero, the
  registered tool and command sets must equal the five names the README lists, the
  digest's per-section ceiling is filled from a real database and counted, and an
  audit must name all four reports it writes.

Host contracts were re-verified against the installed DSH sources rather than
assumed: `systemPrompt.context` and the `{agent, scope, signal}` it receives,
`agent.session.header.cwd`, `agent.id` being a `SessionId`, the
`agent/turn-stopping` event, `ctx.logger.warn`, the `defineTool` schema DSL, the
command service's `register`/`list`/`recordInput` semantics, and the `tool/result`
payload that `verified-tool` grading depends on. All hold.

### Wrap-up: what was verified, and two documents that were wrong

- **The installed artifact was checked against the source, not assumed to match.**
  The plugin is installed from a frozen tarball, so a source edit silently does
  nothing until it is repacked. The whole chain was compared — `git` HEAD → a
  fresh `lib/` build → the tarball → the directory a live profile actually loads
  — and all 17 modules are byte-for-byte identical. The tarball holds exactly the
  five documents and 17 modules that `files` promises, and no `src/` or `tools/`.
- **`pnpm verify` passes**: 12 suites, the build-freshness check, and the
  packaging contract.
- **Two documents were wrong.** Both the README and this file said the model's
  tool surface is four; it has been five since `memory_stats` landed. And the
  README still listed "a real model-driven loop has never been run" as a
  limitation, which had stopped being true — and was the wrong thing to want
  anyway, since that run is what found the `snapshotEvents()` defect. The
  live-turn recipe is now written down (README, "跑一次真实模型回合") so the next
  person repeats it instead of rediscovering it.

### Plug-and-play packaging and operator commands

- **`memory_stats`: a read-only census the model can ask for.** It reports how many
  records exist, how many are eligible for the always-on digest right now, what has
  been reused, and what was retired and why. No parameters and no writes, so it
  costs one small schema and answers questions the model otherwise could not —
  "what do you remember", and "did the thing I recorded actually reach me". The
  operator command `/memory-status` is the human-facing half of the same census.
- **One command installs it.** `dsh plugin --profile <name> add <tarball>` also
  reconciles `dsh.profile.bundles` against what is installed, so a package that
  declares `dsh.bundle` joins the layer stack by itself. Verified end to end: the
  profile's `package.json` gained the bundle with no manual edit, and booting that
  profile with no configuration at all created the default database.
- **Five operator commands**, registered on the same service `/compact` and
  `/goal` use: `memory-status`, `memory-preview`, `memory-maintain`,
  `memory-audit`, `memory-import`. All `recordInput: false`, so operator input and
  filesystem paths never enter the session transcript.
- **Audit and import are commands, not tools.** They scan arbitrary directories
  and bulk-write, so they stay behind a human trigger, and the model's tool
  surface stays small — five, of which four are knowledge operations and the
  fifth is a parameterless read-only census. `/memory-import` is a dry run unless
  `--apply` is given.
- **`/memory-preview` cannot disagree with what is actually sent**, because it
  calls the same `buildDigest` that `ctx.systemPrompt.context` does. Both moved
  into `src/digest.ts`.
- **The audit and census logic moved out of scripts into `src/audit.ts` and
  `src/census.ts`.** It is now covered by the suite — the funnel, duplicate
  detection, the prose-suffixed path rule, injectability — instead of being
  checkable only by running a script by hand against whatever was on disk. Two
  stale hardcoded counts in the report ("366 records", "62 duplicate groups" from
  an earlier run) became dynamic in the move.
- **The package no longer ships `src/` or `tools/`.** The runtime needs only
  `lib/`; the scripts are repository tools. That removes a defect class rather
  than fixing it: a shipped script importing `src/*.ts` cannot run from inside
  `node_modules`, which is exactly what `tools/import-legacy.mjs` and
  `tools/audit-legacy.mjs` did. The tarball went from 102 KB to 70 KB, and
  `tests/built.mjs` now asserts the packaging contract — including that no shipped
  module reaches back into the sources.
- **A failing digest or maintenance pass is no longer silent.** Both rendered
  nothing and said nothing, which makes a broken memory indistinguishable from an
  empty one. They now log, throttled per distinct message because the digest runs
  on every assembly.
- **Licence and metadata**: `UNLICENSED` with a `LICENSE` file, plus
  `repository`, `author`, `keywords`, and a `verify` script that runs the suites,
  the build check and the artefact acceptance in one go.
- **The README documents the development environment**, because a fresh clone
  cannot run the tests: the peer packages resolve through a `node_modules`
  junction into the DSH installation, which is gitignored.
- **`dsh-commands` is now a declared peer**, and `inject` requires it. It comes
  from `dsh-base`, the same bundle that provides `tools` and `systemPrompt`, so
  this adds no constraint a profile did not already carry.

### First working framework

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
- **The recall names where a verified claim came from.** `sourceRef` was supplied
  by the model, stored, and used by the evidence grader to decide between
  `verified-file`, `verified-tool` and `inferred` — and then never rendered
  anywhere. A reader could see that a record was `verified-file` but not which
  file, so the grade that decides whether the record is injected at all could not
  be checked. `memory_recall` now prints `出处: <source_ref>` when there is one.
  (`usage.turn` is in the same family but not fixable: a tool execution carries no
  turn number, so the column is structurally null rather than overlooked.)
- **Candidates can be reviewed.** `retrieve` supported an `includeCandidates`
  window from the start, but no tool exposed it, so a candidate — a claim recorded
  without a verifiable passage — could be created and then never listed again.
  `memory_recall` now takes `include_candidates`, which is the only way to see what
  was recorded but never verified, and the rendered detail carries the `待复核`
  note explaining what the record is waiting for. Without it a store fills with
  assertions nobody can act on, and the note written for that review had no reader.
- **Records can be given a decay window, so perishable facts stop being answered.**
  `expiresAt` and `reviewAfter` were only ever filled by the legacy importer, which
  meant two of the three retirement paths — expired, and review overdue — were
  unreachable for anything the plugin recorded itself. The mechanism was complete
  and untouchable. `memory_remember` now takes `expires_in_days` and
  `review_after_days`: an expired record stops being retrieved immediately and is
  retired by the next maintenance pass, while a record past its review date is
  only retired once the grace period passes with nothing having reused it. A
  record that has been reused survives its review deadline, because the window
  exists to notice what nothing needs rather than to punish age. Re-reporting the
  same claim with a fresh window is re-verification, and the new window replaces
  the old one. A window that has already closed is rejected at the call rather
  than stored to be retired on the next pass, which would look like the plugin
  losing data.
- **Boot acceptance, and the reason it needed inventing.** `--dump-config` proves
  the tree composes but not that the loader imports the bundle, and the import is
  exactly what failed before. Booting a profile whose `dbPath` overlay points at
  a file that does not exist yet makes successful loading observable: the file
  appearing proves the loader resolved the package by name, imported it, resolved
  both injected services against the real base tree, and ran `apply()`. That
  second point is not checkable from `--dump-config` — a plugin whose `inject`
  dependencies are absent from the tree simply never activates, silently.
- **The audit trail is now readable.** `usage` and `correction` are append-only
  tables that the framework wrote and nothing ever read, so "why did this record
  lose its place, or leave the pool entirely?" had no answer inside the plugin —
  it required opening SQLite by hand. `tools/preview.mjs` now reports usage
  totals, correction counts and the most recent retirements with their reasons.
  The tables are small and worth keeping; what they lacked was a reader.
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

- **The session log was read from a property that does not exist — so nothing this
  plugin promised actually worked in production.** Both readers used
  `agent.session.events`, a plain array that a real Session does not have; the real
  accessor is `session.snapshotEvents()`. In a live session that made the log
  empty, with two consequences: a verbatim user assertion was never graded
  `verified-user` (so nothing the user said face-to-face could become a confirmed
  record, and the store could only ever fill with candidates that are never
  injected), and the retrieval query was always `''` (so the "relevant to this
  turn" half of the resident digest never matched anything).
  The whole suite passed throughout, because every fixture hand-built the array
  that production objects do not have: the fixtures encoded the assumption rather
  than the contract. Found by running one real task through the headless app —
  the first live turn recorded a quote that was verbatim in the user's message and
  the plugin graded it `inferred`. Both readers now go through a single
  `eventsOf()` in `src/session.ts`, and every fixture builds the real shape, with
  the array form kept only as an explicitly-labelled compatibility branch.
  Verified live afterwards: the same quote grades `verified-user`, and a fact that
  exists nowhere in the environment was answered from the resident digest without
  any tool call.
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
