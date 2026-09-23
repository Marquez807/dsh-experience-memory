# Changelog

## 0.2.0 — 2026-09-23

This version replaces how a lesson is delivered just before an action, and is the first version
whose effect is measured rather than argued. **It is a behaviour change: a record that does not
declare where it applies (`recall_for`) is no longer delivered just before a tool call** — it still
reaches the per-turn digest and `memory_recall`, it still scores and retires normally, but it no
longer interrupts a call on a hunch.

What forced it is measured in `docs/DELIVERY-GAPS.md` §12: the previous rule inferred applicability
from shared vocabulary and fired a hint on **57% of 15,383 real tool calls**, with **5 of 47**
audited deliveries actually about the call (10.6%) and **68.7%** of them matching a word that
appears only in the record's `body` and not in its own rule. §13–§15 are what was tried and thrown
away; §19 and §22 are the two experiments that say the replacement works.

Below, entries are grouped by concern rather than laid out strictly by date: what the replacement
does and what it cannot do first, then the incident and the safety work, then the two mechanism
changes in the order they landed. Three further entries belong to this line's first half — the
delivery table, the failure-shape counter, and just-in-time delivery's first version — and they are
listed under **0.1.0** because that is where they shipped. They are named here so the causal order
stays visible: measure first, only then replace.

### A second scenario: a placement rule, and the same result in a different shape

The first experiment covered one shape of knowledge — what a config file must *contain*. This one
covers another: where a thing must *go*. The convention exists only in a sentence the user says
(「服务的示例配置一律放在 `conf/samples/` 下面，不要放在仓库根目录，也不要放在 `src/` 里」)
and the repository never mentions `conf/` at all — not in the README, not as a directory.

The task is "add a redis sample config". Judged from the filesystem alone, by walking the whole
workspace and classifying by path:

| arm | put in `conf/samples/` | 95% Wilson |
|---|---|---|
| no memory | **0 / 6** | 0.0% – 39.0% |
| with the lesson | **6 / 6** | 61.0% – 100.0% |

Fisher's exact test, two-sided: **p = 0.0022** (including a smoke run, 0/6 versus 7/7, p = 0.0006).

The failure is as clean as the success: **all six control runs wrote a file, all six to `config/`** —
the model's own default for where sample configs live — and all six treated runs wrote to
`conf/samples/`. So the difference is not whether it acts; it is where it puts the thing. Pooled
with the first experiment: **0/24 without the lesson, 20/24 with it**, p far below one in a million.

That makes the effect two scenarios deep — config content and file placement, single turn and cross
session — rather than one. And the boundary it draws is worth stating again, sharper now: the effect
holds for **knowledge that lives in a conversation and not in a file**. If the repository says it,
the model reads it; if nobody said it there is nothing to recall. What this framework is for is
exactly the class of things with no second place to look, which is what separates it from reading
the documentation.

One judge in this run was wrong and the transcript caught it: it enumerated `conf/`, `conf/samples/`,
the root and `src/`, and reported all six control runs as "no file written" while the model had
written to `config/` — a wrong place, not a missing file. `tools/verified-user-ab/rescore.py` now
walks the whole workspace and classifies by path. The general lesson is recorded in the store and in
that folder's README: **a judge that enumerates where it expects things to appear reports "appeared
somewhere else" as "appeared nowhere"** — and the first is a wrong answer while the second is no
answer, so conflating them produced the opposite conclusion.

### The delivery bar re-based: coverage of what a lesson could prevent

The pre-registered bar asked the new rule to cover ≥15% of the corpus's tool failures. Three
measured things say that number cannot be met here and should not be chased:

1. **The denominator is wrong.** Of 442 failures in the call corpus, **83% are the harness's own
   guard refusing a call and stating the fix in the error text** (`file has not been read` alone is
   49%). No stored lesson can prevent a failure the tool already refuses and explains.
2. **The numerator is unmeasurable.** Judging "which lesson should have prevented this failure"
   needs a semantic call this framework refuses to make. The cheap proxy — shared words between a
   call and a record — assigned a data-source independence rule to a "tool call aborted" failure.
   It is the same defect that retired the old delivery rule, recurring one layer up.
3. **What is left is not a knowledge problem.** Of the 75 attributable failures, most are
   environmental traps (`rg` walking into `System Volume Information`, `svn.apache.org` resolving to
   a non-public IP) and slips, not forgotten rules.

Covering the 83% would mean anchoring "read the file before editing" on `edit`, which is 28.3% of
all calls — fourteen times over the ≤2% trigger budget, and it is discipline rather than knowledge,
which is exactly the magnet class this version's rewrite removed.

So the clause is retired and replaced with the question it was standing in for: **does this class of
mistake still happen after the lesson was written?** That is answerable from what is already here —
`failure_shape` counts occurrences by shape with their times, `delivery` records what was shown, and
`tools/prevention-ledger.mjs` produces the four-way account. No new metric is needed; the number
being chased simply cannot be measured. Re-runnable: `tools/failure-anatomy.mjs`,
`tools/coverage-honest.mjs`, `tools/coverage-reach.mjs`.

### The store was emptied by an experiment: recovered, and three guards put in place

An experiment's per-trial wipe resolved `DSH_HOME` to the live store and cleared `record` and
`delivery`: **271 records became 0**. An operational mistake, not a defect in the plugin. What
survived made recovery possible — `usage`, `correction`, `failure_shape` and `record_fts` were
untouched, and the correction log still named every lost id.

Recovered in two disciplined steps, because an invented record would be worse than the loss: a real
snapshot of this workspace's store taken 2026-09-22 11:17 supplied 220 records by their own ids, and
63 more were replayed from the session logs using the exact arguments the model originally passed to
`memory_remember` — exact title match only, re-graded through the same `remember()` call, no fuzzy
matching. Final state: **285 records, 181 confirmed, no dangling `superseded_by`, and the FTS index
rebuilt to match the table exactly** (it had 55 rows pointing at records that no longer existed,
which would have surfaced as stale search hits).

Not recoverable, and stated rather than glossed: the 20 delivery rows, and the record ids themselves
— ids are random strings, so hand-written references to them are now dead. The two records that
carried an anchor block went with them, and no logged `memory_remember` call carries `recall_for`
(the field did not exist when they were written), so there was nothing to replay for those.

Three guards, each verified in both directions:

- **`tools/snapshot.mjs`** — a consistent copy via SQLite's own `VACUUM INTO`, so the WAL does not
  have to be hand-copied while another process writes. It prints the absolute path it is about to
  touch before it touches it.
- **`tools/recovery/`** — the restore and reindex scripts used above, kept in the repository so the
  next recovery is not improvisation. `restore-from-backup.mjs` refuses to write anything it did not
  read from a real call's arguments.
- **The startup log line** (below) — the blind spot is that an *empty* store and a *wrong* store look
  identical from outside: both answer every query with nothing.

The store also gets a snapshot before and after any bulk write. That this recovery was possible at
all was luck — another session happened to have left a backup. Luck is not a process.

### Say which store this process opened, and how much is in it

