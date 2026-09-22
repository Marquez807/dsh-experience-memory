/**
 * Which stored lesson, if any, belongs in front of the agent for *this* call.
 *
 * The answer used to be produced by inference: pull identifiers out of the call, look for a
 * record that mentions one of them, prefer the record that mentions most. Three
 * measurements retired that approach (all re-runnable; `tools/replay.mjs` does the first
 * two, and the numbers are pinned in `docs/DELIVERY-GAPS.md`):
 *
 *   1. **It fires on most calls.** Replayed over 15,383 real tool calls it delivered a hint
 *      on 57% of them. A hint on 57% of everything is not a hint.
 *   2. **What it delivers is usually unrelated.** A sampled audit of 48 real deliveries
 *      found 4 that were about the call (8.3%). The rest fired on a coincidence: the column
 *      header `AutoSize` linked a call to a lesson about output truncation, `encoding` in a
 *      URL fetch linked to a lesson about chunked decoding.
 *   3. **No amount of tuning fixes it.** With the loosest matching, only 14 of 25
 *      hand-written "what should fire here" cases had the right record among the candidates
 *      at all, so ranking could not have helped; tightening the rule enough to remove the
 *      noise cut recall to single digits. There is no point on that curve worth shipping.
 *
 * What replaced it keeps the same question — "does this lesson apply to what I am about to
 * do" — but stops *inferring* the answer from vocabulary. It asks the record, which is the
 * only party that knows: **an anchor is a fact about the call that the record declares in
 * advance** (see `anchors.ts`). A record that declares none is never delivered here.
 *
 * The trade is explicit: the framework becomes silent for records that never said where they
 * apply, including almost every record written before this change. Silence costs a hint that
 * might not have been read anyway; the old behaviour cost the credibility of every hint.
 */
                                               
import { windowRecords } from './db.js'
import { CANDIDATE_LIMIT, visible } from './retrieve.js'
import { importance } from './rank.js'
import {
  actingTool,
  anchorsSatisfied,
  callFacts,
  deriveAnchorFromSourceRef,
  parseAnchor,
  splitTrigger,
              
                 
} from './anchors.js'
                                              

/** Why a call got the answer it got — recorded so the ledger can say which gate stopped it. */
                                                                 

                              
                      
                                                                                               
                   
                                                                     
                    
                                                                                                      
                             
                      
 

/**
 * The anchors a record offers, from its own declaration first and its `source_ref` second.
 *
 * `source_ref` is the fallback because a file-verified record already had to name the file
 * its claim rests on, and when that file is code, "the lesson is about this file" is the
 * best available evidence of where the lesson applies. It is deliberately not a licence to
 * match on anything else the record happens to say.
 */
export function recordAnchors(
  record              ,
  options                        = {},
)                                                     {
  const declared           = []
  for (const piece of splitTrigger(record.trigger).anchors) {
    const anchor = parseAnchor(piece)
    if (anchor !== undefined) declared.push(anchor)
  }
  if (declared.length > 0) return { anchors: declared, via: 'declared' }
  if (options.derived !== true) return { anchors: [], via: 'derived' }
  const derived = deriveAnchorFromSourceRef(record.sourceRef)
  if (derived !== undefined) return { anchors: [derived], via: 'derived' }
  return { anchors: [], via: 'derived' }
}

/**
 * The one record worth showing for this call, or `undefined`.
 *
 * The pool is the same bounded window the old gate ranked over — the most recently updated
 * `CANDIDATE_LIMIT` records the workspace may see — so what a call can reach does not depend
 * on how the store happens to be ordered beyond that.
 */
export function decideForCall(
  db              ,
  workspaceId        ,
  domain        ,
  argumentsValue         ,
  now        ,
  options                                              = {},
)                             {
  const useDerived = options.derivedAnchors ?? false
  const facts            = callFacts(options.tool ?? '', argumentsValue)
  if (facts.paths.length === 0 && facts.command === '' && facts.tool === '') return undefined

  const pool = windowRecords(db, workspaceId, domain, CANDIDATE_LIMIT).filter(record =>
    record.status === 'confirmed'
    && record.supersededBy === null
    && (record.expiresAt === null || record.expiresAt > now)
    && visible(record, workspaceId, domain))
  if (pool.length === 0) return undefined

  const hits                                                                                                                     = []
  for (const record of pool) {
    const { anchors, via } = recordAnchors(record, { derived: useDerived })
    if (anchors.length === 0) continue
    // A derived anchor is the weaker claim ("this file appears in the record's evidence"), so
    // it only counts when the call is about to change that file. A declared anchor is the
    // record naming its own trigger and is honoured on any tool.
    if (via === 'derived' && !actingTool(facts.tool)) continue
    const matched = anchors.filter(anchor => anchorsSatisfied([anchor], facts))
    if (matched.length === 0) continue
    hits.push({
      record,
      matched: matched.map(renderAnchor),
      declared: anchors.map(renderAnchor),
      via,
      importance: importance({
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
        identifierMatches: matched.length,
      }),
    })
  }
  if (hits.length === 0) return undefined

  // Most anchors satisfied first (a record that anticipated two facts about this call beats
  // one that anticipated a single common file name), then how specific the anchor kind is,
  // then the record's own standing.
  const specificity = (item                       )         =>
    item.matched.reduce((sum, text) => sum + (text.startsWith('path:') ? 2 : text.startsWith('tool:') ? 1 : 0), 0)
  hits.sort((a, b) => b.matched.length - a.matched.length
    || specificity(b) - specificity(a)
    || b.importance - a.importance)

  const best = hits[0]                       
  return {
    record: best.record,
    matched: best.matched,
    declared: best.declared,
    via: best.via,
    reason: 'ok-anchor',
  }
}

/** `path:x.ts`, matching the spelling `memory_remember`'s `recall_for` accepts. */
function renderAnchor(anchor        )         {
  return `${anchor.kind}:${anchor.token}`
}

/**
 * A diagnostic view of one call, for `/memory-preview` and the replay tool.
 *
 * It answers "why not" as well as "what": how many records declared an anchor at all, how
 * many of those the call satisfied, and which file names the call offered.
 */
export function explainCall(
  db              ,
  workspaceId        ,
  domain        ,
  argumentsValue         ,
  now        ,
  options                    = {},
)   
                                                           
                  
                                      
  {
  const facts = callFacts(options.tool ?? '', argumentsValue)
  const pool = windowRecords(db, workspaceId, domain, CANDIDATE_LIMIT).filter(record =>
    record.status === 'confirmed'
    && record.supersededBy === null
    && (record.expiresAt === null || record.expiresAt > now)
    && visible(record, workspaceId, domain))
  let anchored = 0
  for (const record of pool) if (recordAnchors(record, { derived: true }).anchors.length > 0) anchored += 1
  return {
    facts: { tool: facts.tool, paths: facts.paths, command: facts.command },
    anchored,
    decision: decideForCall(db, workspaceId, domain, argumentsValue, now, options),
  }
}
