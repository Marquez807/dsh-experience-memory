# Experience memory (dsh-experience-memory)

[简体中文](README.md) · [English](README.en.md)

Domain-scoped long-term experience memory for DeepSeek Harness: it tells weight from noise, accumulates lessons, lets perishable ones expire, accepts corrections, and brings the relevant lesson back the next time the same kind of work happens.

- **204 bytes per turn, unconditionally** — one line of guidance; beyond that, content is injected only when there is relevant experience.
- **Zero third-party runtime dependencies**; storage is a single SQLite file.
- Five model tools and seven slash commands, **usable with no configuration**.

## Contents

| What you want | Where to go |
|---|---|
| Install it, and confirm it is actually working | [Quick start](#quick-start) |
| Understand the mechanism that makes it remember | [What it does](#what-it-does) |
| Find the tools, the slash commands, the config keys | [Tools](#tools) · [Slash commands](#slash-commands) · [Configuration](#configuration) |
| See what it looks like to the model | [Model Experience](#model-experience) |
| Know what it **cannot** do | [Known Limitations and Deferred Work](#known-limitations-and-deferred-work) |
| Bring an old memory store across | [Migration](#migration) |
| Change the code, build it, run its tests | [`docs/DEVELOPING.md`](docs/DEVELOPING.md) |

## Quick start

Install it (point the path at the tarball you have):

```sh
dsh plugin --profile <name> add /path/to/dsh-experience-memory-0.1.0.tgz
```

**That is the whole step.** `dsh plugin add` does more than install a dependency — it **reconciles** `dsh.profile.bundles` with what is actually installed: any dependency declaring `dsh.bundle` is appended to the layer stack automatically (see `reconcilePlugins` in `@deepseek-ai/dsh`). No hand-editing of the profile's `package.json`.

Then restart the app. **Zero configuration**: it works with no config at all — the default store is created at `$DSH_HOME/experience-memory/memory.db`, and the five tools, the seven slash commands and the resident injection all take effect immediately.

To confirm it is working, use the slash commands:

```
/memory-status          # how many records, how many clear the resident bar
/memory-preview 部署     # what this turn would actually inject
```

### The four surfaces it hangs on

| Surface | Content | Triggered by |
|---|---|---|
| Automatic injection | Resident digest: core layer (corroborated across projects) + query layer, sharing 1536 bytes; plus one **unconditional** line of record guidance every turn (204 bytes) | nothing |
| Automatic maintenance | bounded maintenance on `agent/turn-stopping`, batches of 32 with a cursor | nothing |
| **Model tools** (5) | `memory_recall` / `memory_remember` / `memory_feedback` / `memory_forget` / `memory_stats` | the model |
| **Slash commands** (7) | status, preview, maintain, audit, import, harvest review, repeat failures | **a person** |

The split between tools and commands is deliberate: auditing and importing reach outside the store (they scan arbitrary directories and write in bulk), so they stay behind a human trigger. `memory_stats` is the only operator-view tool the model gets — read-only, no arguments, for answering "what do you remember" or checking "did what I recorded ever arrive".

Why the guidance line must be **separate from the digest**, and **unconditional**: the digest renders an empty string when no record qualifies (so it is not injected), and "the store is empty" is exactly the moment the model most needs to be told that recording exists. Fold it into the digest and it disappears together with the memories — and an empty store sustains itself. This is not speculation, it is measured: across 5 real sessions and about 5,900 tool calls, the memory tools were offered on every request turn after installation, and `memory_remember` was **never called once** until someone explicitly asked for a record.

**The same line now asks for a lookup too.** See "Recording is not the same as being used": telling the model only to record, never to look, is asking it to write forever and never read. So the order is **look first, then record** — `memory_recall` before starting work, `memory_remember` when something is learned, `memory_feedback` once it helped.

## What it does

Each of the three stages has one layer of mechanism, plus two lessons that tie them together: **recording is not the same as being used**, and **recorded, but not there at the moment it acted**.

### 1. When recording — grading the evidence

Recording a lesson requires the **passage it rests on** (`quote`) and the **source** (`source_ref`). The plugin checks them itself:

| Grade | Condition | Base score (×3.0) |
|---|---|---|
| `verified-tool` | `source_ref` is a tool call in this session that really ran and did not error | 9.0 |
| `verified-user` | the passage appears verbatim in a message the user sent, **and that sentence is not a question or a hypothesis** | 7.5 |
| `verified-file` | the passage appears in the cited workspace file | 6.0 |
| `inferred` | none of the above | 1.5 (always a candidate) |

Only the first three grades can enter the injection layer; `inferred` is always a candidate. That is necessary, not sufficient: the resident bar is **5.5**, and the base score of `verified-file` is 6.0 — 0.5 above it, about **60 days** at a decay of 0.0083 per day. The three grades therefore behave like this:

- `verified-tool` / `verified-user` are resident from day one and hold on base score for a long time (9.0 / 7.5 against 5.5, roughly 360 / 180 days);
- `verified-file` **holds about 60 days on its own**; only if nobody looks at it and nobody confirms it useful in those 60 days does it sink below the line, after which it needs either **a query that hits an identifier** (a path, a class name, a file name — worth 1.0) or **being looked up / successfully reused** (a lookup caps at +1.0, a successful reuse adds +1.5 on a logarithmic scale) to come back. Below the line it is still retrievable on demand through `memory_recall`.

**That 0.5 is deliberate.** It did not exist at first: the bar was also 6.0, **exactly equal** to the base score of `verified-file`, so any age decay pushed a record below the line — that is not "earning its place through relevance", it is "must be used the instant it is written", which in practice means never. The gap is **a line drawn on purpose**: a new memory gets two months of exposure for free, and after that it lives on being used.

This is deliberate: a fact read out of a file is weaker than a tool measurement or a user assertion, so it earns prompt space through "relevant to this turn" rather than through "it exists". Measured on the audit, some `verified-file` records **already qualify immediately** (the recent ones do), and the pass rate rises once an identifier is hit — which is the rule working.

#### 1.1 A failure has to say why

The judging logic did not change; **the reason for a failure now travels outward**. A caller's defect ticket forced this: to work out why three of its records only reached `inferred`, that caller ran 5 recording experiments and read the source, and found the real causes were "**I passed an absolute path and the plugin never read it**" and "**my quote was missing one `**`**" — two things **one line in the write response** can state.

Before the change, four different failures (absolute path / outside the workspace / file missing / unreadable) all collapsed into `no session or workspace evidence matched the supplied passage` — a sentence that points at the **passage** while the real cause was the **path**, the classic way to send someone in the wrong direction.

Now `readWorkspaceFile` returns the failure reason as **data**, and `reason` states what was tried, one case at a time:

| Failure | What `reason` says now |
|---|---|
| absolute path | names it as absolute, asks for a workspace-relative path, and **gives the workspace root** |
| file missing | gives the cited path and **lists the contents of the nearest existing directory** (when the repo lives under `repos/x/` and the caller wrote `lib/y.js`, it is obvious at a glance) |
| path escapes the workspace / unreadable | each gets its own sentence |
| passage not in the file | if it matches **once markdown decoration is ignored**, says so and asks for the whole line verbatim; otherwise gives the **closest line number** and its content |

Two boundaries are deliberate: **decoration is used for diagnosis, never for admission** — a match that only works after ignoring decoration still grades `inferred`, so the verbatim contract is not softened; and every verdict carries `route` (`tool-call` / `file` / `user-message` / `none`), because `source_ref` is a pun (a tool-call id or `path:line`) and callers previously had no way to know which one their value was read as.

#### 1.2 `grade` is frozen at write time

**The evidence grade is fixed the moment the record is written and is never recomputed**; what every recall recomputes is `importance` (derived from stored facts: age, reuse, failure streak). So moving or deleting the cited file later does **not** change the record's grade — it keeps the verdict of that moment and **can no longer be checked by anyone**. Workspace membership works the same way: `workspace_id` is resolved from the session cwd at write time, so after switching workspaces the record is **invisible** (not "regraded"), unless it has been promoted to domain level.

#### 1.3 A second gate before the injection layer: relevance

Grading decides "is this worth believing"; relevance decides "is this turn about that". The **two gates are independent** and both must pass:

| Gate | Criterion | Passes when |
|---|---|---|
| Grading | `importance ≥ 6.0` (evidence + history) | see above |
| Relevance | whether the **token overlap with this turn's query is specific** | an identifier is hit, or at least one **content word** is shared |

The second gate was added after measurement. Grading alone once allowed this injection: a record about `batchSize 上限 500` was injected into the turn "把这个仓库的 README 用一句话改写" — the two have **nothing to do with each other**. The only reason was that FTS5 matches **bigrams with OR**, and the record's body contained "不得动**这个**值", which collided with the 「这个」 in the question. Deterministic reproduction: `identifierMatches=0`, bm25 only −0.59, `excluded` empty — **no filter objected**.

The shape of the problem is "**a common word is not evidence of relevance**". The criterion is therefore not "how many words are shared" (a two-character Chinese word yields a single bigram, and demanding several would reject obviously correct matches — the first version did exactly that and the tests rejected it on the spot), but "**is the shared word a content word**": `src/retrieve.ts` keeps a CJK function-word list (这个/可以/一句/…), and the record is rejected only when every shared word is a function word. **This fixes the root cause without punishing legitimate matches that share exactly one content word.**

A perverse incentive disappears with it: `importance` rises with successful reuse, so **the more useful a record is, the more easily it clears the grading line** — and, when grading was the only gate, the more easily it could slip into an unrelated turn on the back of a 「这个」. The relevance gate does not depend on history.

### 2. When recalling — telling weight from noise

> The old system required a human to register a script hash and replay 2–32 times before promotion was allowed. Rigorous, and fatally expensive: after 139 work cycles the store held 0 stable entries. Grading here is automatic, because strictness is only worth anything when it is cheap enough to actually happen.

The resident layer is recomputed every turn by `ctx.systemPrompt.context` (not a boot-time snapshot), at most two sections, hard ceiling 1536 bytes:

```
经验记忆（领域通用，已由多个项目独立印证）：
- [id] 标题 — 教训          ← core layer: present whatever this turn is about
经验记忆（与本轮相关）：
- [id] 标题 — 教训          ← query layer: matching the current topic
```

**The two sections share one 1536-byte budget.** That is what makes unconditional injection affordable: the core layer reallocates prompt space rather than adding any — it cannot conjure more tokens. A section with nothing in it does not appear at all (no empty heading), and with only the query layer the behaviour is exactly the single-section one.

Why the core layer exists: the query layer is **query-gated**, so when the user answers "继续" there are no tokens to match and the digest empties out precisely in the middle of a long task. The core layer has the narrowest admission rules in the framework:

| Condition | Why |
|---|---|
| `scope = domain` | only content independently reported by **two or more workspaces** is promoted to domain level |
| `status = confirmed` | candidates are never injected |
| `evidence ≠ inferred` | content nothing has verified is not injected |
| `distinctWorkspaces ≥ 2` | one project's habit is not a domain rule |
| clears the **same** resident bar as the query layer | a core record is always a subset of the resident layer, never a back door |
| bounded by `coreMaxRecords` | so it stays bounded |

A workspace-level record never becomes core, however important — nothing has corroborated it.

Inside the hit set, records are ordered by:

```
importance = 3.0 × evidence grade   (verified-tool 3.0 / user 2.5 / file 2.0 / inferred 0.5)
           + 1.5 × log2(1 + successful reuses)
           − 2.0 × consecutive failures
           − 1.5 × staleness
           + 0.5 × log2(distinct workspaces)
           + 0.3 × log2(1 + retrievals)
           + min(2.0, 1.0 × exact identifier hits)      ← capped
```

Sort key `importance DESC, bm25 ASC, id ASC`. The old system ordered its 8 resident slots by `uuid4` string, which is random sampling frozen forever — with 100 records in the store, a new memory had an 8% chance of ever entering the overview.

#### 2.1 Recording is not the same as being used: a loop that turns memory into write-only

This one the user named directly: **"what gets recorded is never used"**. The cause was not an unwilling agent — four things formed a closed loop:

1. to appear in the prompt automatically, importance had to be ≥ 6.0;
2. a file-grade memory **is exactly 6.0 the moment it is written** (`3.0 × 2.0`) — a knife edge, and a few hours of staleness pushed it below the line;
3. staying above the line required **reuse credit**, which requires someone to call `memory_feedback` and say "this helped" — **an action that happened 3 times in the lifetime of all 76 records**;
4. so of 76 records only 2 sat in the automatic layer and the rest were reachable **only if the model chose to call `memory_recall`** — while the unconditional line **asked it to record and never to look**. Worse: **the lookup itself was never recorded**, so even when a later session dug a record out and used it, the record gained nothing — and stayed silent next time.

**All four were fixed:**

| Change | Effect |
|---|---|
| `memory_recall` now records "this was looked up" (`retrieve_count` / `last_retrieved_at`) | retrieval leaves a trace for the first time, so "was it ever used" finally has an answer |
| a lookup counts as a touch: the staleness anchor is `max(created, last used, last retrieved)` | a memory dug out and used later **no longer decays as if nobody cared** — it climbs back into the automatic layer, and the loop is broken |
| retrieval credit is **capped at 1.0** (`0.3·log2(1+retrievals)`, never above 1.0) | one lookup is worth less than one confirmed reuse; otherwise calling `memory_recall` in a loop could keep anything resident forever |
| the guidance now says **look first, then record**, and names `memory_feedback` | the guidance already fixed "offered but unused" once (see the measurement above); this applies it symmetrically to looking |

**Automatic injection does not count as a lookup**, deliberately: if a record's own injection counted as use, it would keep itself in the automatic layer and the number would stop meaning "somebody went looking for it".

`memory_stats` therefore reports one extra line that answers the question directly: `被查过 N/M 条（已确认范围内） · 从没被查过也没被确认有用的 K 条`. K is the write-only backlog, and it should fall as sessions go on.

#### 2.2 Recorded, but not there at the moment it acted

This is the second thing the user named, and it is subtler than "recorded but unused": **the memory existed, was correct, and had been injected — but not in the one turn where it mattered.**

A real example: a record saying "before launching Bannerlord, confirm Steam is logged in, otherwise the game exits silently after 10 seconds" had file-level evidence and was injected in 9 of that session's 15 turns — **just not in the turn where the user said "开始吧"**. The agent launched directly and the turn was wasted.

Two causes, neither of them "the memory is broken" — both of them "the delivery is wrong":

1. **The only text used to find memories was what the user said.** When the user answers "开始吧", nothing in those characters matches "Steam" or "launch". So the digest layer emptied out mid-task, and what the agent was actually doing contributed not one character to the query.
2. **There was exactly one delivery moment — the start of a turn** — and that moment is decided by the user's words, not by what the agent is doing.

**Two changes, both measured against that session's real log (444 tool calls), not reasoned out:**

- **The query now includes what the agent is doing**: the arguments of the tool it is calling, what it has written itself, its to-do list. Messages the plugin injected itself are always skipped, otherwise a hint would feed itself into the next turn's query. With no activity, the assembled query is character-for-character what it was before — and an assertion pins that.
- **Delivery happens as a tool call is about to act (`precall`)**: a call names things by itself — the script it will run, the file it will change, the symbol it will look for. Only the **values** of read-only arguments are matched, and handles are extracted from them (paths, file names, symbols, switches). If a confirmed record mentions one of those **discriminating** handles (at most 2 records this workspace can see mention it), that record is delivered attached to the call — at most one per call, at most 300 bytes.

**Three things tried, measured and deleted** (replay said no, not laziness):

| Attempt | Replay result |
|---|---|
| treating argument **keys** as handles too (`file_path`, `old_string`) | every edit carries those keys, so **232 of 444** calls could hit something; what got picked was not what needed reading. Restricted to values |
| **one delivery per turn** (1 through 6 all tried) | the turn's slot was taken by "some other record encountered earlier in the turn", and the Steam record **was never delivered once**. So throttling rests only on a per-record cooldown and a per-session cap, and the code says why |
| using `Bannerlord` as the handle | **13 of the 17** records this workspace can see mention it, so hitting it means hitting nothing; `launch-a-runtime-clean.ps1` is mentioned by 2 and `ERC403` by 1 — that is what the lesson is actually about |

The measured effect on that real session: **20 hints, landing in 4 of its 15 turns**; the Steam record was attached to the "write the launch script" call — **the same turn as launching the game, before it acted**.

What it cannot do, stated plainly: it does **not** guarantee the hint lands on the call that most needs it. The first action in a turn that touches the topic takes the slot, so the "run" call may go without — the lesson is already in that turn's conversation, but it is not "attached to that line". That is a real trade-off, written here rather than glossed over.

### 3. Afterwards — forgetting and correcting

- **Retirement**: explicitly forgotten by the user / two consecutive failures / expired / review overdue and never reused / 90 days unused and below the score floor
- **Never physically deleted**: retirement is reversible, and only `purge=true` removes bytes
- **Cross-project promotion**: a lesson stays in the workspace that learned it until **two different workspaces** independently report the same content — then it is promoted to domain level, confirmed, and becomes core memory injected unconditionally every turn
- **Identity is the claim itself, not the title**: the title is only a label (often an automatic summary of the body), so two records with the same body and different titles are the same knowledge. Counting the title as identity would make cross-project corroboration impossible to reach, and domain promotion would never happen
- **Re-recording retires the candidate it replaces**: the model has a stable habit — write a version with no quote first (→ candidate), notice it does not qualify, then rewrite it with a file quote. Because identity is the claim, the rewritten body is **a different record**, and the candidate stays in the store forever: not injectable, not visible, and nothing cleans it up. Measured in a real store, 3 such pairs had formed (43% of all records). Writing a **graded** record now retires same-workspace candidates with the same title, points `supersededBy` at the new record and writes a correction log entry. Title comparison **folds punctuation** — the store held a pair differing only by one pair of 「」, which exact comparison treated as two different claims
- **Maintenance** runs on `agent/turn-stopping`, in batches of 32 with a cursor, and **never enters the retrieval hot path**

#### 3.1 Perishable facts: a window on a record

Long-term memory that never expires is a liability — assertions like "the current test command is X" or "the current client version is 1.5.2" **quietly become false** once the world changes, and because they are verified facts they rank higher. So `memory_remember` accepts two optional windows:

| Parameter | Effect |
|---|---|
| `expires_in_days` | stops being retrieved **immediately** on expiry; maintenance then sets the status to `retired` |
| `review_after_days` | does **not** retire on expiry, it asks for a review; if another 30 days pass (`REVIEW_GRACE_DAYS`) with no reuse, it retires |

The split is deliberate: an expired fact should not be answered, but "needs review" is not "is wrong". And **a record that has been reused is not retired for an overdue review** — the review window exists to find things nobody needs, not to punish age.

Reporting the same claim again is **re-verification**: the new window replaces the old one instead of being ignored.

Before these two parameters existed, `expiresAt` and `reviewAfter` were only ever filled by the legacy importer, so two of the three retirement paths were **unreachable for records the plugin wrote itself** — mechanism complete, nothing able to start it.

## Operating it

### Scope

| Scope | Who can see it |
|---|---|
| `workspace` | only workspaces resolving to the same root path |
| `domain` | any workspace resolving to the same domain |

Domain resolution order (first hit wins): plugin config `defaultDomain` → `domain:` in the workspace's `.dsh/memory.yml` → `name` in `package.json` → the git remote repository name → **empty** (workspace level only).

The last step deliberately leaves it empty instead of falling back to the directory name: treating a name like `dsh主工作区` as a domain would spread one project's quirks into every directory with that name.

### Turning memory off for a mode (for example "model test mode")

**A mode (agent preset) cannot switch this plugin off itself**: the plugin is installed at the profile layer, and a preset's `disabled` flags affect only the rows that preset declares. So the switch lives in the plugin, keyed by **preset id** (`disabledPresets`, empty by default). A mode listed there gives its sessions:

| What is switched off | Why |
|---|---|
| digest injection | it is the most direct expression of "memory"; with it the model is no longer bare |
| the "look first, then record" guidance | it tells the model that memory is available, which a test mode should not be told |
| the pre-call hint | same reason, and it would push past experience into a specific tool call |
| candidate harvesting + failure counting | **no recording**: a test session's turns do not belong in the store |
| the behaviour of the five `memory_*` tools | they refuse when called, and say why (the tool list itself is hidden by the mode, see below) |

The decision reads the **`agentPreset` in the session header** and also watches `agent-preset/selected` events — so a session that started in a standard mode and was switched to the test mode also counts (reading only the header misses it, reading only events misses every session that never switched; both are read).

How the tools disappear from the list: the mode mounts a small local plugin that calls `tools.restrict({deny})` — the tool registry **only accepts restrictions inside a scope** (a global restriction would mask every agent's tools, so the API refuses), and a preset is a scope. The two defences are independent: the config layer governs "no injection, no recording", the mode layer governs "not in the catalogue".

**Maintenance still runs**: it is store hygiene (expiry, eviction) that no session sees. Skipping it would let a memory-free mode quietly stop the whole store from ageing out.

### Tools

| Tool | What it does |
|---|---|
| `memory_recall` | search by query, cap 16384 bytes, over the cap it **truncates in order and reports it**. `include_candidates` reviews claims you recorded but never verified; `include_retired` audits retired ones. **It records "was looked up" only for the records actually handed over** (the truncated tail does not count) — the only trace that memory was used |
| `memory_remember` | record a fact / experience / strategy; without a verifiable passage it is stored as a candidate. Optional `expires_in_days` / `review_after_days` put a window on a perishable fact |
| `memory_feedback` | attach a real outcome; success clears the failure streak, two consecutive failures retire |
| `memory_forget` | retire (default) or delete outright |
| `memory_stats` | read-only census: how many records, how many clear the resident bar, reuse and correction counts, recent retirement reasons. No arguments. The first line is the build id, the last line this call's id; `/memory-status` is the human version |

The two descriptions the model reads are **instructions**, not capability statements: `memory_remember` opens with the trigger ("call this the moment you learn something that will still hold next session"), `memory_recall` opens with the occasion ("before entering unfamiliar territory, or before repeating a decision already made"). That is measured, not stylistic — putting a tool in the schema is not enough to make the model use it (see the 5,900 calls above). The constraint sits at the end of the description: record reusable rules only, not one-off details, transient tool output, secrets or unverified guesses.

The `source_ref` parameter description also states **which citation can be graded**: for a file, write `path/file:line`; to claim "this command works", cite the id of a **successful** tool call; and **a lesson learned from a failure cannot cite that failed call** — a failed call is not evidence here (the existing `gradeEvidence` semantics, pinned in `evidence.test` as "a cited tool call that errored proves nothing") — cite instead **the file that records the finding**. That sentence came out of measurement: in an isolated turn the model cited a failed pytest call as its source, so the record could only land as a candidate and never reach the resident bar; in another turn it found its own way to "cite the test file committed to the repo", which is gradable, at the cost of one extra turn.

### Slash commands (for people; the model cannot see them)

Registered through `ctx.commands.register`, so they appear in the same slash menu as `/compact` and `/goal`. All are `recordInput: false` — operator commands and filesystem paths **do not enter the session record**.

| Command | Arguments | What it does |
|---|---|---|
| `/memory-status` | — | store census: counts, status/evidence/scope distribution, **how many clear the resident bar**, reuse and correction counts, recent retirements and reasons |
| `/memory-preview` | `[<query>]` | prints the digest that **would actually be injected** for that query, plus what on-demand retrieval would add. With no query it uses the last two user messages — the same logic the plugin itself uses |
| `/memory-maintain` | — | runs bounded maintenance now and reports how many records retired and why (the same rules also run at the end of every turn) |
| `/memory-harvest` | `[--retire <id>]` | lists automatically harvested candidates, or retires one |
| `/memory-audit` | `<root> [--out <dir>]` | audits an archive of stores and writes four reports |
| `/memory-import` | `<root> [--selection <file>] [--apply]` | **dry run by default**; writes only with an explicit `--apply` |
| `/memory-gaps` | `[<count>]` | lists the **repeated failure** shapes in this workspace, the raw errors, whether the store has anything related, and **which record was written but did not prevent it**. Statistics only: no injection, no records written |

Why auditing and importing are not given to the model: they scan arbitrary directories and write to the store in bulk, so the blast radius is large and this framework is fail-closed throughout. The model's tool list therefore holds 5 (4 knowledge operations plus one argument-free read-only census), with no per-turn token cost.

`/memory-preview` and real injection share one function (`src/digest.ts`), so it **cannot** disagree with what you actually receive — a preview that drifts would have no reason to exist.

## Configuration

> Deliberately not `## 配置`: `tests/docs.test.ts` reads the config table out of `## 配置` in the Chinese README (the document the plugin is actually configured from) and then compares the keys listed here against the same code, so the two tables cannot drift apart.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `dbPath` | `$DSH_HOME/experience-memory/memory.db` | store location |
| `residentMaxRecords` | `5` | per-section record ceiling |
| `residentMaxBytes` | `1536` | hard byte ceiling for the whole digest (all sections together) |
| `coreMaxRecords` | `2` | core-layer record ceiling; `0` turns the core layer off |
| `recallMaxBytes` | `16384` | per-recall byte ceiling |
| `defaultDomain` | `''` | fixed domain; empty means infer it |
| `maintenanceBatchSize` | `32` | records processed per maintenance pass |
| `failStreakLimit` | `2` | consecutive failures before retirement |
| `harvestEnabled` | `true` | harvest candidates automatically at the end of each turn |
| `harvestBroad` | `false` | enable the broad criteria that measured unreliable (broad statements, recovered failures, changed goals) |
| `harvestMaxPerTurn` | `1` | candidates per turn (0 turns harvesting off) |
| `harvestPoolLimit` | `200` | candidate pool ceiling; the oldest is retired past it |
| `harvestCandidateTtlDays` | `14` | days a candidate survives unconfirmed and unretrieved |
| `precallEnabled` | `true` | deliver a lesson about the thing a **tool call** is about to do |
| `precallMaxPerSession` | `20` | hints per session (counted as deliveries actually made) |
| `precallCooldownMinutes` | `30` | minutes before the same record may be delivered again |
| `failureTracking` | `true` | count repeated tool failures in this workspace (**counting only**: no injection, no records) |
| `failureShapeLimit` | `200` | failure shapes kept per workspace; the rarest and oldest are evicted past it |
| `disabledPresets` | `[]` | **which modes have no memory at all** (by preset id). A listed preset gets no injection, no hints, no harvesting and no counting, and its tool calls are refused |

An invalid value raises **at load time** and refuses to start the plugin instead of degrading silently. Exactly two limits may be `0`: `coreMaxRecords` (0 = core layer off) and `harvestMaxPerTurn` (0 = stop harvesting). For every other limit, 0 is indistinguishable from "off", so the minimum is 1.

## Model Experience

### The per-turn experience digest

When a request is assembled, the plugin renders at most two sections: domain-level experience corroborated across projects (the core layer, at most `coreMaxRecords` records), and relevant experience retrieved with the last two user messages as the query (the query layer, at most `residentMaxRecords` records). **Both sections share the one 1536-byte hard ceiling**, so the real line count is usually decided by the byte budget first — under the shipped configuration the record ceiling is 2+5=7 lines. One line per record: `- [id] 标题 — 教训`.

It is **not** added to the system prompt. The contribution of `ctx.systemPrompt.context` is composed by DSH into the "runtime context snapshot", and that snapshot is delivered to the model as **a plugin-sourced message** (`source.kind === 'plugin'`, plugin `dsh-system-prompt`, form snapshot). That is not a detail: precisely because this text travels the same channel as the user's words, the plugin's query derivation and evidence grading **must both skip plugin-sourced messages** (one place each in `src/digest.ts` and `src/evidence.ts`), otherwise the digest would be read back as something the user said and the same few memories would reinforce themselves — the road Mem0's production store took to 97.8% noise. Both skips are verified against real session logs.

#### Token effect

The digest has a hard ceiling of 1536 bytes and costs **0 bytes** when both sections are empty (no empty section is emitted); the core layer does not raise the ceiling, it only reallocates it. One further line appears **unconditionally** — the record guidance (204 bytes, `RECORD_HINT`) — outside that 1536 budget, because an empty store renders a 0-byte digest and that is exactly the case the guidance exists for. Its size is pinned by a test at a ceiling of 256 bytes, so it cannot grow unnoticed.

#### KV Cache effect

Content changes only when the hit set actually changes, so the effect on prefix caching is limited to the turns where it does. The core layer is stable, which makes it the cache-friendliest part.

### Automatic harvesting: catching the lesson the model never thought of

Whether something gets remembered depends on the model **choosing** to call `memory_remember`. That was measured here: across five real sessions and about 5,900 tool calls, `memory_remember` **was never called once** until someone explicitly asked. The unconditional guidance narrows that gap, but the structural problem remains — **a lesson the model never thought of has nobody to catch it.**

At the end of each turn the harvester reads **that turn** (not the whole session), and on five kinds of "moment worth keeping" it stores one candidate, one per turn, by priority:

| Signal | Criterion | What is stored |
|---|---|---|
| `failure-recovered` | within one turn a tool errored and then the same tool succeeded | tool name + the **raw error text** |
| `user-correction` | the user contradicted the previous turn (不对/错了/其实…, "no", "that's wrong", "actually"…) | the user's **verbatim** sentence |
| `user-statement` | the user stated an **explicit durable rule** (以后/一律/禁止/never…) | the verbatim sentence |
| `user-statement` | the user **was not asking a question and named something specific** (identifier/path/version/number/conclusion word) | the verbatim sentence |
| `goal-changed` / `action-refused` | `goal/change`; `approval/decided` and not allowed | the new goal verbatim / that it was refused |

**It is not a judge; it only picks up verbatim speech.** The criteria recognise a "moment", not a "lesson": what is stored is the **verbatim sentence** plus a mechanical title. Distilling a sentence into a claim is judgement, and the harvester has none — so it does not distil.

**The broad criterion is the point**: imperative-only matching would miss the shape lessons usually arrive in — "so the bug was because…", "this API does not fire in 1.5.2", "it turned out `--preserve-symlinks` was needed". None of those are commands.

**Three properties keep it from becoming the thing this framework most wants to avoid:**

1. **Always a candidate.** Harvesting writes to the store directly and **does not go through** `remember`, so it can never be handed a grade out of thin air. It is a candidate by construction, the resident layer never looks at it, and the only way to promote it is for the model to restate the same sentence, at which point the normal evidence gate applies. That is what the test pins — with a harvested record whose **quote is itself a user's verbatim sentence** (which ordinary grading would call `verified-user`), it still has to stay a candidate.
2. **It infers nothing.** All five criteria read markers the session has **already written**; `origin` and `harvest_signal` record which one fired, so it is auditable.
3. **It costs no LLM call.** This plugin never spends one.

**The bounds are invariants, not quotas**: there is no daily allowance (the busiest days are the ones that teach the most, and a quota would quietly run out exactly when it is needed). Instead: **at most 1 per turn**, a **candidate pool ceiling of 200** (the oldest is retired past it), and retirement after **14 days** unconfirmed and unretrieved. That last one also closes an existing hole: maintenance used to scan confirmed records only, so **candidates were immortal**.

**How a candidate is seen** — otherwise harvesting just pours into a pool: the tail of a `memory_recall` response carries `另有 N 条自动采集的候选待确认` (only while the model is already looking at memory, so it costs nothing per turn); `/memory-harvest` lists them for a person and can retire one; `memory_stats` reports harvested / confirmed / pending.

**The criteria were pinned against real logs, not against the event registry.** The registry lists events this harness never emits: `feedback/record` is a known type, and in the busiest log in this workspace it appears **0 times in 11,735 events**. That criterion was deleted before it was written — a criterion built on an event that never fires is a silent no-op.

**And the criteria were calibrated on real logs, with the calibration deciding the defaults.** Replaying the six largest logs in this workspace (**235 turns**):

| Criterion | Hits in 235 turns | What sampling showed | Verdict |
|---|---|---|---|
| `user-correction` | **4** | "not an implementation bug, my expectation was wrong…", "quant is quant, bigfat is value investing", "add a counter-example test: `root=None` must be rejected" | acceptable precision (3 of 4), **on by default** |
| `user-statement` (broad) | 105 | skill directories, `Objective: "…"`, `Round: 5/256`, questions, task requests | about 5–10% precision, **off by default** |
| `failure-recovered` | 5 (71 before the denylist) | `edit`/`write` without reading the file first, `old_string` not found; the rest mostly `rg` crashing on `System Volume Information` | **off by default** |
| `goal-changed` | 23 | the same goal text re-sent — the goal system already stores it | **off by default** (duplicate harvesting) |

So `harvestBroad` defaults to `false`: **only the criterion that measured sound runs by default** (`user-correction`, plus the free `action-refused`), producing about **1.7 records per 100 turns**. Before filtering it was 63.8 per 100 turns, most of which were not lessons.

**This is not a criterion written wrongly; it is a rule that cannot do that job**: telling "the user stated something durable" apart from "the harness delivered a large block of text as a user message" is a semantic judgement, and buying it costs one LLM call, which this plugin never spends. So the broad criterion stays as a switch, to be turned on once its precision measures worth it.

## Migration

From the command line (in-repo, scriptable):

```sh
node tools/import-legacy.mjs --root "F:\GPT工作区"            # dry run, prints a report
node tools/import-legacy.mjs --root "F:\GPT工作区" --selection <catalogue> # only what the catalogue lists
node tools/import-legacy.mjs --root "F:\GPT工作区" --apply     # write (all mappable records if no catalogue)
```

Inside the plugin (available once installed, no repo needed):

```
/memory-audit "F:\GPT工作区"
/memory-import "F:\GPT工作区" --selection "…\legacy-memory-selection.json"
/memory-import "F:\GPT工作区" --selection "…\legacy-memory-selection.json" --apply
```

Dry run is the default, because the archive tree holds both live stores and copies, and importing the wrong thing is not a reversible mistake.

### Judgement and mechanics kept apart

"Which records are worth importing" is an editorial judgement about data; "write records into the store" is a mechanical operation. They are separated:

- `tools/audit-legacy.mjs` makes the judgement and writes `legacy-memory-selection.json` — **plain JSON, meant for you to edit**. Delete the entries you disagree with, then:

```sh
node tools/import-legacy.mjs --root "F:\GPT工作区" --selection audit\legacy-memory-selection.json
node tools/import-legacy.mjs --root "F:\GPT工作区" --selection audit\legacy-memory-selection.json --apply
```

- `tools/import-legacy.mjs` only executes the catalogue. **The dry run reports how many records the catalogue excluded**, so it can be checked before anything is written.
- Identity in the catalogue is `(workspaceId, contentFingerprint)`, the same key the audit dedupes on, so it cannot ambiguously point at two records; it also does not depend on record ids, because ids are regenerated on every import.
- An empty catalogue is a legitimate answer: import 0 records, rather than "no catalogue means import everything".

Five deliberate trade-offs:

- **Imported records are written directly, not regraded.** Going through `remember` would grade every one of them `inferred` (a migration has no session to cite), which silently downgrades a store of verified facts on the way in.
- **Old `global` records become workspace-level.** There is no way to tell which domain they belonged to, and broadcasting to every project is the exact leak the new scope rules exist to prevent. The count is reported separately so it can be decided record by record.
- **Copy stores are not imported.** `.codex/project-memory-backups/`, `.dev-packages/`, `.eval-pilots/` and any directory whose name contains backup/snapshot/copy/rehearsal hold copies of another store. Importing them multiplies one lesson by the number of snapshots — one record in that archive tree was stored **34 times**. They are excluded during the scan, each with its reason listed.
- **Duplicate writes inside one store are merged.** The old runtime appended the same claim repeatedly (a migrated store still holds one copy in `entries.jsonl` and another in `memory.sqlite3`), and a different timestamp is not new knowledge.
- **Tool-failure events are not imported, even when their type is `fact`.** On a failed tool call the old runtime wrote `type: fact` with `admission.proof.kind: tool`, so the record arrived with the **strongest evidence grade** and `confirmed` while its whole content was one line — `Tool call_00_... exited 1` — with no command, no error and no fix. The live store held **98** such records, and by evidence score they ranked above every real lesson. Filtering events by `type` does not stop them; only their body shape does.

**Work-history events are not imported**: the old runtime wrote `failure`/`task`/`decision`/`fix` events into the same stream as knowledge records. An event is an observation, not a lesson — a `failure` says something broke, not what to do next time. Importing them as lessons is exactly the noise the resident bar exists to keep out.

### Audit before importing

The migration tool answers "what can be imported"; the audit tool answers "**is this experience correct**" — and the second must come first:

```sh
node tools/audit-legacy.mjs --root "F:\GPT工作区"
# writes four reports:
#   audit/legacy-memory-audit.md         verdict: mechanical checks + funnel + measured injection
#   audit/legacy-memory-recommended.md   the recommended subset, grouped by project/topic, one by one
#   audit/legacy-memory-selection.json   executable catalogue of that subset, for --selection, editable
#   audit/legacy-memory-records.tsv      full body text of every mappable record
```

What can be checked mechanically it actually checks, rather than guessing:

| Check | Method |
|---|---|
| is a cited path still there | for each absolute path, find the **longest existing prefix**: stopping on a separator means the last segment really is gone; stopping mid-segment means the path exists and prose is glued to it |
| is a cited command still installed | only real command-line tool names are looked up; identifiers inside inline code are not treated as commands |
| do records contradict each other | exact duplicates (by body identity), near-duplicates (token Jaccard), opposite polarity on one topic (do/don't) |
| quality signals | questions, placeholders, self-reference (writing about the memory mechanism itself), too short, no lesson |
| **would it actually be injected** | it calls the framework's own `importance` / `eligibleForResident` instead of inferring |

Measured on this machine's archive: the tree holds 415 raw records in total, of which only **6 stores and 324 records** are live; the other 19 stores are copies. Of those 324, 67 are in-store duplicates and **98 are tool-failure events disguised as `fact`**, leaving **150 mappable**. The recommended subset funnels down to **36**: confirmed only (−73), evidence-bearing only (−39), self-referential removed (−0), same-workspace dedupe (−0), body at least 40 characters (−2).

What those 36 are needs a counter-intuitive answer: **they are all `fact`, not one of them `experience` or `strategy`.** The old store had no "lesson" kind of knowledge at all, only project **specs, boundaries and state ledgers** cut into pieces and stored as memory — version baselines, scope exclusions, safety invariants, milestone exit gates, data-source authorisation, items unverified at the time. They are useful inside their own project and noise in another, so they are workspace-level rather than domain-level.

⚠️ Two consequences you must know:

1. **The old runtime had no `lesson` or `failure_mode` field**, so both are empty on every imported record. A resident line is "title — lesson", and an empty lesson falls back to rendering the body, so imported records appear as bodies and the actionable-lesson layer is missing.
2. **They are `verified-file`, with a bar of 5.5 and a base score of 6.0**, so recent imports ride their age above the line by themselves; anything older than 60 days comes back only via an identifier hit or by being looked up / confirmed useful. So the practical effect of importing is **an on-demand project knowledge base, the newer part of which also surfaces every turn**. See "grading the evidence" above.

### Working out why a memory does not appear

Two causes — **not in the store** and **in the store but not reaching the prompt** — are indistinguishable from tool calls alone.

**Inside the plugin** (recommended, available once installed):

```
/memory-status              # how many records, how many clear the resident bar, why records retired
/memory-preview 继续        # what this turn would actually inject
```

**Offline** (in-repo, works against any store file without starting DSH):

```sh
node tools/preview.mjs --db <store path> --cwd <project root> --query "继续" --query "WandererProfile"
```

Both share `src/census.ts` and `src/digest.ts`, so they agree. The census also covers the **audit trail**: the `usage` and `correction` tables record every reuse outcome and every correction, and it lists recent retirements with their reasons (explicitly forgotten, consecutive failures, expired, review overdue…). Those two tables used to be **written and never read**, so "why did this drop out of the pool" had no answer inside the framework and meant opening SQLite by hand.

It loads the built `lib/`, so it doubles as a check that the shipped artefact behaves like the source.

## Known Limitations and Deferred Work

> The heading stays in English so the anchors the docs suite reads by exact heading text keep resolving.

- **"Mistakes made repeatedly" are counted, never written into lessons automatically.** That is a choice made after measuring, not an omission: over seven days, 63 sessions on this machine produced 358 tool failures, and the most common class (editing a file without reading it first — 143 times across 5 sessions) **has the fix written in its own error message** ("read the file, then retry"); the top two classes together account for 178. Memory adds nothing to that class of failure: the repetition is a slip, not ignorance, and the harness's edit tool is itself the guard. The `failure-recovered` criterion was **calibrated once and judged noise** here (71 hits → 5 real), and this data **supports** that verdict rather than overturning it. So this version does two unrisky things: record failures by shape (no injection, no records), and **write our own errors so they can be acted on** (the `domain` error entered the Top-10, 10 times across 3 sessions). Criteria and numbers are in the CHANGELOG.
- **"Relevant" in `/memory-gaps` is keyword overlap, not semantic coverage.** The raw errors are English and the records are mostly Chinese, so a Chinese record may match none of them; the score **can only be too low**, and the report says so. Its purpose is to let a person see "this keeps happening", not to conclude "a record should be written".
- **`/memory-gaps` also points out "which record was written but did not prevent it".** Three conditions must hold together: the keywords **all** match (and there are at least two — one word matching is coincidence), the record predates the repeats (a one-hour grace, otherwise a freshly written record is blamed for the next slip), and at least 3 repeats happened after it. The measured example: the "this machine cannot fetch web pages" lesson was written at 21:05; before it, the three kinds of `web_fetch` failure ran at 0.54/0.34/0.14 per hour, afterwards 0.00/0.12/0.00 — **the only hard evidence so far that a lesson prevented an error**. It can be recomputed any time with `audit/verify-prevention-before-after.mjs`.
- **Some rows in `/memory-gaps` are not mistakes.** A user interrupting a plan review, a tool being aborted, a user cancelling a wait — all are recorded as "failure" shapes, and they are **the user's actions**, not the agent's misjudgement. This version deliberately does not filter them: filtering needs a literal "this does not count" list, and this repo has been burned by such lists before (one word of difference slips straight through). The cost is that the first rows of the report may mix them in; the mitigation is that **every row carries its raw error**, so a reader recognises them at a glance. The measurement supports the trade-off: 3 of 19 failures after the restart were of this kind.
- **Counting reads only the most recent turn, at turn end.** Measured boundary (19 after a restart vs 19 counted turn by turn, identical): a turn already running before the restart is not counted (that build did not have the feature), and a session that never stopped is not counted either. The consistency script is `audit/diagnose-counter-gap.mjs`, rerunnable as-is at any time.
- **Deferred: reminding by "when this applies" before acting.** All 59/59 records have a `trigger` field filled in, phrased as when the record is useful, which looks ready to use — and measured unreliable: using "the tool name about to be called appears in some record's trigger" as the condition fires 949 times in 13,198 calls (7.2%) and covers 62/358 failures (17%), but the largest source is `grep` (623 firings for 3 failures — sentences like "grep assertions" were taken as triggers), while the tool that should fire is `web_fetch` (193 calls / 49 failures). Telling "this record is about using this tool" from "it mentions this tool in passing" is a semantic judgement, and this plugin makes no LLM calls. **To touch it, meet the pre-registered criteria first**: replaying the same 7-day window, it must fire on ≤2% of calls and cover ≥15% of failures, and no single record may contribute ≥300 false firings; per-tool failure rates act as the gate (data from the `/memory-gaps` table). If it does not meet them, it is not done — writing "wanted" as a threshold keeps the next session from treating it as missed work better than writing it as a to-do.
- **Type annotations are never checked.** The build only strips them and the toolchain has no `tsc` (zero build dependencies is deliberate), so a type inconsistency is never discovered by any step — a wrong annotation is deleted as-is, runtime behaviour is unaffected, and not even the tests notice. Types here are documentation for people to read, not a verified contract. Adding a gate means adding a TypeScript dependency, which conflicts with "zero build-time dependencies"; that is a known trade-off, and it is written down here.
- **The relevance gate makes "function words only" matches miss.** The resident layer requires an identifier hit or one shared content word, so a reply containing only 「这个/可以」 brings back no records even when one is genuinely relevant. The mitigation is on-demand retrieval: `memory_recall` is not subject to that gate.
- **Title comparison folds punctuation, so different claims under one title can be retired together.** That is the price of a deliberately weak handle: the action is **retirement, not deletion**, `supersededBy` and the correction log both keep the trace, and a wrong judgement can be restored.
- **That guidance line is paid for unconditionally every turn**: 204 bytes, even if this workspace never records anything. That is a deliberate trade-off — making it appear "only when there is memory" would make it vanish exactly when the store is empty, which is the problem it exists to solve. `RECORD_HINT`'s length is pinned by a test at a 256-byte ceiling; to switch it off entirely, delete the `ctx.systemPrompt.context` registration in `src/index.ts` (it contributes text and nothing else).
- **Just-in-time delivery reads identifiers out of the tool call's arguments only, and only Latin-shaped ones** — paths, file names, long symbols, switches. A Chinese argument value yields none, so a purely Chinese call gets no hint: in this workspace, **44 of 156 confirmed records carry no such identifier and cannot be delivered however relevant they are**. The per-turn resident digest is not subject to this rule; it is gated on the topic instead. Why the criterion was left alone, the measurements, and the bar the next one has to clear are in [`docs/DELIVERY-GAPS.md`](docs/DELIVERY-GAPS.md).
- **No semantic or vector retrieval.** v1 has FTS5 plus exact identifier matching and evidence ranking; the `record.embedding` column is reserved, so adding RRF fusion needs no migration.
- **The injection layer is query-gated, so it is sensitive to topic drift.** The query comes from the last two user messages, so when the user replies 「继续」 the query layer empties. The core layer (domain-level experience corroborated across workspaces) exists for exactly that gap, but it covers only corroborated content, and workspace-level experience still drops out when a long task continues with a short reply.
- **`node:sqlite` is still experimental** and prints `ExperimentalWarning` at runtime. DSH's own session full-text search uses it too.
- **Maintenance does at most 32 records per turn** and does not speed up when it falls behind.
- **Importing does no cross-store corroboration counting**: migrated records always have `distinct_workspaces = 1`, so domain promotion waits for real observations.
- **No graphical panel**; status, preview and operations go through slash commands, configuration through the plugin config.
- **The slash commands need the `commands` service.** It is provided by `dsh-base` — the same bundle as `tools` and `systemPrompt` — so declaring it in `inject` adds no new environment constraint. The corollary: in any profile **without `dsh-base`** this plugin does not activate (which was already true before this change, since `tools` and `systemPrompt` come from base too).
- **`src/` and `tools/` are not shipped in the package.** The runtime needs only `lib/`, and the scripts are in-repo tools. That also removes the class of defect where a shipped script imports `src/*.ts` and therefore cannot run under `node_modules` — not by fixing it, but by not shipping it.
- **No cross-machine sync**; the database is a single-machine file.
- **A real model turn was run once, and it is not part of `pnpm verify`.** That run caught a defect 12 suites could not: two readers were reading `agent.session.events`, and that property **does not exist on a real Session** — so in production the event log was always empty, a verbatim quote could never grade `verified-user`, the retrieval query was always the empty string, and the query section of the injection layer never matched anything. Every test had hand-written that array, so what they froze was an **assumption**, not the contract. Reads now go through `src/session.ts` (`snapshotEvents()`, with labelled compatibility branches elsewhere). Conclusion: a mount-layer assertion does not replace one real turn. How to run it is in the "running one real model turn" section of `docs/DEVELOPING.md`, but it spends real tokens, so it is not automated.
- **Browser rendering of the slash menu is not automated.** The commands' **discoverability** is asserted: the test uses the same API the slash menu reads (`ctx.commands.list(agent)`) and checks that all 7 commands are present, have descriptions, declare argument hints where they take arguments, and are sorted by name. What remains unverified is only the step where the browser draws that data — a step shared with the in-box commands.

## About this document

- **The numbers in the READMEs are checked by machine, not copied by hand.** `tests/docs.test.ts` compares the config table value by value, the registered tool and command names, the digest line ceiling (2+5=7), the suite count, the audit output list and the byte size of that guidance line; any disagreement fails the suite. Changing the docs and changing the code are the same act here.
- **The tests locate sections by exact heading text.** The pinned headings are `## Known Limitations and Deferred Work`, `## 配置`, `## 模型的体验（Model Experience）`, `### 它挂了四个表面` and `#### Token effect` — renaming one means changing the test in the same commit, otherwise those assertions fail on a missing anchor (fail, not silently skip). Details in the "documents and code" section of `docs/DEVELOPING.md`.
- **16 个套件** (16 suites) in total, run with one command: `pnpm verify`. What each one covers is in the "tests" section of [`docs/DEVELOPING.md`](docs/DEVELOPING.md).
- **Building, packaging, boot acceptance, the test inventory and the development environment** live in [`docs/DEVELOPING.md`](docs/DEVELOPING.md).