Activation now logs one line: the resolved store path, the record count, how many are confirmed, and
how many carry an anchor —

```
experience-memory: store <path> — 285 records, 181 confirmed, 9 anchored
```

A store that is unexpectedly empty then reads as a stated fact rather than as lost memory, and a
path that is not the one the operator expects is visible immediately.

### Maintenance flags a record whose cited file is gone, and two tools were miscounting

The `verified-file` grade proves the quoted passage is *in* a file at the moment the record is
written. It does not promise the file will still exist — files get renamed, moved, cleaned up. And
when it is gone the record turns actively harmful: a real model asked to trust it looks for the
cited file, fails to find it, and throws the whole record away rather than follow a citation it
cannot. Measured on this store: **22 of 191 confirmed records cited a file not on disk**, and 106
more cited a report or log rather than a place a rule can be read off.

Maintenance now checks, on the same bounded, cursor-resumed batch the rest of the pass scans. A
`verified-file` record whose workspace-relative `source_ref` no longer resolves gets a note naming
the missing file; a record whose file came back gets the note cleared with its cause. **Flagged,
never blocked** — a cited file may legitimately not exist yet (a record about something the lesson
precedes) or may come back from a restore, so this warns rather than refuses. Eleven assertions pin
the branches that matter.

The same session found two of this repository's own tools disagreeing about how many records carry
an anchor: one said 64, the other said 9 declared plus 0 derived. The first collapsed two different
things — a *declared* anchor, which is what the delivery gate uses, and a *derived* one, which only
fires when `decideForCall`'s `derivedAnchors` is switched on and the production path does not switch
it on. The second never asked for derived anchors at all. Both now report the same three-way split
and say which of the three can actually fire: **163 eligible — 10 declared (these fire), 54 derived
(off by default), 99 silent.** The label matters more than the number: a count that mixes an anchor
that works with one that is switched off cannot support a claim.

Also fixed a flaky assertion this exposed. "The first pass retires what has aged out" asserted a
retirement on one bounded pass over randomly-ordered ids, so it failed about one run in N when the
aged records did not sort into the first three. The suite's own note above `drainMaintenance` had
already recorded exactly this fragility. Five consecutive runs green after the change.

### The A/B that worked: 0/12 without the lesson, 9/12 with it

Six rounds of trying to build a scenario where a lesson could be shown to prevent a mistake
produced four non-informative ones. The reason they failed is now understood and written down: if
the repository states a convention the model reads it and memory is not needed, and if the
repository states nothing there is no honest passage for a record to quote. The cell that remains
is knowledge that lives in a conversation — what the user said — which is the `verified-user`
grade.

That scenario, run 12 times per arm with the outcome judged from the file:

| arm | fully correct | 95% Wilson |
|---|---|---|
| no memory | **0 / 12** | 0.0% – 24.3% |
| with the lesson | **9 / 12** | 46.8% – 91.1% |

Fisher's exact test, two-sided: **p = 0.0003**. The control arm wrote a deployable-looking file
every time (695–1751 bytes) and got the convention wrong every time; the treated arm got it right
nine times and, in three, never wrote the file at all because the edit guard stopped it — the same
class of friction as 49% of the failures measured in `docs/DELIVERY-GAPS.md` §15. Looking only at
the runs that did write the file: 12/12 wrong without the lesson, 9/9 right with it.

The task required the vault path, the namespace, **and their order** — the order was added as an
adversarial condition, since a memorised generic template writes it the other way. Session logs
show the model calling `memory_recall` on its own, before its first write, in every correct run,
with the anchored hint arriving as well. So this is not evidence that the just-in-time gate carried
the result; it is evidence that the framework's whole chain works on the class of knowledge it can
honestly hold, and it is the first time the anchored hint was seen landing in a real model turn.

What the first run left open was the whole "this session records it, a later session uses it" path —
the record had been seeded. So the same scenario was re-run with the record produced the way the
framework is meant to produce it: a first session hears the sentence and calls `memory_remember`
itself (grade `verified-user`, anchor `path:deploy.yaml`), then a **new** session on the same repo
gets the task with no hint that any convention exists.

| arm | fully correct | 95% Wilson |
|---|---|---|
| no memory | **0 / 6** | 0.0% – 39.0% |
| with the lesson | **5 / 6** | 43.6% – 97.0% |

Fisher's exact test, two-sided: **p = 0.0152**. Pooled with the seeded run above: **0/18 versus
14/18, p = 0.000002** — and among the runs that actually wrote the file, 18/18 wrong without the
lesson and 14/14 right with it.

One design error is worth recording because it looked like a framework failure: the first version
ran the two sessions in different directories and the second session could not see the record.
Workspace identity is derived from the path, so a workspace-scoped record is deliberately not visible
in another directory. Two sessions on the same repo is the real shape; two sibling directories is
not.

What it does not do is change the coverage account, and that account is now closed as
unmeasurable rather than unmet — see *The delivery bar re-based* above.

### The quote has to state the rule, not merely come from the same file

`memory_remember`'s `quote` parameter now says what a real model checks. The wording is the model's
own finding: given a claim about a deployment vault and a quote that only says how to start the
server locally, it answers *"the cited evidence does not match the claim"* and discards the record.
The `verified-file` grade proves the passage is *in* the file; it cannot prove the passage is
*about* the claim — that is a semantic judgement, and this framework deliberately makes no LLM
calls.

So the parameter asks for the sentence that says the thing (a rule, an order, a value, an error
message), not the paragraph the writer happened to be reading, and the tool's own description says
what to do when no such passage exists: record the `inferred` version and say what is missing. There
is no memory-writing skill in this workspace, so the tool description is the only channel a
requirement like this can travel down. The per-turn fixed cost is untouched — that is the resident
204-byte line, not a tool description.

Measured first, which is why the requirement is written that way and not another: same lesson, same
content, only `source_ref` changed — once at a README that exists, once at a file that does not —
four real turns each. Both arms failed to use it. The second arm's reason was the file being gone;
the first arm's was the finding above.

### Anchors, measured: path not name, and an A/B that did not reach significance

Three follow-ups to the delivery rewrite, all measured rather than argued. Details and the
re-runnable commands are in `docs/DELIVERY-GAPS.md` §13–§14.

- **A `path:` anchor now means the whole tail of the path.** Anchoring a lesson about one
  project's `lib/tools.js` by *name* made it fire **508 times** in 15,896 calls, because three
  unrelated files in this workspace are called `tools.js`. With the relative path kept
  (`repos/dsh-quant/lib/tools.js`) the worst record dropped to **83**, and the delivery rate fell
  from 6.34% to **1.18%** — both inside the pre-registered bar. `deriveAnchorFromSourceRef` and
  `tools/backfill-anchors.mjs` now carry paths, and a bare name still matches by name because
  that is what a hand-written `recall_for: ['path:service.yaml']` means.
