/**
 * Retrieval and injection regressions.
 *
 * The archived `visible()` read `not session or session_id in ('', session)`,
 * so an empty session skipped filtering and a search returned every other
 * session's private records — and the documented manual workflow passed no
 * session. These cases pin the fail-closed replacement.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, eq } from './assert.ts'
import { openDb, upsert } from '../src/db.ts'
import type { DatabaseSync } from 'node:sqlite'
import { retrieve, retrieveCore, visible, identifierMatches } from '../src/retrieve.ts'
import { BudgetError, byteLength, renderDetail, renderDigest, renderRecall, renderResident, truncateToBytes } from '../src/inject.ts'
import { identifiers, identifierKey } from '../src/tokenize.ts'
import type { MemoryRecord } from '../src/types.ts'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

function make(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'r1',
    workspaceId: 'wsA',
    domain: 'python/testing',
    scope: 'workspace',
    kind: 'experience',
    status: 'confirmed',
    evidence: 'verified-tool',
    title: '标题',
    // Contains the default query term so every fixture is a match unless a case
    // deliberately overrides the body.
    body: '部署在 F 盘',
    trigger: '',
    failureMode: '',
    lesson: '',
    sourceRef: '',
    reuseCount: 0,
    successCount: 0,
    failureCount: 0,
    failStreak: 0,
    distinctWorkspaces: 1,
    createdAt: NOW,
    occurredAt: NOW,
    updatedAt: NOW,
    lastUsedAt: NOW,
    reviewAfter: null,
    expiresAt: null,
    contentFingerprint: 'fp-r1',
    supersededBy: null,
    needsReview: null,
    ...over,
  }
}

function query(over: Partial<Parameters<typeof retrieve>[1]> = {}): Parameters<typeof retrieve>[1] {
  return { workspaceId: 'wsA', domain: 'python/testing', query: '部署', now: NOW, limit: 10, tier: 'recall', ...over }
}

export function run(): void {
  const dir = mkdtempSync(join(tmpdir(), 'expmem-ret-'))
  const db: DatabaseSync = openDb(join(dir, 'memory.db'))

  try {
    // ── H3: visibility is fail-closed, with no empty-session escape hatch ────
    const mine = make({ id: 'mine', workspaceId: 'wsA' })
    const theirs = make({ id: 'theirs', workspaceId: 'wsB' })
    const shared = make({ id: 'shared', workspaceId: 'wsB', scope: 'domain', domain: 'python/testing' })

    assert(visible(mine, 'wsA', ''), 'a workspace sees its own record')
    assert(!visible(mine, 'wsB', ''), 'another workspace does not')
    assert(visible(shared, 'wsA', 'python/testing'), 'a domain record is visible to a matching domain')
    assert(!visible(shared, 'wsA', ''), 'an unresolved domain sees no shared record')
    assert(!visible(shared, 'wsA', 'other/domain'), 'a different domain sees no shared record')
    assert(!visible(mine, '', ''), 'an unidentified workspace sees nothing at all')

    // The same rule through the query path: no workspace and no domain yields
    // no rows rather than everything.
    upsert(db, mine)
    eq(retrieve(db, query({ workspaceId: '', domain: '' })).ranked, [],
      'an unidentified caller retrieves nothing')

    // ── Scope isolation through retrieval ───────────────────────────────────
    upsert(db, theirs)
    upsert(db, shared)
    const fromA = retrieve(db, query({ query: '部署' })).ranked.map(r => r.record.id).sort()
    eq(fromA, ['mine', 'shared'], 'workspace A sees its own record and the shared domain record')
    const fromB = retrieve(db, query({ workspaceId: 'wsB', query: '部署' })).ranked.map(r => r.record.id).sort()
    eq(fromB, ['shared', 'theirs'], 'workspace B sees its own record and the shared domain record')

    // ── Status window per tier ──────────────────────────────────────────────
    upsert(db, make({ id: 'cand', status: 'candidate', contentFingerprint: 'fp-cand' }))
    upsert(db, make({ id: 'inf', evidence: 'inferred', contentFingerprint: 'fp-inf' }))
    upsert(db, make({ id: 'old', expiresAt: NOW - DAY, contentFingerprint: 'fp-old' }))
    upsert(db, make({ id: 'repl', supersededBy: 'mine', contentFingerprint: 'fp-repl' }))

    const resident = retrieve(db, query({ tier: 'resident' })).ranked.map(r => r.record.id)
    assert(!resident.includes('cand'), 'the resident layer never carries a candidate')
    assert(!resident.includes('inf'), 'the resident layer never carries an inference')
    assert(!resident.includes('old'), 'the resident layer never carries an expired record')
    assert(!resident.includes('repl'), 'a superseded record is not retrieved')

    const recallDefault = retrieve(db, query()).ranked.map(r => r.record.id)
    assert(!recallDefault.includes('cand'), 'a candidate is not recalled by default')
    // An inference has status `confirmed`; only the resident layer filters by
    // evidence grade, so the on-demand layer still returns it.
    assert(recallDefault.includes('inf'), 'recall admits a confirmed record whatever its evidence grade')
    const recallWide = retrieve(db, query({ includeCandidates: true, includeRetired: true })).ranked.map(r => r.record.id)
    assert(recallWide.includes('cand'), 'a review call can widen the status window')
    assert(recallWide.includes('inf'), 'an inference is retrievable when explicitly widened')

    // ── Exclusions are counted, not silently dropped ────────────────────────
    const explained = retrieve(db, query())
    assert((explained.excluded['expired'] ?? 0) >= 1, 'expired removals are counted')
    assert((explained.excluded['superseded'] ?? 0) >= 1, 'superseded removals are counted')

    // ── Limit is applied and counted ────────────────────────────────────────
    const limited = retrieve(db, query({ limit: 1 }))
    eq(limited.ranked.length, 1, 'the limit is honoured')
    assert((limited.excluded['limit'] ?? 0) >= 1, 'records dropped by the limit are counted')

    // ── Identifiers lift a record, bounded by the cap in rank.ts ────────────
    upsert(db, make({ id: 'exact', title: '甲', body: '改了 memory_mvp.py 的排序', contentFingerprint: 'fp-exact' }))
    upsert(db, make({ id: 'loose', title: '甲', body: 'memory mvp py 分开写', contentFingerprint: 'fp-loose' }))
    const keys = identifiers('memory_mvp.py').map(identifierKey)
    eq(identifierMatches(make({ body: '改了 memory_mvp.py 的排序' }), keys), 1, 'the exact identifier matches')
    eq(identifierMatches(make({ body: 'memory mvp py 分开写' }), keys), 0, 'separated words do not')
    const identRanked = retrieve(db, query({ query: 'memory_mvp.py' })).ranked
    eq(identRanked[0]?.record.id, 'exact', 'the record carrying the identifier ranks first')

    // ── A query with no indexable term returns nothing ─────────────────────
    eq(retrieve(db, query({ query: '，。！？' })).ranked, [], 'a punctuation-only query retrieves nothing')

    // ── Injection: nothing relevant means no tokens at all ─────────────────
    eq(renderResident([], { maxRecords: 5, maxBytes: 1536 }), '', 'no records renders empty, not an empty section')
    const residentRanked = retrieve(db, query({ tier: 'resident' })).ranked
    const text = renderResident(residentRanked, { maxRecords: 5, maxBytes: 1536 })
    assert(text.startsWith('经验记忆'), 'the resident digest carries a header')
    assert(byteLength(text) <= 1536, 'the resident digest respects its byte ceiling')
    assert(text.includes('[mine]'), 'the resident digest names the record id so the model can act on it')

    // ── One shared function word is not relevance ───────────────────────────
    // Reproduced from a live store: a record whose body contained `这个值` was
    // injected into "把这个仓库的 README 用一句话改写", a turn about nothing of the
    // kind, purely because FTS5's expression is an OR over bigrams. The on-demand
    // layer may stay loose (the model asked); the always-on layer may not.
    upsert(db, make({
      id: 'noisy',
      evidence: 'verified-user',
      title: '部署目标盘',
      body: '部署一律写到 F 盘；这个值不要改。',
      contentFingerprint: 'fp-noisy',
    }))
    const unrelated = '把这个仓库的 README 用一句话改写。'
    const loud = retrieve(db, query({ query: unrelated, tier: 'resident' }))
    assert(!loud.ranked.some(entry => entry.record.id === 'noisy'),
      'a record sharing only a function word is not injected')
    assert((loud.excluded['relevance'] ?? 0) >= 1, 'and the refusal is counted as a relevance drop')
    assert(retrieve(db, query({ query: unrelated, tier: 'recall' })).ranked
      .some(entry => entry.record.id === 'noisy'),
    'while the on-demand layer still returns it, because there the model asked')

    // One content word is enough: a two-character Chinese word yields exactly one
    // bigram, so demanding several shared terms would reject the obvious match as
    // readily as the accidental one. An earlier version of this gate did exactly
    // that and the rest of the suite caught it.
    assert(retrieve(db, query({ query: '部署', tier: 'resident' })).ranked
      .some(entry => entry.record.id === 'noisy'),
    'a single shared topic word is enough for the always-on layer')
    upsert(db, make({
      id: 'ident',
      title: '排序',
      body: '改了 memory_mvp.py 的排序',
      contentFingerprint: 'fp-ident',
    }))
    assert(retrieve(db, query({ query: 'memory_mvp.py', tier: 'resident' })).ranked
      .some(entry => entry.record.id === 'ident'),
    'an identifier hit needs no second term — it is specific on its own')

    // ── Resident line ceiling holds even with very long lessons ─────────────
    const long = '很长的教训内容。'.repeat(200)
    upsert(db, make({ id: 'long', title: '长', lesson: long, contentFingerprint: 'fp-long' }))
    const longText = renderResident(retrieve(db, query({ tier: 'resident' })).ranked, { maxRecords: 5, maxBytes: 700 })
    assert(byteLength(longText) <= 700, 'a long lesson cannot break the byte ceiling')
    assert(!longText.includes(long), 'the long lesson is truncated, not emitted whole')

    // ── maxRecords is a real ceiling ────────────────────────────────────────
    for (let i = 0; i < 12; i += 1) {
      upsert(db, make({ id: `many${i}`, title: `多${i}`, contentFingerprint: `fp-many${i}` }))
    }
    const manyRanked = retrieve(db, query({ limit: 32 })).ranked
    const capped = renderResident(manyRanked, { maxRecords: 3, maxBytes: 100000 })
    eq(capped.split('\n').length, 4, 'three records render as a header plus three lines')

    // ── The core pass: injected with no query at all ────────────────────────
    // `shared` is a domain record, but only one workspace ever reported it, and
    // one project's habit is not a rule. `mine` is important but workspace-local.
    // Neither may be core: the entire justification for injecting without a query
    // is that independent workspaces agreed.
    eq(retrieveCore(db, { domain: 'python/testing', now: NOW, limit: 5 }).ranked, [],
      'a domain record with a single workspace behind it is not core')
    upsert(db, make({
      id: 'core1', scope: 'domain', domain: 'python/testing', distinctWorkspaces: 2,
      body: '部署一律先备份', contentFingerprint: 'fp-core1',
    }))
    const core = retrieveCore(db, { domain: 'python/testing', now: NOW, limit: 5 }).ranked
    eq(core.map(entry => entry.record.id), ['core1'], 'a corroborated domain record is core')
    assert(!core.some(entry => entry.record.id === 'mine'),
      'a workspace-local record is never core, however important')
    eq(retrieveCore(db, { domain: '', now: NOW, limit: 5 }).ranked, [],
      'an unresolved domain has no core, so nothing is broadcast to it')
    eq(retrieveCore(db, { domain: 'python/testing', now: NOW, limit: 5 }).ranked[0]?.bm25, 0,
      'a core record is ranked without a query, so it carries no bm25')

    // ── Two sections share one byte budget ─────────────────────────────────
    // That sharing is what makes an unconditional section affordable: the core
    // lines re-allocate prompt, they cannot grow it.
    const digest = renderDigest([
      { label: '核心：', ranked: core },
      { label: '相关：', ranked: residentRanked },
    ], { maxRecords: 5, maxBytes: 1536 })
    assert(digest.includes('核心：'), 'the core section is rendered')
    assert(digest.includes('相关：'), 'and so is the query-matched section')
    assert(digest.includes('[core1]'), 'the core record names its id')
    assert(byteLength(digest) <= 1536, 'both sections together respect the one shared ceiling')
    const coreOnly = renderDigest([{ label: '核心：', ranked: core }], { maxRecords: 5, maxBytes: 1536 })
    assert(coreOnly.startsWith('核心：'), 'core renders even when nothing matched')
    eq(renderDigest([{ label: '核心：', ranked: core }], { maxRecords: 5, maxBytes: 8 }), '',
      'a section that cannot fit even one line renders nothing, never a bare heading')
    eq(renderDigest([{ label: '核心：', ranked: [] }], { maxRecords: 5, maxBytes: 1536 }), '',
      'an empty section contributes nothing')

    // ── On-demand layer truncates and reports instead of refusing ───────────
    const pack = renderRecall(manyRanked, 400)
    assert(pack.truncated, 'a tight budget truncates the recall')
    assert(pack.returned < pack.total, 'the pack reports fewer records than were ranked')
    assert(byteLength(pack.text) <= 400, 'the recall respects its byte ceiling')

    // ── The provenance line states each fact once ──────────────────────────
    // It used to print the evidence grade twice — once as a label and again as
    // the first item of the explanation — which spends tokens on every recall to
    // repeat something already said.
    const detailed = renderRecall(retrieve(db, query()).ranked, 100000).text
    for (const line of detailed.split('\n').filter(text => text.includes('证据:'))) {
      const grades = line.split('·').filter(part => part.trim().startsWith('证据:')).length
      eq(grades, 1, `the provenance line names the grade once: ${line.trim()}`)
    }
    assert(detailed.includes('重要性'), 'and still reports the score')

    // ── The recall names where a verified claim came from ──────────────────
    // The grade is what decides whether a record is injected at all, and it rests
    // on a passage in a file or a tool call. Showing `verified-file` without the
    // file leaves the grade unchecked — and source_ref was written and graded on
    // but never rendered anywhere.
    upsert(db, make({ id: 'sourced', sourceRef: 'src/db.ts:116', contentFingerprint: 'fp-sourced' }))
    const sourced = renderRecall(retrieve(db, query({ query: '部署', limit: 64 })).ranked, 100000).text
    assert(sourced.includes('出处: src/db.ts:116'), 'the recall names the source the claim rests on')
    const noSource = renderDetail(
      retrieve(db, query({ query: '部署', limit: 64 })).ranked.find(entry => entry.record.id === 'mine')!,
    )
    assert(!noSource.includes('出处:'), 'a record with no source_ref does not render an empty provenance line')

    // ── A record that cannot fit alone is a configuration error ─────────────
    let threw = false
    try {
      renderRecall([manyRanked[0]!], 10)
    } catch (error) {
      threw = error instanceof BudgetError
    }
    assert(threw, 'a budget smaller than one record raises BUDGET_EXCEEDED')

    // ── Byte helpers ────────────────────────────────────────────────────────
    eq(byteLength('abc'), 3, 'ascii counts one byte per character')
    eq(byteLength('中'), 3, 'CJK counts three')
    eq(truncateToBytes('中文', 4), '中', 'truncation cuts on a code-point boundary, never mid-character')
    eq(truncateToBytes('ab', 10), 'ab', 'a short string passes through')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  retrieve   ok')
}
