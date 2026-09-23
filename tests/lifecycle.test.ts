/**
 * Lifecycle regressions.
 *
 * The archived runtime recorded 139 work cycles and promoted nothing, because
 * promotion cost a human hash ceremony. The replacement must be cheap enough to
 * happen and strict enough to be worth trusting, so every rule below is pinned:
 * what creates a candidate, what promotes one, what demotes it, and what only a
 * distinct second workspace may share.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, eq } from './assert.ts'
import { openDb, getRecord, upsert } from '../src/db.ts'
import type { DatabaseSync } from 'node:sqlite'
import {
  checkProvenance, SOURCE_GONE,
  fingerprint, forget, maintain, normalizeContent, recordUsage, remember,
  retirementReason, REVIEW_GRACE_DAYS, STALE_DAYS,
} from '../src/lifecycle.ts'
import { retrieve } from '../src/retrieve.ts'
import type { MemoryRecord } from '../src/types.ts'

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const DOMAIN = 'python/testing'

/** A session in which the user said exactly `quote`. */
function sessionSaying(quote: string, cwd: string) {  const events = [{
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: quote }] },
  }]
  return {
    // A real Session exposes its log through `snapshotEvents()`, not as an array
    // property. Fixtures must match that or they test a path production never takes.
    session: { header: { cwd }, snapshotEvents: () => events },
  }
}

/**
 * Coverage of maintenance, independent of where the cursor happens to sit.
 *
 * `maintain` starts from a persisted cursor and wraps only when a pass finds nothing
 * after it, so a *single* pass reaches a given record or not depending on how that
 * record's id sorts — and ids are random. Asserting on one pass tested the id order as
 * much as the retirement rules, which is why adding unrelated records to this file made
 * an assertion about expiry fail. Two passes with a batch wider than the store cover
 * the whole ring whatever the cursor was, which is the contract worth testing.
 */
function drainMaintenance(db: DatabaseSync, now: number): Record<string, number> {
  const reasons: Record<string, number> = {}
  for (let pass = 0; pass < 2; pass += 1) {
    const result = maintain(db, { now, batchSize: 1000 })
    for (const [reason, count] of Object.entries(result.reasons)) {
      reasons[reason] = (reasons[reason] ?? 0) + count
    }
  }
  return reasons
}