- **`tools/backfill-anchors.mjs`** proposes anchors for records that never declared one, from the
  files their declared fields name, resolving each against the real workspace. It writes a
  proposal file and measures itself; `--apply` is separate. On this store it can reach **11 of
  191** records — enough for 1.18% delivery, 83 collisions, and **2.71% failure coverage**, which
  misses the ≥15% coverage bar. Most records here are about situations, not files, and no
  automation invents a `command:` anchor for them. **Not applied to the live store.**
- **A real-model A/B was run and did not reach significance.** Isolated home, a fresh workspace
  per trial, a fresh copy of the live store, correctness judged from the file rather than from
  the model's account. First round: both arms 4/4 — because the workspace README stated which
  config section takes effect, so the trap did not exist. Second round, that line removed:
  **1/5 without the lesson vs 3/5 with it** (Fisher p≈0.52). Directionally as expected,
  statistically nothing. Recorded as a negative result, not as evidence that lessons prevent
  mistakes.
- **What the A/B did show**: with no answer readable in the workspace, 4 of 5 control runs did
  not even write the file, and in the treated runs the anchored record was delivered (visible in
  the isolated session log) while the model also called `memory_recall` on its own. The ranking of
  what to fix next is unchanged and now documented: the model rarely asks memory before acting —
  9 `memory_recall` calls in 15,383, and only 1.8% of failures preceded by one.

### Just-in-time delivery stops guessing: the record declares which call it applies to

The previous version decided whether a lesson applied to a tool call by inference: pull
identifier-shaped tokens out of the call's arguments, look for a record that mentions one, prefer
the record that mentions most. It was replayed over **15,383 real tool calls** extracted from this
workspace's own session logs and audited by hand, and it does not work:

- it delivered a hint on **57%** of calls;
- a stratified sample of **47** real deliveries, read one by one, found **5** that were about the
  call (10.6%). The rest fired on coincidence — the PowerShell column header `AutoSize` linked a
  call to a lesson about output truncation, `Encoding` in a URL fetch linked to one about chunked
  decoding, `lifecycle` in a grep linked to one about compatibility shims;
- **68.7%** of those deliveries matched a token that appears only in the record's `body` prose,
  never in its own `trigger`/`failure_mode`/`lesson`;
- and it is not a tuning problem. Loosening the rule to catch more of the right records made the
  noise worse; tightening it far enough to remove the noise left scenario recall in single digits.
  In the loosest configuration only **14 of 25** hand-written "what should fire here" cases had the
  right record among the candidates *at all*, so no ranking change could have saved them.

What replaced it keeps the question and stops inferring the answer. A record now **declares** the
calls it applies to, as anchors:

- `path:<file name>` — the call names that file (extension included: `NOTICE-signals.md` does not
  satisfy `NOTICE-masterdata.json`);
- `tool:<name>` — the call is that tool, exactly;
- `command:<token>` — the command line contains that token.

They are supplied as `memory_remember`'s new **`recall_for`** parameter and stored inside the
`trigger` column under a `--- anchors ---` marker, so the schema needs no new column and the
resident digest still renders only the prose half (`splitTrigger`).

**A record that declares nothing is never delivered just before a call.** It still reaches the
per-turn digest, still answers `memory_recall`, is still scored for reuse and still retires
normally; what it loses is the right to interrupt a tool call on a hunch. That is the trade stated
plainly: silence costs a hint that might not have been read anyway, while the old behaviour cost the
credibility of every hint. Measured on the live store the day this landed: **0 of 159 deliverable
records declared an anchor**, so the honest immediate effect is *fewer hints, not more* — and
`node tools/anchors.mjs` prints that split for any store.

Also in this change:

- **`src/criteria.ts`** — the decision, as a pure function of (store, call), so `tools/replay.mjs`
  can re-run it offline on real calls. `src/precall.ts` keeps the rendering and the entry points.
- **`src/anchors.ts`** — parsing, matching, and the prose/anchor split.
- **Derived anchors, measured and off by default.** A record's `source_ref` often names a code file,
  and "the lesson is about this file" can stand in for an anchor — but only when the call is about
  to *change* that file (`edit`/`write`). 54 of 159 live records qualify, and enabling it delivers
  on 11.41% of calls with a worst-case **247** collisions on a single record: *"the record mentions
  this file"* is not *"the record is about this change"*. It stays behind
  `decideForCall(..., { derivedAnchors: true })` and `tools/replay.mjs --judge derived` until
  somebody brings labelled data showing it does not make precision worse.
- **Tooling, checked in so the numbers can be re-derived**: `tools/session-calls.py` (session log →
  compact call log), `tools/replay.mjs` (a judge over that corpus, with the four acceptance
  measures), `tools/anchors.mjs` (anchor coverage of a store), `tools/scenarios.json` (25 labelled
  "what should fire here" cases), `tools/labeled-sample.jsonl` (the 47 audited deliveries).
- **A new test suite** (`tests/anchors.test.ts`, 18 in total) pinning the anchor contract, including
  the assertion that a record which declared nothing stays silent. `tests/delivery.test.ts` now
  asserts the same through the real tool waterfall, and `tests/precall.test.ts` swaps its
  document-frequency-ceiling case for one showing that three records merely *mentioning* a script
  attach nothing while the one that declares it arrives.
- **Literature that shaped this**, with the caveat that only the first two are peer-reviewed:
  LongMemEval (ICLR 2025) — generate retrieval keys from the memory itself, not from the query;
  MemoryAgentBench (ICLR 2026) — every current method is weak at conflict resolution and commercial
  memory stores lose information at write time; TRACE — Mem0-style memory still leaves 57.5% of
  applicable preferences violated, which is "accessible ≠ obeyed" (dated after this machine's clock,
  recorded as a direction, not as evidence). Sources and what was and was not borrowed are in
  `docs/DELIVERY-GAPS.md` §12.7.

**Not verified by this change**: whether a model writes useful anchors (there are none in the store
yet), and whether any hint prevents a mistake. §12.8 lists both.

## 0.1.0 — 2026-09-23

> **The date is the version-cut date, not a content window.** This version's content spans
> 2026-09-20 to 09-23 — the framework over those days, the delivery line's measurement on 09-23.
> The `v0.1.0` tag points at the parent of `cd76f46`: **the state just before the delivery rule was
> replaced**, which is the behavioural boundary between the two versions. So `v0.1.0` is exactly
> "everything before 0.2.0's behaviour change", and both tags were cut on the same day.

The framework as designed and built: graded evidence that refuses to call a claim verified unless a
passage backs it, a resident digest that is not allowed to lie about what it holds, retrieval that
separates an identifier hit from a lexical coincidence, a lifecycle that ages out what nothing is
using, a turn harvester calibrated on real logs before it was trusted, migration tooling that
audits before it imports, and packaging with zero third-party runtime dependencies. By the end the
suite had reached eighteen test suites pinning every claim above.

Three entries below belong to just-in-time delivery and are this version's half of that line: the
delivery table (*Ask whether a lesson worked…*), the failure-shape counter (*The framework can now
see what it keeps failing to learn*), and just-in-time delivery's first version (*The lesson now
arrives at the call it is about…*). They are **0.2.0's premise, not its features** — kept here
because this is where they shipped, and named in 0.2.0's lead so the causal order is visible:
**measure first, only then replace.**

