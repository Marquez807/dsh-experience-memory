/**
 * Would this anchor be a good idea? The store's own measured history can answer that.
 *
 * `docs/DELIVERY-GAPS.md` §25 recorded the accident. A record that declared `path:node_modules`
 * matched **702** of 15,896 real calls; one that declared `tool:pwsh` matched **5,936**, and that
 * single record then owned **94.8%** of every hint the store delivered. Both anchors look
 * reasonable when written — neither is spelled wrong, and no static rule separates them from a
 * good anchor. Counting them does, and counting is what this module does.
 *
 * The framework already had two guards against anchors that fire too widely, and both cover only
 * *inferred* anchors: a directory-bearing `path:` must match the whole tail, and a `derived` anchor
 * must be a file the record actually talks about. A **declared** anchor bypassed both, which is
 * how two sessions produced the same accident four hours apart.
 *
 * The remedy is a **drop, not a refusal**. The record is still worth writing without the anchor —
 * it reaches the per-turn digest and `memory_recall` either way — whereas an anchor that fires on
 * a third of all calls costs every future turn. So the caller is told what was dropped and why,
 * and the record goes in without it.
 *
 * Fail-open, deliberately: no table (or an empty one) means no filtering. A snapshot can then only
 * be too strict about a token that has since become rare, never silently permissive about one that
 * has not. `tools/anchor-cost.mjs --write-table` regenerates it; the header carries its date and
 * corpus size so a reader can tell how old the measurement is.
 */
import { ANCHOR_COST_TABLE } from './anchor-cost-table.js'
import { parseAnchor } from './anchors.js'

                                
                                
                
                                                                                                   
              
                                                                                        
               
                                      
 

                                    
                                                 
                
                          
                                                                                  
                                                                             
 

                                  
                     
                
               
                       
                                
 

/**
 * Split declared anchors into the ones worth keeping and the ones to drop.
 *
 * `maxHits` defaults to the table's own threshold (the same 300 as the pre-registered per-record
 * gate), so "one record may not own more hints than the gate allows" is one number in both places.
 * `table` is injectable so a test can assert the two cases the shipped snapshot cannot produce:
 * an empty table (fail-open) and a synthetic one.
 */
export function guardAnchors(
  tokens                   ,
  options                                                                   = {},
)                    {
  const enabled = options.enabled ?? true
  const source = options.table ?? ANCHOR_COST_TABLE
  const counts                         = source.tokens
  const entries = Object.keys(counts)
  if (!enabled || entries.length === 0) {
    return { kept: tokens.map(token => String(token)), refused: [], table: null }
  }
  const maxHits = options.maxHits ?? source.thresholdHits
  const table = {
    generatedAt: source.generatedAt,
    calls: source.calls,
    thresholdHits: maxHits,
  }

  const kept           = []
  const refused                  = []
  const seen = new Set        ()
  for (const raw of tokens) {
    const text = String(raw ?? '').trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    const parsed = parseAnchor(text)
    if (parsed === undefined) {
      // An anchor that does not parse is stored and then ignored by every reader, which is the
      // silent-failure shape this project keeps paying for: dropping it and saying so is the fix.
      refused.push({ anchor: text, hits: 0, share: 0, reason: 'unparseable' })
      continue
    }
    const hits = counts[`${parsed.kind}:${parsed.token}`] ?? 0
    if (hits >= maxHits) {
      refused.push({
        anchor: text,
        hits,
        share: ANCHOR_COST_TABLE.calls === 0 ? 0 : hits / ANCHOR_COST_TABLE.calls,
        reason: 'too-common',
      })
      continue
    }
    kept.push(text)
  }
  return { kept, refused, table }
}

                                 
                                             
                
                                                              
              
                                                                                      
               
 

/**
 * Which of an already-stored record's declared anchors the write gate would refuse today.
 *
 * `guardAnchors` runs only when an anchor is being written, so a record written **before** the
 * table existed keeps its anchors forever — the gate has no retroactive arm. That is not
 * hypothetical: an audit of the live store on 2026-09-25 found four records still holding
 * `tool:pwsh` (5,936 hits, 37.3% of all calls) long after the gate was in place. Nothing was
 * broken; the gate simply had never seen them.
 *
 * This is the read side of the same rule — same table, same threshold, same comparison — so
 * "what would the gate say about this record now" has one implementation instead of a second
 * one in whichever script happens to be auditing. A snapshot with no tokens returns nothing
 * rather than everything, matching the gate's fail-open rule.
 */
export function overCostAnchors(
  anchors                                            ,
  options                                                = {},
)                   {
  const source = options.table ?? ANCHOR_COST_TABLE
  const counts = source.tokens
  if (Object.keys(counts).length === 0) return []
  const maxHits = options.maxHits ?? source.thresholdHits
  const found                   = []
  const seen = new Set        ()
  for (const anchor of anchors) {
    const key = `${anchor.kind}:${anchor.token}`.toLowerCase()
    if (seen.has(key)) continue
    const hits = counts[key]
    if (hits === undefined || hits < maxHits) continue
    seen.add(key)
    found.push({ anchor: key, hits, share: source.calls === 0 ? 0 : hits / source.calls })
  }
  return found
}

/** One line per refused anchor, written for the caller rather than for a log. */
export function explainRefusals(result                   )           {
  return result.refused.map(item => {
    if (item.reason === 'unparseable') {
      return `${item.anchor} — not a usable anchor (expected path:<file>, tool:<name> or `
        + `command:<token>); dropped because a reader would silently ignore it`
    }
    const share = item.share === 0 ? '0%' : `${(item.share * 100).toFixed(1)}%`
    return `${item.anchor} — dropped: it matched ${item.hits} of ${result.table?.calls ?? 0} recorded `
      + `calls (${share}), so one record would own too many hints. Narrow it (a path that carries its `
      + `directory), or leave it out — the record still reaches the digest and memory_recall.`
  })
}
