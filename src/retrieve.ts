/**
 * Retrieval: what a workspace may see, and in what order.
 *
 * Two archived defects are settled here.
 *
 * *Visibility was fail-open.* `visible()` read
 * `not session or session_id in ('', session)`, so an empty session skipped the
 * filter entirely and a search returned every other session's private records.
 * The documented manual workflow passed no session at all, so the leak was the
 * default path. Here an unknown workspace sees nothing: the guard is fail-closed.
 *
 * *Order was arbitrary.* The always-on pack sorted candidates by `uuid4`
 * string, so which eight records reached the model was decided at insert time
 * by chance and new memories had an `8/n` chance of appearing. Ordering is now
 * {@link rank.importance}, and it lives in one function.
 */
import { domainCoreRecords, searchRecords } from './db.ts'
import type { DatabaseSync } from 'node:sqlite'
import { compareRanked, eligibleForResident, explain, importance } from './rank.ts'
import { identifierKey, identifiers, lexicalQueryTerms, matchExpression, tokenize } from './tokenize.ts'
import type { MemoryRecord, RankedRecord, Status } from './types.ts'

/**
 * Candidate ceiling before ranking. The ranking pass therefore never scans the
 * whole table, whatever the size of the store.
 */
export const CANDIDATE_LIMIT = 512

/** Candidate ceiling for the core pass, which also ranks in memory. */
export const CORE_CANDIDATE_LIMIT = 128

/**
 * Distinct workspaces a record needs before it may be injected unconditionally.
 *
 * Two is the same bar domain promotion uses, and it is the whole justification
 * for injecting without a query: one project's habit is not a domain rule, but
 * two projects arriving at the same lesson independently is evidence.
 */
export const CORE_CORROBORATION_MIN = 2

/** Which layer a retrieval serves. */
export type Tier = 'resident' | 'recall'

/**
 * CJK function words: terms whose presence says nothing about what a text is about.
 *
 * Sharing one of these is not evidence of relevance, and FTS5's expression is an OR, so
 * a record that merely contained `这个值` was reaching the always-on digest for a turn
 * like "把这个仓库的 README 用一句话改写" — a question about nothing of the kind, and the
 * noise was invisible to the user. Measured on a real store, where the only overlap
 * between that record and that query was the single bigram `这个`.
 *
 * A list rather than a corpus frequency threshold, deliberately. Frequency does not
 * work in a store this small: `这个` appeared in one of three records, which any ratio
 * test reads as *rare*. What separates a function word from a content word is
 * linguistic, not statistical, so it is written down — incompletely, and extended when
 * a false injection is observed. A term wrongly left out costs one stray line; a term
 * wrongly included costs a record the model never sees, so the list stays short.
 */
const NON_TOPICAL_CJK: ReadonlySet<string> = new Set([
  '这个', '那个', '这些', '那些', '什么', '怎么', '怎样', '可以', '不能', '不要',
  '一个', '一句', '一样', '一起', '一下', '一些', '我们', '你们', '他们', '自己',
  '如果', '因为', '所以', '但是', '而且', '还是', '就是', '只是', '已经', '应该',
  '可能', '需要', '进行', '使用', '通过', '对于', '关于', '以及', '或者', '然后',
  '现在', '以后', '之前', '之后', '时候',
  '的', '了', '是', '在', '和', '有', '就', '也', '都', '而', '与', '着', '过',
])

/**
 * Whether a record shares at least one query term that is about something.
 *
 * One content word is enough — a two-character Chinese word yields exactly one bigram,
 * so demanding several would reject the obvious match as readily as the accidental one.
 */
function sharesTopicalTerm(record: MemoryRecord, terms: readonly string[]): boolean {
  const haystack = [record.title, record.trigger, record.failureMode, record.lesson, record.body]
    .join('\n')
    .toLowerCase()
  for (const term of terms) {
    if (NON_TOPICAL_CJK.has(term)) continue
    if (haystack.includes(term)) return true
  }
  return false
}

export interface RetrieveInput {
  workspaceId: string
  domain: string
  query: string
  now: number
  limit: number
  tier: Tier
  /** Recall may widen the status window; the resident layer never does. */
  includeCandidates?: boolean
  includeRetired?: boolean
}

export interface RetrieveResult {
  ranked: RankedRecord[]
  /** Records dropped, by reason. Observability without reading any body. */
  excluded: Record<string, number>
}

/**
 * Whether one workspace may see one record.
 *
 * A workspace-scoped record belongs to its workspace and nowhere else. A
 * domain-scoped record is shared with every workspace that resolves to the same
 * domain, which is what lets a lesson learned in one project arrive in the
 * next — while an unresolved domain still sees only its own records.
 */
export function visible(record: MemoryRecord, workspaceId: string, domain: string): boolean {
  if (record.scope === 'workspace') return workspaceId !== '' && record.workspaceId === workspaceId
  return domain !== '' && record.domain === domain
}

/** Statuses a tier admits before per-record eligibility is applied. */
function statuteStatuses(input: RetrieveInput): Status[] {
  if (input.tier === 'resident') return ['confirmed']
  const statuses: Status[] = ['confirmed']
  if (input.includeCandidates === true) statuses.push('candidate')
  if (input.includeRetired === true) statuses.push('retired')
  return statuses
}