### The README says what a reader needs, and the process moves out of its way

Asked for directly: the README had become a process record, and the Chinese and English parts were
mixed rather than being one document in two languages. The user chose the shape: Chinese stays the
primary language, and the first step was one real bilingual pair instead of one mixed file.

The opening also carried a line of development history — how many archived installations and
historical records the plugin was distilled from. That is about the author's process, not about the
plugin a reader is deciding whether to install, so it is gone; what replaced it is the three facts
a reader actually acts on: 204 bytes per turn, zero third-party runtime dependencies, five tools and
seven commands with no configuration.

What changed:

- **Two audiences, two files.** `README.md` now carries what a reader needs in order — what it is,
  how to install it, the four surfaces, what it does, how to operate it, migration, the model's
  view, the limitations — and `docs/DEVELOPING.md` carries the build, packaging, boot acceptance,
  the real-model turn, the test inventory and the development environment. The development text is
  moved, not deleted; the README links to it.
- **A contents table that answers "where do I go", not a list of headings.**
- **One numbering scheme**: `1`/`2`/`3` for the three stages, with `1.1`–`1.3`, `2.1`–`2.2` and
  `3.1` beneath them, and a separate `## 操作` for scope, the mode switch, tools, commands and
  configuration.
- **A real bilingual pair**: `README.md` in Chinese and `README.en.md` in English, each linking to
  the other. The English file is a full mirror, not a summary.
- **A stale claim fixed**: the surfaces table still said five slash commands. There are seven, as
  the command table forty lines below it, `COMMAND_NAMES`, and `tools/verify-install.mjs`
  (`mine.length === 7`) all said — the prose was the only place that had not been updated when
  harvest review and the repeat-failure report were added.
- **A broken table fixed**: a blank line had split the config table in two just above
  `failureTracking`, which the old parse happened to tolerate.

The opening had also drifted into a reader-hostile shape: 829 lines, 49 headings, installation
followed immediately by "installation (development details)", and the section explaining what the
plugin *does* starting at line 200. It is 628 lines in Chinese and 513 in English now, with nothing
deleted — only moved, reordered and de-duplicated.

Because the docs suite reads its claims by exact heading text, five anchors moved with the
sections and are now written once in `SECTION_ANCHORS`: `## 配置`, `## 模型的体验（Model
Experience）`, `### 它挂了四个表面`, `#### Token effect`, `## Known Limitations and Deferred
Work`. Renaming one is one edit there instead of five scattered strings, and a heading the suite
cannot find still fails rather than silently checking an empty string.

The suite now also reads the English mirror: it asserts that both files have the same section
count at the same levels in the same order, that both list the same tools and commands, that both
config tables document exactly the keys the code accepts, and that both state the suite count, the
digest ceiling and the audit report names. A mirror that quietly loses a tool is the same defect
as a table that never had it.

`README.en.md` is now in `files`, so it ships in the tarball; `tests/built.mjs` pins that list.

Documentation only: no runtime behaviour changed. `pnpm verify` passes — 16 suites, 864 assertions.

### A mode can be left without memory, and only the plugin can arrange that

Asked for directly: a model-test mode that has no memory. The obvious place to switch it off is
the mode, and that is where it cannot be done. A mode is an agent preset, and a preset can only
*add* rows — its `disabled` flags affect nothing but its own list. This plugin is installed by the
profile, so its tools and its digest reach every preset in the process; the user's own
`bigfat-value` preset already carried a comment saying exactly that about a different plugin.

So the switch lives here, keyed by preset id: `disabledPresets` (empty by default). Listed modes
get no digest, no "look before you record" instruction, no just-in-time hints, no harvesting and
no failure counting, and the memory tools refuse with the reason in the message.

Two details a plausible-looking implementation gets wrong:

- **Which preset a session is in is not just a header field.** The header records what the
  session *started* with, and a session may switch mode while blank — the switch is an
  `agent-preset/selected` event. Reading only the header would leave memory switched off in a
  session the user moved *into* an ordinary mode; reading only the events would miss every
  session that never switched. Both are read, events last.
- **Hiding the tools is a separate mechanism, and it belongs to the mode.** `tools.restrict()`
  refuses to run outside a scoped context, on purpose — a context-global restriction would mask
  every agent's tools. A preset *is* a scope, so the mode ships a fifteen-line local plugin that
  denies the five memory tools for its own agents. The two layers are independent: the config
  decides "does not inject or record", the preset decides "not in the tool catalogue".

Maintenance still runs in a disabled mode, deliberately: it is store hygiene that no session sees,
and skipping it would let a memory-free mode quietly stop the whole store from aging out.

Verified with five break-tests, one per enforcement point, each proved to fail its own assertion:
digest, standing instruction, tool refusal, harvest, and the events-over-header rule. The digest
case had to be made honest first — an empty digest in the listed mode proves nothing unless the
same session shape gets a non-empty one in an ordinary mode, which needs the query and the
evidence both present in the fixture.

### Ask whether a lesson worked, not just whether it was stored

Counting records and recalls shows storage and use. It does not show effect, and "is experience
preventing mistakes?" is an effect question. The failure table now remembers *when* the recent
occurrences happened (schema 5, a bounded list of the last 20), which makes the question
answerable in one comparison per shape: the record that claims to cover it has a creation time,
and the repeats after that time are the ones it failed to prevent.

Measured on this machine's own logs: the record saying "this box cannot fetch web pages, the
domain resolves to a proxy IP" was written at 21:05. The three `web_fetch` failure shapes ran at
0.54, 0.34 and 0.14 per hour before it, and at **0.00, 0.12 and 0.00** after. That is the first
hard evidence here that a record prevented anything, and the mechanism is the intended one: the
agent stops spending calls on something that cannot work.

Getting a flag out of it required resisting the obvious version. "The shape happened after a
record matched it" would fire constantly and be wrong, so three conditions must all hold:

- the keyword match is **complete**, and at least two words long — one shared word is a
  coincidence, not a claim;
- the record **predates** the repeats by more than an hour, so a record written a minute ago is
  not blamed for the next slip;
- there are **at least three** repeats after it — the data is a rate, and one repeat is noise.

All three are asserted in both directions, and each was broken on purpose to watch its assertion
fail. One of those break-tests found a test that was passing for the wrong reason: the
partial-match fixture shared *zero* keywords rather than one, so relaxing the completeness
condition changed nothing.

The command's own wording keeps it a question rather than a verdict: the record may be right but
arriving too late, or right about something adjacent, and the reader decides.

### The framework can now see what it keeps failing to learn

A question from the person using it: *"this kind of mistake keeps happening and never settles
into experience — doesn't that mean the memory framework has a hole?"* It did, and the hole was
measurable rather than philosophical. Seven days of this harness:

