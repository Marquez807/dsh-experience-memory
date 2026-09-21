/**
 * Importance: the one place that decides what is worth remembering.
 *
 * The previous system ordered its always-on pack by `uuid4` string, so the
 * eight records that reached the model were an arbitrary frozen sample and new
 * memories had an `8/n` chance of ever appearing. Ordering is a product
 * decision, so it lives in exactly one function.
 */
                                                                      

const DAY = 86_400_000

/** Assumed review period for records that declare none. */
export const DEFAULT_REVIEW_DAYS = 180

/** Evidence grades, most trustworthy first. Values are ranking weights. */
const EVIDENCE_WEIGHT                                     = {
  'verified-tool': 3.0,
  'verified-user': 2.5,
  'verified-file': 2.0,
  inferred: 0.5,
}

/** Grades allowed into the resident (every-turn) layer. */
export const RESIDENT_EVIDENCE                        = new Set          ([
  'verified-tool', 'verified-user', 'verified-file',
])

/**
 * Minimum importance for a resident-layer slot.
 *
 * `5.5` is chosen against the arithmetic rather than picked: a `verified-file` record
 * scores exactly `3.0 x 2.0 = 6.0`, which *was* also the bar, so its headroom above the
 * line was zero and the most common grade in the store was pushed under it by a few
 * hours of age — 42 of 43 confirmed file-verified records sat below a bar they could
 * never clear. Nothing designed that; three weights chosen separately happened to land
 * exactly on each other, and the effect was "you must be used the instant you are
 * written", which in practice means never.
 *
 * The gap is now deliberate: 0.5 of headroom is 60 days at the decay rate below, so a new
 * memory is visible on its own for two months and after that has to be earned by being
 * searched out or recorded as useful. That is the sentence the old arrangement was trying
 * and failing to say.
 */
export const RESIDENT_MIN_IMPORTANCE = 5.5

/** Below this, a never-reused record is eligible for retirement by maintenance. */
export const RETIRE_FLOOR = 2.0

/** An exact identifier hit is worth this much, and never more. */
const IDENTIFIER_BONUS = 1.0
/** Ceiling on the identifier bonus. The archived downstream patch had none,
 * so a single prose phrase could outrank every BM25 score. */
const IDENTIFIER_BONUS_CAP = 2.0

/**
 * Ceiling on the retrieval term, which is its own kind of signal.
 *
 * Retrieval says "a later session went looking and this matched", not "it changed what
 * happened". It is worth keeping a record visible, and it is not worth as much as a
 * recorded success — so the term is capped, and it cannot by itself outrank evidence.
 * Without a cap, calling `memory_recall` often would be a way to keep anything resident.
 */
const RETRIEVAL_BONUS_CAP = 1.0

/** Facts that ranking needs, independent of how the record was loaded. */
                                  
                    
                      
                    
                    
                            
                        
                                 
                   
                           
                            
             
                            
 

/**
 * Rank a record. Higher is more worth injecting. The terms are additive and
 * each is bounded, so no single signal can dominate the way an uncapped
 * identifier match used to.
 */
export function importance(facts                 )         {
  // Every way a record has been touched counts as touching it: a recorded success, and
  // also a later session searching it out. Leaving retrieval out of the anchor was the
  // defect — a memory could be found and used in a later session and still decay exactly
  // as if nothing had ever looked at it, so nothing ever came back on its own.
  const anchor = Math.max(
    facts.createdAt,
    facts.lastUsedAt ?? 0,
    facts.lastRetrievedAt ?? 0,
  )
  const period = facts.reviewAfter !== null && facts.reviewAfter > facts.createdAt
    ? facts.reviewAfter - facts.createdAt
    : DEFAULT_REVIEW_DAYS * DAY
  const staleness = Math.max(0, (facts.now - anchor) / period)
  const identifierMatches = facts.identifierMatches ?? 0
  const retrieveCount = facts.retrieveCount ?? 0

  return 3.0 * EVIDENCE_WEIGHT[facts.evidence]
    + 1.5 * Math.log2(1 + facts.successCount)
    - 2.0 * facts.failStreak
    - 1.5 * staleness
    + 0.5 * Math.log2(Math.max(1, facts.distinctWorkspaces))
    + 0.3 * Math.log2(1 + facts.reuseCount)
    + Math.min(RETRIEVAL_BONUS_CAP, 0.3 * Math.log2(1 + retrieveCount))
    + Math.min(IDENTIFIER_BONUS_CAP, IDENTIFIER_BONUS * identifierMatches)
}

/**
 * Whether a record may occupy a resident slot at all. `now` is a parameter
 * rather than `Date.now()` so expiry is testable without freezing the clock.
 */
export function eligibleForResident(record              , score        , now        )          {
  return record.status === 'confirmed'
    && RESIDENT_EVIDENCE.has(record.evidence)
    && (record.expiresAt === null || record.expiresAt > now)
    && score >= RESIDENT_MIN_IMPORTANCE
}

/**
 * Order for retrieval: most important first, then most BM25-relevant, then a
 * stable id so identical inputs always produce identical output.
 */
export function compareRanked(a              , b              )         {
  if (b.importance !== a.importance) return b.importance - a.importance
  if (a.bm25 !== b.bm25) return a.bm25 - b.bm25
  return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0
}

/**
 * The *additional* reasons a record ranked where it did, or `''`.
 *
 * The evidence grade is deliberately absent here even though it is the largest
 * term in the score: every renderer already labels it, and including it here made
 * `memory_recall` print `证据: verified-file · 重要性 5.9 · verified-file · 6 天未使用`
 * — the same fact twice, in the one place where tokens are spent every call.
 */
export function explain(record              , identifierMatches        , now        )         {
  const parts           = []
  if (record.scope === 'domain') parts.push(`domain:${record.domain}`)
  if (record.successCount > 0) parts.push(`${record.successCount} 次成功复用`)
  if (record.failStreak > 0) parts.push(`${record.failStreak} 次连续失败`)
  if (identifierMatches > 0) parts.push(`${identifierMatches} 处标识符精确命中`)
  // Said out loud because it is the question a reader otherwise cannot answer: has this
  // ever been reached for since it was written, or has it been sitting here unread?
  if (record.retrieveCount > 0) parts.push(`被查过 ${record.retrieveCount} 次`)
  const anchor = Math.max(record.createdAt, record.lastUsedAt ?? 0, record.lastRetrievedAt ?? 0)
  const days = Math.floor((now - anchor) / DAY)
  if (days > 0) parts.push(`${days} 天未使用`)
  return parts.join(' · ')
}
