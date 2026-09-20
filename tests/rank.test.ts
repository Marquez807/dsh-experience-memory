/**
 * Ranking regressions.
 *
 * The archived runtime ordered its always-on pack by `uuid4` string, so the
 * eight records that reached the model were an arbitrary frozen sample. These
 * cases pin the replacement: an explicit, bounded, monotone score.
 */
import { assert, eq } from './assert.ts'
import { compareRanked, eligibleForResident, importance, RETIRE_FLOOR, type ImportanceFacts } from '../src/rank.ts'
import type { MemoryRecord, RankedRecord } from '../src/types.ts'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

function facts(over: Partial<ImportanceFacts> = {}): ImportanceFacts {
  return {
    evidence: 'verified-tool',
    successCount: 0,
    reuseCount: 0,
    failStreak: 0,
    distinctWorkspaces: 1,
    createdAt: NOW,
    lastUsedAt: null,
    reviewAfter: null,
    now: NOW,
    identifierMatches: 0,
    ...over,
  }
}

function record(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'r1',
    workspaceId: 'ws1',
    domain: '',
    scope: 'workspace',
    kind: 'experience',
    status: 'confirmed',
    evidence: 'verified-tool',
    title: 't',
    body: 'b',
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
    lastUsedAt: null,
    reviewAfter: null,
    expiresAt: null,
    contentFingerprint: 'fp',
    supersededBy: null,
    needsReview: null,
    ...over,
  }
}

export function run(): void {
  // ── Evidence grade dominates, and the order is total ──────────────────────
  const tool = importance(facts({ evidence: 'verified-tool' }))
  const user = importance(facts({ evidence: 'verified-user' }))
  const file = importance(facts({ evidence: 'verified-file' }))
  const inferred = importance(facts({ evidence: 'inferred' }))
  assert(tool > user && user > file && file > inferred, 'evidence grades must rank tool > user > file > inferred')

  // ── Guard against the archived `inferred`-as-fact failure mode ────────────
  assert(importance(facts({ evidence: 'inferred' })) < 6.0,
    'a plain inference must stay below the resident threshold no matter what')

  // ── Consecutive failure suppresses ────────────────────────────────────────
  assert(importance(facts({ failStreak: 2 })) < importance(facts({ failStreak: 0 })),
    'a failure streak must lower importance')

  // ── Verified reuse raises ─────────────────────────────────────────────────
  assert(importance(facts({ successCount: 4 })) > importance(facts({ successCount: 0 })),
    'successful reuse must raise importance')
  assert(importance(facts({ distinctWorkspaces: 5 })) > importance(facts({ distinctWorkspaces: 1 })),
    'cross-workspace corroboration must raise importance')

  // ── Staleness decays, and never below zero influence ─────────────────────
  const fresh = importance(facts({ lastUsedAt: NOW }))
  const stale = importance(facts({ lastUsedAt: NOW - 200 * DAY }))
  assert(stale < fresh, 'an unused record must decay')
  assert(Number.isFinite(importance(facts({ lastUsedAt: NOW - 100_000 * DAY }))),
    'extreme staleness must stay finite')

  // ── Identifier bonus is real but CAPPED ───────────────────────────────────
  // Archived defect: the recovered downstream patch sorted on
  // `identifier_matches DESC` with no ceiling, so one prose phrase beat every
  // BM25 score. The bonus must saturate.
  const none = importance(facts({ identifierMatches: 0 }))
  const one = importance(facts({ identifierMatches: 1 }))
  const many = importance(facts({ identifierMatches: 50 }))
  assert(one > none, 'an identifier hit must help')
  eq(many - one, 1.0, 'the identifier bonus saturates at its cap')

  // ── Resident eligibility ─────────────────────────────────────────────────
  const high = 99
  assert(eligibleForResident(record(), high, NOW), 'a confirmed verified record is resident-eligible')
  assert(!eligibleForResident(record({ status: 'candidate' }), high, NOW), 'a candidate is never resident')
  assert(!eligibleForResident(record({ status: 'retired' }), high, NOW), 'a retired record is never resident')
  assert(!eligibleForResident(record({ evidence: 'inferred' }), high, NOW), 'an inference is never resident')
  assert(!eligibleForResident(record({ expiresAt: NOW - 1 }), high, NOW), 'an expired record is never resident')
  assert(!eligibleForResident(record(), 5.9, NOW), 'importance below the threshold is not resident')

  // ── Ordering is total and stable ─────────────────────────────────────────
  const mk = (id: string, score: number, bm25: number): RankedRecord => ({
    record: record({ id }), importance: score, bm25, identifierMatches: 0, why: '',
  })
  const sorted = [mk('b', 7, -1), mk('a', 7, -1), mk('c', 9, -5)].sort(compareRanked).map(r => r.record.id)
  eq(sorted, ['c', 'a', 'b'], 'importance first, then stable id')
  const bm = [mk('z', 7, -1), mk('y', 7, -9)].sort(compareRanked).map(r => r.record.id)
  eq(bm, ['y', 'z'], 'more relevant bm25 (more negative) wins the tie')

  // ── Thresholds are ordered, so maintenance can never retire what is resident
  assert(RETIRE_FLOOR < 6.0, 'the retire floor must sit below the resident threshold')

  console.log('  rank       ok')
}