| | |
|---|---|
| tool failures | **358**, across 63 sessions |
| `edit` refused: file not read | **143** (5 sessions, 2 workspaces) |
| `edit` refused: file changed since read | 35 |
| `edit`: `old_string was not found` | 33 |
| `web_fetch` failed / non-public IP | 25 + 16 |
| of the 16 commonest shapes, how many the store covered | **1** |

Every one of those failures had been *read* by the framework and thrown away on purpose:
`harvest.ts` skips the agent's own tooling, because "the agent used its own editor wrong" is not
a lesson about the project. That rule is right for *should this become a lesson* and wrong for
*is this happening at all* — and no layer was asking the second question. Finding the hole took
a person going digging, which is the actual defect.

What changed is only the observation layer, deliberately:

- **Schema 4** adds `failure_shape` (workspace, tool, normalized shape) with a count, the
  sessions it was seen in, and one truncated real sample. Counted at turn end, on the newest
  turn the plugin already reads for the harvester, so it costs no extra log scan.
- **`/memory-gaps`** reports the shapes that repeated, how often, in how many sessions, and how
  close the store comes to them. The overlap is reported as a **score with the nearest record,
  never as "covered"**: the error text is English, the records are mostly Chinese, so a record
  that genuinely covers a failure can score zero. A boolean would have turned that into "nothing
  covers this, write one", which is the class of check this whole audit was about.
- **Nothing counted is injected, and no record is written from it.** Counting is automatic;
  judging is not.
- The agent's own tools are **not** filtered out of the count, which is the one place this
  module deliberately parts company with `harvest.ts`; a test pins that, because inheriting the
  filter would hide the 64% of failures that matter most.