/** How many identifier phrases of the query appear verbatim in the record. */
export function identifierMatches(record: MemoryRecord, queryIdentifiers: readonly string[]): number {
  if (queryIdentifiers.length === 0) return 0
  const haystack = new Set(tokenize(
    [record.title, record.trigger, record.failureMode, record.lesson, record.body].join('\n'),
  ))
  let hits = 0
  for (const key of queryIdentifiers) if (haystack.has(key)) hits += 1
  return hits
}

/**
 * Score and explain one record, so every tier ranks by the same function.
 *
 * `bm25` is passed in by the query tier and is zero for a tier that selected
 * records without a query term.
 */
function rankOne(record: MemoryRecord, queryIdentifiers: readonly string[], now: number, bm25 = 0): RankedRecord {
  const matches = identifierMatches(record, queryIdentifiers)
  const score = importance({
    evidence: record.evidence,
    successCount: record.successCount,
    reuseCount: record.reuseCount,
    failStreak: record.failStreak,
    distinctWorkspaces: record.distinctWorkspaces,
    retrieveCount: record.retrieveCount,
    lastRetrievedAt: record.lastRetrievedAt,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    reviewAfter: record.reviewAfter,
    now,
    identifierMatches: matches,
  })
  return { record, importance: score, bm25, identifierMatches: matches, why: explain(record, matches, now) }
}

/**
 * Retrieve and rank the records a workspace may see for one query.
 *
 * A query with no indexable term returns nothing rather than an arbitrary
 * overview: an empty result is honest, whereas a "stable overview" built from
 * random identifiers is not. The gap that leaves — a turn with no term to match
 * — is covered by {@link retrieveCore}, not by widening this pass.
 */
export function retrieve(db: DatabaseSync, input: RetrieveInput): RetrieveResult {
  const excluded: Record<string, number> = {}
  const drop = (reason: string): void => {
    excluded[reason] = (excluded[reason] ?? 0) + 1
  }

  // Fail closed: an unidentified workspace has no memory, not everyone's.
  if (input.workspaceId === '' && input.domain === '') return { ranked: [], excluded }

  const match = matchExpression(input.query)
  if (match === '') return { ranked: [], excluded }

  const statuses = new Set(statuteStatuses(input))
  const queryIdentifiers = identifiers(input.query).map(identifierKey)
  // Only needed for the always-on layer, whose bar is relevance as well as grade.
  const lexicalTerms = input.tier === 'resident' ? lexicalQueryTerms(input.query) : []
  const now = input.now

  const ranked: RankedRecord[] = []
  for (const { record, bm25 } of searchRecords(db, match, CANDIDATE_LIMIT)) {
    if (!visible(record, input.workspaceId, input.domain)) { drop('scope'); continue }
    if (!statuses.has(record.status)) { drop('status'); continue }
    if (record.supersededBy !== null) { drop('superseded'); continue }
    if (record.expiresAt !== null && record.expiresAt <= now) { drop('expired'); continue }

    const entry = rankOne(record, queryIdentifiers, now, bm25)
    if (input.tier === 'resident') {
      if (!eligibleForResident(record, entry.importance, now)) { drop('grade'); continue }
      // FTS matched *some* term; that is not yet evidence the record is about this
      // turn. An identifier hit is specific on its own, a topic word is specific
      // enough, and a shared function word is not — see NON_TOPICAL_CJK.
      if (entry.identifierMatches === 0 && !sharesTopicalTerm(record, lexicalTerms)) {
        drop('relevance')
        continue
      }
    }

    ranked.push(entry)
  }

  ranked.sort(compareRanked)
  if (ranked.length > input.limit) {
    for (const _ of ranked.slice(input.limit)) drop('limit')
    ranked.length = input.limit
  }
  return { ranked, excluded }
}

export interface CoreInput {
  domain: string
  now: number
  limit: number
}

/**
 * The core pass: records injected regardless of what the turn is about.
 *
 * The resident layer is query-gated, so a user replying "继续" carries no term to
 * match and the digest empties exactly while a long task is still running. This
 * pass closes that gap without reopening the noise door, and it is deliberately
 * the narrowest possible answer to it:
 *
 *   - domain scope only, which is what two independent workspaces produce;
 *   - the same resident eligibility bar as the query tier, so core records are
 *     always a subset of what the resident layer would have accepted anyway;
 *   - the caller caps the slots and the bytes, so the guarantee costs a bounded
 *     amount of prompt rather than an unbounded one.
 *
 * A workspace-local record is never core, however important: nothing has
 * corroborated it, and one project's habit is not a rule.
 */
export function retrieveCore(db: DatabaseSync, input: CoreInput): RetrieveResult {
  const excluded: Record<string, number> = {}
  const drop = (reason: string): void => {
    excluded[reason] = (excluded[reason] ?? 0) + 1
  }

  if (input.domain === '') return { ranked: [], excluded }

  const ranked: RankedRecord[] = []
  for (const record of domainCoreRecords(db, input.domain, input.now, CORE_CANDIDATE_LIMIT)) {
    if (record.status !== 'confirmed') { drop('status'); continue }
    if (record.evidence === 'inferred') { drop('evidence'); continue }
    if (record.distinctWorkspaces < CORE_CORROBORATION_MIN) { drop('corroboration'); continue }
    const entry = rankOne(record, [], input.now)
    if (!eligibleForResident(record, entry.importance, input.now)) { drop('grade'); continue }
    ranked.push(entry)
  }

  ranked.sort(compareRanked)
  if (ranked.length > input.limit) {
    for (const _ of ranked.slice(input.limit)) drop('limit')
    ranked.length = input.limit
  }
  return { ranked, excluded }
}