export function run(): void {
  // ── Content identity ─────────────────────────────────────────────────────
  eq(normalizeContent('  Hello   WORLD '), 'hello world', 'case and spacing fold away')
  eq(fingerprint('fact', 'B'), fingerprint('fact', '  b '), 'trivial rewording keeps identity')
  assert(fingerprint('fact', 'B') !== fingerprint('experience', 'B'), 'the kind is part of identity')
  assert(fingerprint('fact', 'B') !== fingerprint('fact', 'C'), 'different bodies differ')

  const dir = mkdtempSync(join(tmpdir(), 'expmem-life-'))
  const db: DatabaseSync = openDb(join(dir, 'memory.db'))
  try {
    // ── An unverifiable claim becomes a candidate, never confirmed ─────────
    const weak = remember(db, {
      workspaceId: 'ws1', domain: DOMAIN, kind: 'experience',
      title: '部署目标盘', body: '部署写到 F 盘', now: NOW,
    })
    eq(weak.outcome, 'created', 'a new claim is created')
    eq(weak.record.status, 'candidate', 'an unverifiable claim stays a candidate')
    eq(weak.grade, 'inferred', 'and is graded as an inference')
    eq(weak.corroborations, 1, 'one workspace has reported it')

    // ── The same claim from the same workspace corroborates, never duplicates
    const again = remember(db, {
      workspaceId: 'ws1', domain: DOMAIN, kind: 'experience',
      title: '部署目标盘', body: '部署写到 F 盘', now: NOW + 1000,
    })
    eq(again.outcome, 'corroborated', 're-reporting corroborates')
    eq(again.record.id, weak.record.id, 'corroboration reuses the record id')
    eq(again.corroborations, 1, 'the same workspace does not corroborate twice')

    // ── A verified passage promotes it ─────────────────────────────────────
    const quote = '部署一律写到 F 盘，不要写 C 盘'
    const verified = remember(db, {
      workspaceId: 'ws1', domain: DOMAIN, kind: 'experience',
      title: '部署目标盘', body: '部署写到 F 盘', quote,
      agent: sessionSaying(quote, dir), now: NOW + 2000,
    })
    eq(verified.grade, 'verified-user', 'a verbatim user assertion verifies')
    eq(verified.record.status, 'confirmed', 'a verified claim is confirmed')
    eq(verified.outcome, 'corroborated', 'and it upgrades the existing record rather than adding one')

    // ── A reworded re-record retires the candidate it replaced ─────────────
    // Three such pairs were found in a live store, all formed the same way: record
    // with no passage, see it graded `inferred`, re-record it with a file quote.
    // Identity is the assertion, so the reworded body became a *second* record and the
    // candidate stayed forever — invisible, un-injectable, and swept by nothing.
    const stranded = remember(db, {
      workspaceId: 'ws-dup', domain: DOMAIN, kind: 'fact',
      title: '采集上限', body: '单次最多 500 条，超了会静默截断。', now: NOW,
    })
    eq(stranded.record.status, 'candidate', 'a claim with no passage is a candidate')
    const replaced = remember(db, {
      workspaceId: 'ws-dup', domain: DOMAIN, kind: 'fact',
      // Deliberately punctuated differently from the candidate's title: a live pair
      // differed only by the 「」 around one word, which exact equality read as two
      // different claims and left the candidate stranded.
      title: '「采集上限」',
      body: 'ingest.batchSize 只能取 1..500；供货方超限静默截断，调大只会丢数据。',
      quote: '单次最多 500 条', agent: sessionSaying('单次最多 500 条', dir), now: NOW + 1000,
    })
    assert(replaced.record.id !== stranded.record.id,
      'the reworded body is a different record, because identity is the assertion')
    eq(getRecord(db, stranded.record.id)?.status, 'retired',
      'so the candidate it replaces is retired')
    eq(getRecord(db, stranded.record.id)?.supersededBy, replaced.record.id,
      'and it names its replacement, which is what makes the call auditable')
    assert(getRecord(db, stranded.record.id)?.body !== '',
      'retired, not deleted — a wrong call is reversible')

    // The retirement reason has to name the grade that actually applies. This sentence
    // used to be the literal "the same claim recorded with a verifiable passage" on
    // every path, and a caller caught it: two *failed* writes produced a retirement
    // whose stated ground was a passage neither record had.
    const reasonOf = (id: string): string => (
      db.prepare('SELECT reason FROM correction WHERE record_id = ? ORDER BY at DESC LIMIT 1')
        .get(id) as { reason: string } | undefined
    )?.reason ?? ''
    assert(reasonOf(stranded.record.id).includes('with a verifiable passage'),
      `a graded replacement says so: ${reasonOf(stranded.record.id)}`)

    const ungradedFirst = remember(db, {
      workspaceId: 'ws-dup', domain: DOMAIN, kind: 'fact',
      title: '未定等级的重复', body: '第一次写下来，没有出处。', now: NOW + 2000,
    })
    const ungradedSecond = remember(db, {
      workspaceId: 'ws-dup', domain: DOMAIN, kind: 'fact',
      title: '未定等级的重复', body: '第二次写下来，同样没有出处。', now: NOW + 3000,
    })
    eq(ungradedSecond.record.status, 'candidate', 'a replacement with no passage is a candidate too')
    eq(getRecord(db, ungradedFirst.record.id)?.status, 'retired', 'and it still retires the earlier copy')
    const ungradedReason = reasonOf(ungradedFirst.record.id)
    assert(!ungradedReason.includes('the same claim recorded with a verifiable passage'),
      `so the reason must not borrow the graded wording: ${ungradedReason}`)
    assert(ungradedReason.includes('no verifiable passage either'),
      `it says what actually happened instead: ${ungradedReason}`)

    // The handle is a title, so the sweep reaches no further than one workspace.
    const elsewhere = remember(db, {
      workspaceId: 'ws-other', domain: DOMAIN, kind: 'fact',
      title: '采集上限', body: '另一个工作区的同标题候选。', now: NOW + 500,
    })
    remember(db, {
      workspaceId: 'ws-dup', domain: DOMAIN, kind: 'fact',
      title: '采集上限', body: '同标题的又一条改写版。',
      quote: '单次最多 500 条', agent: sessionSaying('单次最多 500 条', dir), now: NOW + 1500,
    })
    eq(getRecord(db, elsewhere.record.id)?.status, 'candidate',
      'a candidate in another workspace is not this record’s to retire')

    // ── A second, different workspace promotes the lesson to its domain ────
    const promoted = remember(db, {
      workspaceId: 'ws2', domain: DOMAIN, kind: 'experience',
      title: '部署目标盘', body: '部署写到 F 盘', now: NOW + 3000,
    })
    eq(promoted.outcome, 'promoted', 'a second distinct workspace promotes the lesson')
    eq(promoted.corroborations, 2, 'two distinct workspaces are counted')
    eq(promoted.record.scope, 'domain', 'the promoted record is domain-scoped')
    eq(promoted.record.domain, DOMAIN, 'and carries the resolved domain')

    // Exactly one live copy must remain: the earlier workspace copy is absorbed.
    const live = db.prepare(
      "SELECT count(*) AS n FROM record WHERE content_fingerprint = ? AND status != 'retired'",
    ).get(weak.record.contentFingerprint) as { n: number }
    eq(live.n, 1, 'promotion leaves exactly one live copy, not one per scope')
    const retiredCopy = db.prepare(
      "SELECT superseded_by AS s FROM record WHERE content_fingerprint = ? AND status = 'retired'",
    ).get(weak.record.contentFingerprint) as { s: string | null } | undefined
    eq(retiredCopy?.s, promoted.record.id, 'the absorbed workspace copy points at its replacement')

    // ── A third workspace in the same domain now sees it ───────────────────
    const seen = retrieve(db, {
      workspaceId: 'ws3', domain: DOMAIN, query: '部署', now: NOW + 4000, limit: 10, tier: 'recall',
    })
    eq(seen.ranked.map(r => r.record.id), [promoted.record.id], 'the shared lesson reaches another workspace')
    const hidden = retrieve(db, {
      workspaceId: 'ws3', domain: 'other/domain', query: '部署', now: NOW + 4000, limit: 10, tier: 'recall',
    })
    eq(hidden.ranked, [], 'a different domain does not see it')

    // ── Outcome linkage ────────────────────────────────────────────────────
    const ok = recordUsage(db, {
      recordId: promoted.record.id, outcome: 'success', now: NOW + 5000, failStreakLimit: 2,
    })
    eq(ok.outcome, 'recorded', 'a success is recorded')
    eq(ok.record?.successCount, 1, 'the success count rises')
    eq(ok.failStreak, 0, 'a success clears the failure streak')

    recordUsage(db, { recordId: promoted.record.id, outcome: 'failure', now: NOW + 6000, failStreakLimit: 2 })
    const second = recordUsage(db, {
      recordId: promoted.record.id, outcome: 'failure', now: NOW + 7000, failStreakLimit: 2,
    })
    eq(second.outcome, 'retired', 'two consecutive failures retire the record')
    eq(second.record?.status, 'retired', 'and the status says so')
    assert((second.record?.needsReview ?? '') !== '', 'a demotion records why, without assuming causality')
    eq(recordUsage(db, { recordId: 'nope', outcome: 'success', now: NOW, failStreakLimit: 2 }).outcome, 'missing',
      'an unknown record is reported, not thrown')

    // ── Retirement is reversible; purge is not ─────────────────────────────
    const forRetire = remember(db, {
      workspaceId: 'ws1', domain: DOMAIN, kind: 'fact', title: '临时', body: '一条会被遗忘的记录', now: NOW,
    })
    eq(forget(db, { recordId: forRetire.record.id, reason: '不再适用', actor: 'agent', now: NOW + 8000 }), 'retired',
      'forget retires by default')
    assert(db.prepare('SELECT 1 FROM record WHERE id = ?').get(forRetire.record.id) !== undefined,
      'a retired record keeps its bytes')
    assert(db.prepare('SELECT 1 FROM correction WHERE record_id = ?').get(forRetire.record.id) !== undefined,
      'and the audit log records the reason')
    eq(retrieve(db, {
      workspaceId: 'ws1', domain: DOMAIN, query: '遗忘', now: NOW + 9000, limit: 5, tier: 'recall',
    }).ranked, [], 'a retired record is not recalled by default')

    const forPurge = remember(db, {
      workspaceId: 'ws1', domain: DOMAIN, kind: 'fact', title: '机密', body: '一条必须删除的记录', now: NOW,
    })
    eq(forget(db, {
      recordId: forPurge.record.id, reason: '用户要求删除', actor: 'agent', purge: true, now: NOW + 10000,
    }), 'purged', 'purge deletes')
    eq(db.prepare('SELECT 1 FROM record WHERE id = ?').get(forPurge.record.id), undefined, 'the bytes are gone')
    eq(db.prepare('SELECT 1 FROM record_fts WHERE id = ?').get(forPurge.record.id), undefined,
      'and the index row with them')
    eq(forget(db, { recordId: 'nope', reason: 'x', actor: 'agent', now: NOW }), 'missing', 'an unknown id is missing')

    // ── A purge has to take its corroboration with it ──────────────────────
    // A corroboration row means "this workspace independently reported this content", and
    // two of them are what promote a lesson to its domain. A row whose record is gone
    // keeps asserting it, so the next *single* report of that content counts as two
    // independent workspaces — the one gate that exists to require independent
    // confirmation, satisfied by one observation. Found in a live store: a purged
    // end-to-end test artifact left exactly such a row behind.
    const fingerprintOf = (id: string): string =>
      (db.prepare('SELECT content_fingerprint AS f FROM record WHERE id = ?').get(id) as { f: string }).f
    const corroborationsFor = (fp: string): number =>
      (db.prepare('SELECT count(*) AS n FROM corroboration WHERE fingerprint = ?').get(fp) as { n: number }).n

    const secret = remember(db, {
      workspaceId: 'ws-purge', domain: DOMAIN, kind: 'fact',
      title: '待彻底删除', body: '这段内容被要求从库里彻底删除。', now: NOW + 11000,
    })
    const secretPrint = fingerprintOf(secret.record.id)
    eq(corroborationsFor(secretPrint), 1, 'the report is corroborated while its record lives')
    eq(forget(db, {
      recordId: secret.record.id, reason: '用户要求彻底删除', actor: 'agent', purge: true, now: NOW + 12000,
    }), 'purged', 'the record is purged')
    eq(corroborationsFor(secretPrint), 0,
      'and the purge takes the corroboration with it, so one later report cannot count as two')

    // The other direction, which is why the row is not simply deleted by fingerprint: one
    // workspace purging its copy must not withdraw another workspace's independent report.
    const sharedBody = '两个工作区各自独立得出同一条结论。'
    const inA = remember(db, {
      workspaceId: 'ws-a', domain: DOMAIN, kind: 'fact', title: '共享结论', body: sharedBody, now: NOW + 13000,
    })
    const sharedPrint = fingerprintOf(inA.record.id)
    const inB = remember(db, {
      workspaceId: 'ws-b', domain: DOMAIN, kind: 'fact', title: '共享结论', body: sharedBody, now: NOW + 14000,
    })
    eq(corroborationsFor(sharedPrint), 2, 'two workspaces have reported it')
    eq(forget(db, {
      recordId: inA.record.id, reason: 'A 工作区要求删除', actor: 'agent', purge: true, now: NOW + 15000,
    }), 'purged', 'A purges its copy')
    eq(corroborationsFor(sharedPrint), 1, "and B's independent report survives it")
    assert(db.prepare('SELECT 1 FROM record WHERE id = ?').get(inB.record.id) !== undefined,
      'because the record that justifies it is untouched')

    // ── Decay rules ────────────────────────────────────────────────────────
    const asRecord = (over: Partial<MemoryRecord>): MemoryRecord => ({
      ...promoted.record, ...over,
    })
    eq(retirementReason(asRecord({ expiresAt: NOW - 1, lastUsedAt: NOW }), NOW), 'expired', 'an expired record retires')
    eq(retirementReason(asRecord({
      expiresAt: null, reviewAfter: NOW - (REVIEW_GRACE_DAYS + 1) * DAY, reuseCount: 0, successCount: 0, lastUsedAt: NOW,
    }), NOW), 'review overdue and never reused', 'an unchecked review retires once the grace passes')
    eq(retirementReason(asRecord({
      expiresAt: null, reviewAfter: NOW - (REVIEW_GRACE_DAYS + 1) * DAY, reuseCount: 3, successCount: 3, lastUsedAt: NOW,
    }), NOW), undefined, 'a reused record survives an overdue review')
    eq(retirementReason(asRecord({
      expiresAt: null, reviewAfter: null, evidence: 'inferred', reuseCount: 0, successCount: 0,
      createdAt: NOW - (STALE_DAYS + 1) * DAY, lastUsedAt: null,
    }), NOW), 'never reused and below the retire floor', 'a stale, unused, low-grade record retires')
    eq(retirementReason(asRecord({
      expiresAt: null, reviewAfter: null, evidence: 'verified-tool', successCount: 5, reuseCount: 5, lastUsedAt: NOW,
    }), NOW), undefined, 'a well-used verified record does not')

    // ── Maintenance is bounded and resumable ───────────────────────────────
    for (let i = 0; i < 6; i += 1) {
      remember(db, {
        workspaceId: 'ws1', domain: DOMAIN, kind: 'fact',
        title: `陈旧${i}`, body: `一条陈旧记录 ${i}`, now: NOW - (STALE_DAYS + 10) * DAY,
      })
    }
    // Backdate them so the staleness rule applies to the stored rows.
    db.prepare('UPDATE record SET created_at = ?, last_used_at = NULL, evidence = ?, status = ? WHERE title LIKE ?')
      .run(NOW - (STALE_DAYS + 10) * DAY, 'inferred', 'confirmed', '陈旧%')

    // Which ids land in a bounded batch is random — ids are random — so how many a *single*
    // pass retires is a property of id order, not of the rules. That is the fragility the note
    // above `drainMaintenance` records. Bounded-ness and resumability are asserted on the two
    // bounded passes; the retirement contract is asserted over the drained ring, so it holds
    // whichever ids sorted first.
    const first = maintain(db, { now: NOW, batchSize: 3 })
    eq(first.scanned, 3, 'a pass scans at most the batch size')
    const secondPass = maintain(db, { now: NOW, batchSize: 3 })
    eq(secondPass.scanned, 3, 'the next pass resumes rather than rescanning from the start')

    const drainedEarly = drainMaintenance(db, NOW)
    const retiredTotal = first.retired + secondPass.retired
      + Object.values(drainedEarly).reduce((sum, n) => sum + n, 0)
    assert(retiredTotal >= 2, 'the passes retire what has aged out')
    assert(retiredTotal > 0 && (first.retired > 0 || secondPass.retired > 0 || Object.keys(drainedEarly).length >= 1),
      'and report why')

    // ── The pass repairs rows an older purge left behind ───────────────────
    // A store written before `deleteRecord` cleaned up after itself still carries the
    // row, and the repair must not wait for the same content to be purged a second time.
    const stale = remember(db, {
      workspaceId: 'ws-legacy', domain: DOMAIN, kind: 'fact',
      title: '旧库遗留', body: '旧版本 purge 留下的无主印证。', now: NOW + 16000,
    })
    const stalePrint = (db.prepare('SELECT content_fingerprint AS f FROM record WHERE id = ?')
      .get(stale.record.id) as { f: string }).f
    // Reproduce the old behaviour exactly: drop the record, leave the corroboration.
    db.prepare('DELETE FROM record_fts WHERE id = ?').run(stale.record.id)
    db.prepare('DELETE FROM record WHERE id = ?').run(stale.record.id)
    eq(db.prepare('SELECT count(*) AS n FROM corroboration WHERE fingerprint = ?').get(stalePrint).n, 1,
      'the orphan row is there, as an older version would have left it')
    const repair = maintain(db, { now: NOW + 17000, batchSize: 1000 })
    assert(repair.orphanCorroborations >= 1, 'the pass counts the rows it repaired')
    eq(db.prepare('SELECT count(*) AS n FROM corroboration WHERE fingerprint = ?').get(stalePrint).n, 0,
      'and the orphan is gone')

    // ── A window can be armed, and both halves of the machinery honour it ──
    // Before this existed, `expiresAt` and `reviewAfter` could only be filled by
    // the legacy importer, so two of the three retirement paths were unreachable
    // for anything the plugin recorded itself.
    const expiring = remember(db, {
      workspaceId: 'ws1', domain: DOMAIN, kind: 'fact',
      title: '当前测试命令', body: '用 node tests/run.ts 跑测试', now: NOW,
      expiresAt: NOW + 5 * DAY,
    })
    eq(expiring.record.expiresAt, NOW + 5 * DAY, 'the record carries the expiry it was given')
    eq(expiring.record.status, 'candidate', 'and it is still a candidate without a passage')
    db.prepare('UPDATE record SET status = ?, evidence = ? WHERE id = ?')
      .run('confirmed', 'verified-user', expiring.record.id)

    const before = retrieve(db, {
      workspaceId: 'ws1', domain: DOMAIN, query: '测试命令', now: NOW, limit: 10, tier: 'recall',
    })
    assert(before.ranked.some(entry => entry.record.id === expiring.record.id),
      'a record inside its window is retrievable')

    const after = retrieve(db, {
      workspaceId: 'ws1', domain: DOMAIN, query: '测试命令', now: NOW + 6 * DAY, limit: 10, tier: 'recall',
    })
    assert(!after.ranked.some(entry => entry.record.id === expiring.record.id),
      'once past its expiry it stops being returned, without anyone running maintenance')
    assert((after.excluded['expired'] ?? 0) >= 1, 'and the exclusion is counted, not silent')

    const retired = { reasons: drainMaintenance(db, NOW + 6 * DAY) }
    assert((retired.reasons['expired'] ?? 0) >= 1, 'maintenance then retires it, naming the reason')

    // A review window, by contrast, does not remove anything until the grace
    // period has passed with nothing having reused the record.
    const awaitingReview = remember(db, {
      workspaceId: 'ws1', domain: DOMAIN, kind: 'fact',
      title: '需要复核', body: '这条到期后需要复核而不是直接退役', now: NOW,
      reviewAfter: NOW + 1 * DAY,
    })
    db.prepare('UPDATE record SET status = ?, evidence = ? WHERE id = ?')
      .run('confirmed', 'verified-user', awaitingReview.record.id)
    const insideGrace = { reasons: drainMaintenance(db, NOW + 5 * DAY) }
    eq(insideGrace.reasons['review overdue and never reused'] ?? 0, 0,
      'the review date alone does not retire a record; the grace period has to pass first')
    const pastGrace = { reasons: drainMaintenance(db, NOW + (1 + REVIEW_GRACE_DAYS + 1) * DAY) }
    assert((pastGrace.reasons['review overdue and never reused'] ?? 0) >= 1,
      'and once it has, an unreused record is retired for review')

    // A record that has actually been used is not retired for review. The review
    // window exists to notice what nothing needs, not to punish age.
    const reused = remember(db, {
      workspaceId: 'ws1', domain: DOMAIN, kind: 'fact',
      title: '被复用的记录', body: '这条被复用过，所以不该因复核逾期退役', now: NOW,
      reviewAfter: NOW + 1 * DAY,
    })
    db.prepare('UPDATE record SET status = ?, evidence = ? WHERE id = ?')
      .run('confirmed', 'verified-user', reused.record.id)
    recordUsage(db, {
      recordId: reused.record.id, outcome: 'success', now: NOW + 2 * DAY, failStreakLimit: 2,
    })
    drainMaintenance(db, NOW + (1 + REVIEW_GRACE_DAYS + 1) * DAY)
    const survivedReview = (db.prepare('SELECT status FROM record WHERE id = ?')
      .get(reused.record.id) as { status: string }).status
    eq(survivedReview, 'confirmed', 'a record that has been reused survives the review deadline')

    // A window that has already closed is a caller mistake, not a silent retire.
    let rejected = false
    try {
      remember(db, {
        workspaceId: 'ws1', domain: DOMAIN, kind: 'fact',
        title: '昨天就过期了', body: '这条的窗口在过去', now: NOW, expiresAt: NOW - DAY,
      })
    } catch (error) {
      rejected = error instanceof TypeError
    }
    assert(rejected, 'a window in the past is rejected rather than stored to be retired immediately')

    // Re-reporting the same claim with a fresh window is re-verification.
    const refreshed = remember(db, {
      workspaceId: 'ws1', domain: DOMAIN, kind: 'fact',
      title: '当前测试命令', body: '用 node tests/run.ts 跑测试', now: NOW + 2 * DAY,
      expiresAt: NOW + 30 * DAY,
    })
    eq(refreshed.outcome, 'corroborated', 'the same claim corroborates instead of duplicating')
    eq(refreshed.record.expiresAt, NOW + 30 * DAY, 'and the new window replaces the old one')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }

  // ── Provenance: a cited file that is no longer there ─────────────────────
  // The grade proves the quote is in a file *at write time*. It says nothing about a week
  // later — and when the file is gone the record turns harmful: a real model asked to trust
  // it looks for the cited file, fails, and throws the record away (docs §17). Maintenance
  // is where that gets caught, because it is the only place that is not on the hot path.
  const provRoot = mkdtempSync(join(tmpdir(), 'expmem-prov-'))
  try {
    writeFileSync(join(provRoot, 'CONVENTIONS.md'), '部署配置必须先声明 vault 路径。\n', 'utf8')
    // Its own store: the suite's db is already closed at this point, and this check must not
    // depend on where that lifecycle happened to end.
    const provDb = openDb(join(provRoot, 'prov.db'))
    try {
      const make = (over: Partial<MemoryRecord>): MemoryRecord => ({
        id: 'r1',
        workspaceId: 'wsA',
        domain: DOMAIN,
        scope: 'workspace',
        kind: 'fact',
        status: 'confirmed',
        evidence: 'verified-file',
        title: '标题',
        body: '正文',
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
        contentFingerprint: 'fp',
        supersededBy: null,
        needsReview: null,
        ...over,
      })

      const citingReal = make({ id: 'p-real', contentFingerprint: 'fp-real', sourceRef: 'CONVENTIONS.md:1' })
      const citingGone = make({ id: 'p-gone', contentFingerprint: 'fp-gone', sourceRef: 'docs/DEPLOY.md:2' })
      const citingTool = make({ id: 'p-tool', contentFingerprint: 'fp-tool', evidence: 'verified-tool', sourceRef: 'call_00_abc' })
      const citingProse = make({ id: 'p-prose', contentFingerprint: 'fp-prose', evidence: 'verified-user', sourceRef: '' })
      for (const record of [citingReal, citingGone, citingTool, citingProse]) upsert(provDb, record)

      const all = [citingReal, citingGone, citingTool, citingProse]
      eq(checkProvenance(provDb, all, provRoot), 1,
        'exactly one record is flagged: the verified-file one whose file is gone')
      assert(String(getRecord(provDb, 'p-gone')?.needsReview ?? '').startsWith(SOURCE_GONE),
        'and it is flagged with a note naming the missing file')
      eq(getRecord(provDb, 'p-real')?.needsReview ?? null, null,
        'a record whose cited file exists is left alone')
      eq(getRecord(provDb, 'p-tool')?.needsReview ?? null, null,
        'a tool-call citation is not a path and is not checked')
      eq(getRecord(provDb, 'p-prose')?.needsReview ?? null, null,
        'a user assertion has no file to check')

      // Idempotent across passes. Note the records are re-read: maintenance re-scans from the
      // store every pass, so a second call holding stale objects would test the fixture rather
      // than the rule.
      const reread = [citingReal, citingGone, citingTool, citingProse]
        .map(r => getRecord(provDb, r.id)!)
      eq(checkProvenance(provDb, reread, provRoot), 0,
        'a repeat pass adds no duplicate note')
      eq((getRecord(provDb, 'p-gone')?.needsReview ?? '').split(SOURCE_GONE).length - 1, 1,
        'with exactly one note on the record')

      // The file comes back (a restore): the note must go with its cause.
      mkdirSync(join(provRoot, 'docs'), { recursive: true })
      writeFileSync(join(provRoot, 'docs', 'DEPLOY.md'), 'x\n', 'utf8')
      const restored = getRecord(provDb, 'p-gone')
      eq(checkProvenance(provDb, [restored!], provRoot), 0, 'restoring the file is not a new flag')
      eq(getRecord(provDb, 'p-gone')?.needsReview ?? null, null,
        'and the stale note is cleared with its cause')

      // A wrong root must not silently mass-flag: nothing is checked without one.
      eq(checkProvenance(provDb, all, ''), 0,
        'without a workspace root nothing is checked, rather than everything being flagged')

      // And it is wired into the maintenance pass, not just a function that exists.
      rmSync(join(provRoot, 'docs', 'DEPLOY.md'), { force: true })
      const result = maintain(provDb, { now: NOW, batchSize: 64, workspaceRoot: provRoot })
      eq(result.provenanceFlags, 1, 'the maintenance pass reports the provenance flag it wrote')
      assert(String(getRecord(provDb, 'p-gone')?.needsReview ?? '').startsWith(SOURCE_GONE),
        'and the note is on the record the maintenance pass scanned')
    } finally {
      provDb.close()
    }
  } finally {
    rmSync(provRoot, { recursive: true, force: true })
  }

  console.log('  lifecycle  ok')
}