**The obvious design was rejected on these numbers.** A harvester that wrote a lesson from
repeated failures would have produced records saying "read the file before editing" — which the
error message already says (100% of the top shape's occurrences carry their own remedy), for a
class of failure where the harness's edit tool is already the guard. The one detector aimed here
had been calibrated once before and rejected (71 hits, 5 real); this data **supports** that
rejection rather than overturning it. So the numbers are written down instead, in the README's
deferred-work section, together with what a future attempt would have to beat.

**Deferred with a pre-registered bar**: hinting before a call based on a record's `trigger`
("when this applies") field, which is fully populated and looks ready to use. Measured: matching
"the tool about to run appears in some record's trigger" fires on 949 of 13,198 calls (7.2%) and
covers 62 of 358 failures (17%) — but its largest source is a misfire (`grep`, 623 firings, 3
failures) while the useful one is `web_fetch` (193 firings, 49 failures). Telling "this is about
using the tool" from "this merely mentions the tool" needs semantics this plugin does not buy.
To be built at all it must, on the same window, fire on ≤2% of calls, cover ≥15% of failures,
and no single record may contribute ≥300 misfires.

Two smaller things, both from the same list of 358: our own `experience-memory: a
domain-scoped record needs a resolved domain` was the tenth most frequent failure (10 times, 3
sessions) and stated the problem without the remedy — it now names the remedy. And the docs test
turned out to compare the code against a **hand-written list of command names**, the same defect
its config-key check had already been fixed for: adding a command failed only if you also forgot
the mirror. Both lists now come out of the README's own tables.

### The lesson now arrives at the call it is about, not at the turn before

The case that started this: a record saying *confirm Steam is logged in before launching
Bannerlord*, confirmed, with a real file as its evidence. In the session that produced it, it
was injected on nine of fifteen turns and **absent on the turn the user typed "开始吧"** — the
turn the work started. The agent launched, the run was wasted, and the memory was not at
fault: it was the delivery that was.

Two mechanisms, and both were measured against that session's log (444 tool calls) rather than
argued for:

1. **The turn's query includes what the agent is doing.** It was the last two user messages
   only, so the digest competed for its slots against whatever the user happened to type
   rather than against the work in front of it. Tool-call arguments, the assistant's own
   written text, and the todo list now go in too, and plugin-sourced messages are skipped so a
   hint can never feed itself back into the next query. An empty activity list reproduces the
   old query byte for byte, which is asserted.
2. **Just-in-time recall, at `tools/execute`.** A tool call names the thing it is about: the
   script it runs, the file it edits, the symbol it searches for. The matcher reads the
   call's argument **values** for identifiers (paths, file names, symbols, switches), and when
   a confirmed record mentions one that *discriminates* — no more than
   `PRECALL_MAX_DOC_FREQ` (2) of the records that workspace can see mention it — that record is
   attached to the call as a plugin-sourced message, one per call, 300 bytes.

Three things were tried and thrown away, each because the replay said so rather than because
they were hard:

- **Argument keys as identifiers.** Merged `file_path`, `old_string`, `job_id` count as
  identifiers, and every edit carries them: **232 of 444** calls matched something, two in
  three, and the lesson that mattered was never the one chosen. Values only.
- **A per-turn limit of one** — and then 2, 3, 4, 5, 6. Every one of them handed the turn's
  single slot to whichever *other* record some earlier call in that turn matched, and the
  Steam lesson was **never delivered at all**, in any turn. The throttle is the per-record
  cooldown plus a session ceiling, and the code says so where a future reader would otherwise
  re-add the limit.
- **`Bannerlord` as a match.** It appears in 13 of the 17 records that workspace could see, so
  a `Bannerlord` hit identifies nothing; `launch-a-runtime-clean.ps1` appears in 2 and `ERC403`
  in 1, which is what the lesson is actually about. Document frequency is computed with the
  same tokenizer the ranker counts hits with, over exactly the records the caller could be
  shown, so "discriminating" means the same thing in both places.

What that leaves, on the real session: **20 hints across 4 of its 15 turns**, and the Steam
lesson rides on the write of the launch script — same turn as the launch, before it. Not on the
launch call itself: within a turn the first call that touches the thing takes the hint, and
that is stated in the README rather than papered over.

One defect was found by a test rather than by reading: `retrieve` derives its identifiers from
the query text, and the tokenizer reads two adjacent Latin identifiers as **one multi-word
phrase**, so `drain-campaign-state.ps1 campaign` became the single key
`drain_campaign_state_ps1_campaign` — a term in no record — and every identifier hit counted
as zero. `RetrieveInput` now takes `identifiers` so a caller that already knows them hands
them over instead of having them re-derived.

### MIT, so the plugin can be listed where it is meant to be installed from

The licence was `UNLICENSED`, with a `LICENSE` file stating that no permission was granted to
use, copy, modify or distribute it and that it was published for the author's own use. That
was accurate while the repository was private. It stopped being accurate the moment the
plugin was submitted to the public plugin market, where the entire point is that other people
install and run it: a catalogue entry pointing at a repository that forbids use is a
contradiction a reviewer would be right to question.

MIT is also what this ecosystem overwhelmingly uses. A sample of 291 of the market's 4,062
entries — read from the repositories themselves, because the catalogue carries no licence
field — found 80% MIT, 9% with no licence at all, 5% Apache-2.0 and 0.7% AGPL-3.0. Among the
thirty most-starred entries, MIT and Apache-2.0 split it evenly.

Files: `LICENSE`, `package.json#license`, and the packaging check that pins the field.

### A turn harvester, calibrated on real logs before it was trusted

Recording depends on the model choosing to record, and that was already measured here:
across five sessions and ~5,900 tool calls `memory_remember` was never called once until it
was named explicitly. The standing hint narrowed that gap; nothing caught the lesson the
model simply never thought about. This does, as a safety net that leaves alone whatever the
model already recorded.

It is a harvester, not a judge. A detector recognises a *moment* — a tool that failed and
then worked, the user correcting the previous answer, the user stating something, a changed
goal, a refused action — and what gets stored is the verbatim sentence with a mechanical
title. Distilling that into a claim is judgement, and the harvester has none, so it does not
try. Every row is a candidate written straight to the store rather than through `remember`,
so no grade is invented for it and the always-on layer never sees it; `origin` and
`harvest_signal` record where it came from. The test that matters asserts exactly that, with
a harvested row whose text is a verbatim user sentence the ordinary grader would call
`verified-user`.

The detectors were pinned against a real session log rather than the event registry, which
lists types this harness never emits: `feedback/record` is a known type and appears zero
times in the 11,735 events of the busiest session in this workspace.

**Then they were calibrated on that traffic, and three of the five failed.** Replayed over
six real logs — 235 turns — the five detectors produced 150 candidates, 63.8 per 100 turns,
more than half of all turns:

| detector | hits | what the sample actually was |
|---|---|---|
| `user-statement` | 105 | skill catalogue, `Objective: "..."`, `Round: 5/256`, plain questions, task requests |
| `failure-recovered` | 71 → 5 | the agent's own edit tools reporting "file has not been read" / "old_string was not found"; the survivors are mostly `rg` failing on `System Volume Information` |
| `goal-changed` | 23 | the same objective text re-emitted every round, already stored by the goal system |
| `user-correction` | **4** | three of four are exactly the target: "it was not an implementation bug, my expectation was wrong", "quant is quant and bigfat is value investing", "add a counter-example test: root=None must be rejected" |

Corrections are not imperatives, and that detector is the only one whose precision survived
contact with real traffic. It is now the default — `user-correction`, plus the costless
`action-refused` — giving **1.7 candidates per 100 turns** against a gate this repository set
for itself (a confirmation rate under one in five means the criterion is too coarse). The
other three stay behind `harvestBroad`, off, with these numbers written down.

The finding underneath outlives the feature: a rule-based detector cannot tell "the user
stated something durable" from "the harness delivered a block of text as a user message".
That distinction is semantic, and buying it costs an LLM call this plugin does not make. The
broad rule was written, measured, and left switched off rather than believed.

Bounds are invariants, not rations: no daily quota (the busiest days are the days with the
most to learn, and a quota runs out exactly when it matters, silently), one candidate per
turn, a 200-candidate ceiling with the oldest retired beyond it, and a 14-day window after
which an untouched candidate is retired. That last rule also closes a pre-existing hole —
maintenance scanned only confirmed records, so a candidate was immortal.

Schema 3 adds `origin` and `harvest_signal`; the upgrade was verified by reopening a real
store (77 records in, 77 out, every pre-existing row defaulting to `model`).

### The resident bar now leaves the commonest grade room, on purpose

A user asked why a memory should decay the moment it is written. It was not a design: three
weights chosen separately happened to land exactly on each other.

    base score = 3.0 x evidence weight      bar = 6.0
    verified-tool  3.0 -> 9.0               ~360 days of room
    verified-user  2.5 -> 7.5               ~180 days
    verified-file  2.0 -> 6.0                0 days -- under the line the instant it exists
    inferred       0.5 -> 1.5               excluded by grade

`verified-file` is the grade almost everything actually gets (43 of 45 confirmed records in a
live store), and it was the one grade with no headroom at all, because its base score *was*
the bar. The intent recorded in the code — "evidence grade alone should not be enough; a
memory must earn its place" — was therefore executed as "you must be used in the instant you
are written", which in practice means never: 42 of those 43 records sat below a line they
could not clear, and the always-on layer held 2 records out of 76.

The bar is now `5.5`, and the gap is the policy rather than an accident: 0.5 of headroom is
60 days at the decay rate, so **a new memory is visible on its own for two months and after
that has to be earned** by being searched out or recorded as useful. On a copy of the live
store the eligible pool went from 3 of 45 to 45 of 45 — not 45 lines per turn, because the
layer is query-gated and byte-budgeted, but 45 records the ranking may choose from instead of
a closed door.

Both directions are now asserted rather than left to arithmetic: a month-old file claim is
above the bar, a three-month-old untouched one is not, and the audit report's injectability
section no longer states the old collision as if it were a rule.

### Memories were being written and never read: retrieval now counts

A user read the store and asked the plain question — "are these things actually being
used?" — and the honest answer was that nothing could say. Four facts composed into a
closed loop:

- a record reaches the always-on layer at importance `>= 6.0`;
- a file-verified record scores **exactly** `6.0` (`3.0 x 2.0`) at the moment it is
  written, so any staleness at all — hours, not days — puts it below the line. In a live
  store of 76 records, 2 were above it;
- the only thing that lifts a record clear is the reuse bonus, which requires someone to
  call `memory_feedback` and say it helped. That call had happened **three times in the
  store's entire life**;
- so the remaining records were reachable only by an explicit `memory_recall`, and the
  unconditional hint asked the model to *record* and never to *look*. Worse: **retrieval
  left no trace at all**, so a memory that a later session did search out and use gained
  nothing from it and decayed exactly as if nothing had ever touched it.

The loop is now open at all four points. `memory_recall` records that a record was
searched out (only the ones actually handed over — `renderRecall` stops at the byte budget
and the tail never reached the caller). Being searched out counts as having been touched,
so the staleness anchor is `max(created, last used, last retrieved)` and a record a later
session reaches for stops decaying and climbs back. The term is capped at `1.0`, so a
lookup is worth less than a recorded success and calling `memory_recall` repeatedly cannot
keep anything resident permanently. Automatic injection deliberately does **not** count: a
record that counted its own injection would keep itself injected, and the number would stop
meaning "someone looked for this".

The standing hint now asks for both halves in the order that matters — search before you
start, record when you learn, report when it helped. The hint exists because "offered is
not used" was already measured once for recording (five sessions, ~5,900 tool calls,
`memory_remember` never called); retrieval had the same problem and no hint at all.

Measured on a copy of the live store: of 43 confirmed file-verified records, 42 were below
the bar; one of them sat at `5.999`. A single search took it to `6.300` and back into the
always-on layer, and all 42 return under the same treatment. `memory_stats` gained the line
that answers the question directly — how many records have ever been searched out, and how
many nobody has touched in either direction.

The schema change (`retrieve_count`, `last_retrieved_at`) needed a real migration: `SCHEMA`
is entirely `CREATE TABLE IF NOT EXISTS`, so a column added to that definition reaches a
new store and does nothing whatsoever to an existing one. Columns are now added by
inspection of `PRAGMA table_info`, which is idempotent and leaves no half-migrated state —
verified by reopening a store from the previous version (76 records in, 76 out).

