/**
 * Census regressions.
 *
 * The census answers "what is actually in the store" and "how many records would
 * clear the resident bar right now". Both numbers are easy to get subtly wrong —
 * counting candidates as injectable, or omitting the append-only audit trail —
 * so each is pinned here.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, eq } from './assert.ts'
import { noteCorrection, noteUsage, openDb, upsert } from '../src/db.ts'
import type { DatabaseSync } from 'node:sqlite'
import { census, renderCensus } from '../src/census.ts'
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
  }
}

export function run(): void {
  const dir = mkdtempSync(join(tmpdir(), 'expmem-census-'))
  const db: DatabaseSync = openDb(join(dir, 'memory.db'))
  try {
    upsert(db, make({ id: 'strong', evidence: 'verified-tool', contentFingerprint: 'fp-strong' }))
    // A verified-file record past its freshness window: strong enough in principle,
    // but it does not clear the bar on age alone.
    upsert(db, make({
      id: 'weak', evidence: 'verified-file', contentFingerprint: 'fp-weak',
      createdAt: NOW - 200 * DAY, lastUsedAt: null,
    }))
    upsert(db, make({ id: 'cand', status: 'candidate', contentFingerprint: 'fp-cand' }))
    upsert(db, make({ id: 'retired', status: 'retired', contentFingerprint: 'fp-retired' }))
    upsert(db, make({
      id: 'domain', scope: 'domain', domain: 'python/testing', evidence: 'verified-user',
      contentFingerprint: 'fp-domain',
    }))
    upsert(db, make({ id: 'other-ws', workspaceId: 'wsB', evidence: 'verified-file', contentFingerprint: 'fp-other' }))

    noteUsage(db, 'strong', 'success', NOW - DAY, 'session-1', 1)
    noteUsage(db, 'strong', 'success', NOW - DAY / 2, 'session-1', 2)
    noteUsage(db, 'weak', 'failure', NOW - DAY, 'session-1', 3)
    noteCorrection(db, 'retired', 'experience-memory', '维护：连续失败', NOW - DAY)
    noteCorrection(db, 'weak', 'experience-memory', '复核逾期', NOW - 2 * DAY)

    const result = census(db, { now: NOW })

    // ── Record counts ─────────────────────────────────────────────────────
    eq(result.records, 6, 'every record is counted')
    eq(result.byStatus['confirmed'], 4, 'confirmed records are grouped')
    eq(result.byStatus['candidate'], 1, 'and so are candidates')
    eq(result.byStatus['retired'], 1, 'and retired ones')
    eq(result.byEvidence['verified-tool'] ?? 0, 3, 'evidence grades are grouped')
    eq(result.byEvidence['verified-file'] ?? 0, 2, 'including repeats of one grade')
    eq(result.byEvidence['verified-user'] ?? 0, 1, 'and the remaining grade')
    eq(result.byScope['workspace'], 5, 'scopes are grouped')
    eq(result.byScope['domain'], 1, 'including domain scope')

    // ── Resident eligibility is measured, not assumed ─────────────────────
    // Only confirmed records are examined: a candidate is never injectable, so
    // including it would inflate the number a reader trusts.
    eq(result.residentScanned, 4, 'only confirmed records are examined')
    eq(result.residentTruncated, false, 'a small store is not reported as truncated')
    // `strong` (verified-tool, 9.0) and `domain` (verified-user, 7.5) clear the bar
    // comfortably. `other-ws` is a *fresh* verified-file record, whose base score is
    // exactly 6.0 against a bar of 6.0 — so it is eligible by the width of the
    // comparison, and any age at all would push it under. `weak` is the same grade
    // 200 days old, and is not. That contrast is the whole reason the count is
    // computed with the real ranking functions rather than estimated.
    eq(result.residentEligible, 3, 'a fresh verified-file record sits exactly on the bar')
    eq(result.residentEligible, result.residentScanned - 1, 'and the aged one falls below it')
    const eligibleIds = ['strong', 'domain', 'other-ws']
    for (const id of eligibleIds) {
      assert(db.prepare('SELECT status FROM record WHERE id = ?').get(id) !== undefined,
        `${id} is one of the records the count is built from`)
    }

    // ── The audit trail has a reader ──────────────────────────────────────
    eq(result.usage.total, 3, 'every usage row is counted')
    eq(result.usage.successes, 2, 'successes are separated from failures')
    eq(result.usage.failures, 1, 'and failures counted')
    eq(result.corrections, 2, 'correction rows are counted')

    // ── Retirements, newest first, with the reason ────────────────────────
    eq(result.retirements.length, 1, 'only the retired record is listed')
    eq(result.retirements[0]?.id, 'retired', 'and it is the retired one')
    eq(result.retirements[0]?.reason, '维护：连续失败', 'with the reason from its correction row')

    // A retired record with no correction row must not claim a reason it lacks.
    upsert(db, make({ id: 'silent', status: 'retired', contentFingerprint: 'fp-silent' }))
    const withoutReason = census(db, { now: NOW })
    eq(withoutReason.retirements.find(item => item.id === 'silent')?.reason, 'unknown',
      'a retirement with no correction row says so instead of inventing one')

    // ── Rendering ─────────────────────────────────────────────────────────
    const text = renderCensus(result, { dbPath: 'C:/somewhere/memory.db' })
    assert(text.includes('C:/somewhere/memory.db'), 'the rendered census names the database')
    assert(text.includes('常驻合格 3/4'), 'and states eligibility as eligible over examined')
    assert(text.includes('已退役 1 条'), 'and lists retirements')
    assert(text.includes('维护：连续失败'), 'with their reasons')
    const bare = renderCensus(result)
    assert(!bare.includes('库：'), 'without a path when none is given')

    // ── An empty store is a valid answer ──────────────────────────────────
    const emptyDb: DatabaseSync = openDb(join(dir, 'empty.db'))
    try {
      const empty = census(emptyDb, { now: NOW })
      eq(empty.records, 0, 'an empty store reports zero records')
      eq(empty.residentEligible, 0, 'and nothing eligible')
      eq(empty.retirements, [], 'and nothing retired')
      assert(renderCensus(empty).includes('记录 0 条'), 'and renders without special-casing')
    } finally {
      emptyDb.close()
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  census     ok')
}