### A purge now takes its corroboration, and maintenance repairs the ones already left

A live store had a corroboration row whose record had been purged. It matters because
`corroborations >= 2` is the whole barrier between a local quirk and a domain-wide rule:
the row kept asserting "this workspace independently reported this content", so the next
*single* report of that content would have been counted as two independent workspaces —
the one gate that exists to require independent confirmation, satisfied by one
observation. `deleteRecord` now drops a corroboration row once no record justifies it, and
the rule is deliberately not "delete by fingerprint": one workspace purging its copy must
not withdraw another workspace's independent report. `PRAGMA foreign_keys` was never the
mechanism here (the table has no FK), so nothing else was going to catch it.

The maintenance pass also sweeps pre-existing orphans, so a store written by an older
version is repaired rather than waiting for the same content to be purged twice, and
`/memory-maintain` says how many rows it repaired.

### The write-ahead log is folded back at the end of a pass

`memory.db` is not the store on its own — recent writes live in `memory.db-wal` until a
checkpoint. Measured on a live store: the main file held **30 records while the store held
53**, so anything copying `memory.db` alone would have got a 43%-stale database and no
error, and the file had not been updated across a restart. The plugin only ever set
`journal_mode = WAL` and never asked for a checkpoint, so it now runs
`PRAGMA wal_checkpoint(PASSIVE)` at the end of each maintenance pass: never blocking,
writes back what it can without waiting for readers, and a failure there cannot fail the
turn. Copying the store is still three files (`memory.db`, `-wal`, `-shm`).

### Disclosed: `link:` does not buy hot reload, and the install self-check was overclaimed

The install-form table said a `link:` install only needs `node tools/build.mjs` because
"HMR makes a restart unnecessary". Another session falsified that with a four-way
elimination — correct `hmr: disabled: false` and root in the merged config, host really
started with `--expose-internals`, `node_modules/<pkg>` really a Junction, and no
`--preserve-symlinks` — and then changed a rendered string and saw no change. The cause is
that **watching a file is not locating a module**: the module URL computed from the link
path never matches the realpath-keyed ESM registry, so the change is emitted and nothing
is replaced, silently. Everything this repository said about "restart to pick it up" was
already consistent with that; the table was not.

The same session caught the second half: `tools/verify-install.mjs` was described as a
hot-reload self-check, but under a junction install no reload can happen, so passing after
a "reload" only shows this mount did not double-register. The README and the script now say
**mount-time** dedup, and name what reload-time dedup would actually require.

### The build id is the only anchor

A verifier compared a receipt's 10-line sha256 table against the checkout and found 7/10
matching, 3/10 not — because a further version had shipped after he verified. His
argument, now adopted: the build id hashes the **loaded compiled modules**, which is closer
to "what the process actually runs" than a list of files on disk, and a redundant snapshot
is an expiry source that makes readers suspect tampering. Per-file hashes are now
documented as a diagnostic for diffing a checkout, and must carry the build id they belong
to.

### The model-side caller can read the build id, and cite what it just read

Two callers verified a restart and, without talking to each other, reported the same gap
plus two wording defects.

- `/memory-status` is a human slash command the model cannot invoke, and `harness.log`
  carries only the process's `stdout`/`stderr`, so "which build is running" had no surface
  a model could read. `memory_stats` now leads with the same
  `插件构建 <id>（<n> 个模块）` line, from the same `buildIdentity()` call site, pinned by
  a test against the real identity rather than a literal.
- `route: tool-call` was reachable only through a failure: grading matches a tool result's
  `callId`, and the one place that id was ever printed as text was the reason of a *failing*
  record. So "record what the tool just told me" cost a wasted attempt spent discovering
  the id. `memory_stats` and `memory_recall` now name their own call id; the three writers
  do not, because a write is not a fact about the workspace and `source_ref` is for claims a
  later session can re-check.
- The nearest-existing-directory diagnostic said "the nearest existing directory X holds …"
  and then listed files among the directories. Directories now sort first, carry a trailing
  `/`, and the truncation is admitted (`showing the first 12 of 16`) instead of hidden, so
  the entry that explains a miss can no longer be cut off.
- A candidate's retirement claimed "the same claim recorded with a verifiable passage" even
  when the replacement was an ungraded candidate too, which is exactly what two failed
  writes produce. The sentence now reads the grade.
- Counts are printed by the tools that quote them: `tests/run.ts` reports
  `PASS 13 suites · N assertions` and `verify-install.mjs` reports its own total. A receipt
  said 27 checks while every run printed 26, and the README said "470+" while the suites
  execute 661.

### A copy can now identify itself, and a tool call can be cited

Two questions from a caller that the framework could not answer, and one it made
unanswerable:

- **"Which build is running?"** The version is `0.1.0` forever and a tarball restores
  1985 timestamps, so no on-disk property identified a copy. A caller asked for a
  sha256 anchor and then pointed out the hole in that: under a `link:` install the
  files *are* the working tree, so a matching hash proves the checkout is current and
  never that the restart loaded it. The plugin now hashes the modules it was loaded from
  **at activation** (`src/build-id.ts`), logs it once, and shows it in
  `/memory-status`. Comparing that against the repository is what answers "did the
  restart pick up the fix"; two sessions sharing an id are running the same code.
- **"How do I cite a tool call?"** `route: tool-call` was unreachable for a model-side
  caller: grading matches a tool result's `callId`, which a model never sees as text, so
  a caller with a real tool output to cite wrote prose instead and its record could
  never be injected. Failure reasons now list the session's successful calls and their
  tool names, which is the only place the caller is looking.
- **Installation forms are now documented** rather than implied: `tarball` is the
  shipped form (the `files` whitelist holds, "install == artifact" is checkable),
  `link:` is the development loop (live `lib/`, whitelist meaningless, and the whole
  repository — `.git` included, plus the nested `node_modules` junction — becomes
  visible under the package). A caller had switched to `link:` to get hot reload and
  asked what that broke; the answer is written down now.
- **`tools/verify-install.mjs` doubles as the hot-reload self-check.** Every surface the
  plugin contributes is registered through a fiber-scoped effect, so unloading removes
  all three; if that ever stopped being true the symptom would be duplicate names, and
  the script now asserts exactly five command names and exactly two prompt contexts
  after mounting.

### A failed verification now says why

Reported by a caller that spent five recording experiments and a full read of
`evidence.js` to work out why three of its own records came back `inferred`. The cause
was two things a return value could have stated in one line: it had passed an
**absolute path**, which `readWorkspaceFile` drops without a word, and one of its quotes
was missing a `**` that the file contained. Both arrived as the same sentence —
"no session or workspace evidence matched the supplied passage" — which names the *quote*
while the fault was in the *path*.

`readWorkspaceFile` now returns the reason as data (`absolute`, `escape`, `missing`,
`unreadable`) instead of a bare `undefined`, and `gradeEvidence` reports what it tried:

- an absolute path is named, told to be workspace-relative, and given the working root;
- a missing file is named alongside **the listing of the nearest existing directory** —
  a caller that wrote `lib/tools.js` for a repo at `repos/dsh-quant/lib/tools.js` sees
  `repos` immediately;
- a quote that matches only **after markdown decoration is ignored** is reported as
  that, with the instruction to copy the line verbatim.

Two boundaries are deliberate. Decoration is used to *diagnose*, never to accept: a
quote that matches only after stripping `**` still grades `inferred`, so "verbatim"
keeps meaning verbatim. And every verdict now carries `route` (`tool-call`, `file`,
`user-message`, `none`), because `source_ref` is a dual-purpose field and a caller
could not tell which reading had been attempted.

Verified by running the work order's own five recorded cases: all three failures now
produce actionable reasons, and the two that verified before still verify.

### Superseding also collects repeated attempts

The previous release retired a candidate when a *graded* record replaced it. A caller
re-recording after a second failed attempt left a pile of `inferred` duplicates instead,
because nothing collects same-grade repeats. The sweep now runs on every write, and
still only ever retires.

### `常驻合格 N/M` now decomposes

A bare ratio reads as a fault, and was reported as one. The census now says which of the
two ways a record clears the bar the store is missing: how many cleared it **at the
moment of writing** (and have since aged below it, which is what a `verified-file`
record does by construction) and how many have earned the reuse bonus. The comparison
is `>=`, so a record on the bar is eligible on the turn it was written and off it ever
after — the one fact the ratio hid.

### The always-on layer was injecting records unrelated to the turn

Found by testing the *use* path rather than the store: a record about a `batchSize` cap
was injected into "把这个仓库的 README 用一句话改写", a turn about nothing of the kind.
Reproduced deterministically — `identifierMatches=0`, bm25 −0.59, and an empty
`excluded` tally, meaning no filter objected. FTS5's expression is an OR over CJK
bigrams and the record's body contained `这个值`, so one shared function word retrieved
it; the resident gate then asked only whether its *importance* cleared the floor, and
it did.

The gate now has two independent halves and both must pass: grade (evidence plus
history) and **relevance** — an identifier hit, or at least one shared word that is not
a CJK function word. A function-word list rather than a corpus frequency threshold,
because frequency does not work in a store this small: `这个` appeared in one of three
records, which any ratio test reads as rare. The first attempt demanded two shared terms
instead, and the suite rejected it at once — a two-character Chinese word yields exactly
one bigram, so it refused the obvious match as readily as the accidental one.

A perverse incentive disappears with it: importance rises with successful reuse, so
grading alone made a record's *usefulness* raise its chance of leaking into unrelated
turns.

### A re-record left its candidate behind, forever

Identity is the assertion, so re-recording a claim in different words creates a second
record. A live store showed the consequence: three "candidate + confirmed" pairs, all
formed the same way — record with no passage, see it graded `inferred`, re-record with a
file quote. The candidate was never injectable, never visible, and swept by nothing:
43% of the store.

Writing a graded record now retires candidates in the same workspace whose title
matches, with `supersededBy` naming the replacement and a correction entry recording
why. Titles are compared with punctuation folded, and the live store is the reason: one
pair differed only by the 「」 around a single word, so exact equality read it as two
claims and the first version of this fix left that candidate behind.

Body similarity was the first idea and does not work — the real pairs are rewrites, so
their token overlap sits far below any near-duplicate threshold.

### Disclosed: type annotations are never checked

`stripTypeScriptTypes` removes annotations without checking them, and the toolchain has
no `tsc`, so a wrong annotation is deleted silently and nothing notices — not the build,
not a test. Type annotations here are documentation for a reader, not a verified
contract. Adding a type gate means adding a TypeScript dependency, which is exactly what
"zero build dependencies" rules out, so this is a deliberate trade rather than an
oversight, and it is now written where a reader will find it.

### Tests: maintenance assertions no longer depend on id order

`maintain` starts from a persisted cursor and wraps only when a pass finds nothing after
it, so whether one pass reaches a record depends on where that record's id sorts — and
ids are random. Adding unrelated records to the lifecycle suite made an expiry assertion
fail for that reason, not because a rule broke. The suite now drives two passes wider
than the store, which covers the ring whatever the cursor was.

### Evidence routes, stated where the model actually reads them

A lesson learned from a tool failure was reaching the store as a candidate that could
never be injected. The cause was not the grader — a failed call deliberately proves
nothing (`evidence.test` pins "a cited tool call that errored proves nothing") — but
the description: the model cited the failed call's output as its passage and had no
way to know that route could not be graded.

`source_ref` now says which passage is gradeable in each case: a file as
`path/file:line`, a successful tool call's id for a claim that a command works, and —
for a lesson learned from a failure — the file that records the finding, because the
failed call itself is not evidence here. The main description names the three accepted
evidence routes as well.

The wording went into the parameter description rather than the standing hint on
purpose: both are sent every turn, but the hint's cost is bounded and measured (149
bytes, ceiling 256), and the miss happened at the moment of filling in the field.

Verified end to end in real turns before and after: a seeded convention was retrieved
unprompted two seconds into a development task and applied to both the implementation
and its regression tests; with the runtime context suppressed, the same task produced
no memory calls at all and dropped two of the three constraints.

### The store was empty because nothing asked it to fill

Measured across five real sessions and roughly 5,900 tool calls: the memory tools
were offered in **every** request epoch after installation, and `memory_remember`
was **never called once** until a human asked for a record by name. The only five
records that ever reached a database came from explicit verification prompts. The
plugin was working — it was just never used, so the digest had nothing to inject
and the whole framework was inert in daily work.

Two changes, both about giving the model a reason rather than a capability:

- **A standing one-line instruction, `RECORD_HINT`**, contributed as its own
  `ctx.systemPrompt.context` entry rather than appended to the digest. That
  separation is the point: the digest renders `''` whenever no record is eligible,
  and an empty store is exactly when the model needs to be told that recording
  exists. Folded into the digest, the reminder would vanish with the memories —
  and the empty store would maintain itself. It costs 149 bytes on every turn
  whether or not there is anything to remember, which is a deliberate price; a
  test bounds it at 256 bytes so it cannot drift upward unnoticed.
- **Directive tool descriptions.** `memory_remember` now opens with the moment to
  call it ("the moment you learn something that will still matter in a later
  session"), and `memory_recall` with the occasion ("before starting work in an
  unfamiliar area, before repeating a decision that may already have been made").
  Costs nothing extra: a description already ships inside the tool schema. The
  constraints stay at the end — no one-off detail, transient output, secrets or
  unverified guesses.

Also corrected: the README described the digest as appended to the persona. It is
not in the system prompt at all. `ctx.systemPrompt.context` contributions are
composed into the harness's runtime-context snapshot, which reaches the model as a
**plugin-sourced message** (`source.kind === 'plugin'`). That is precisely why both
the query builder and the evidence grader must skip plugin-sourced messages, or the
digest would be read back as the user's own words and the same few records would
reinforce themselves — the loop that turned Mem0's production store into 97.8%
noise. Both skip paths are now confirmed against real session logs.

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
