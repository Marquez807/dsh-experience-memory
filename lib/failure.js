/**
 * What keeps going wrong — counted, never judged.
 *
 * This module exists because of a measured hole, not a hypothesis. Over seven days this
 * harness produced **358 tool failures in 63 sessions**, and the shape that recurred most —
 * an edit refused because the file had not been read, 143 times across 5 sessions — had **no
 * covering record in a store of 59**. The framework had read every one of those failures and
 * deliberately discarded them (`harvest.ts` skips the agent's own tooling), which is the right
 * rule for *"should this become a lesson"* and the wrong rule for *"is this happening at all"*.
 * There was no observation layer; the only way to find out was for a person to go digging.
 *
 * So the split this module makes:
 *
 *   - **Counting is automatic.** Nothing depends on the model deciding to record anything.
 *   - **Judging is not.** No record is written here, nothing is injected, and no prompt
 *     changes. A shape is evidence that something repeats; whether it deserves a lesson is a
 *     question for the report's reader (see `/memory-gaps`).
 *
 * That division is deliberate, and it is where this design parts company with the obvious
 * one. A "failure harvester" that wrote records automatically was rejected on the numbers:
 * half of the failures carry their own remedy in the error text ("read the file, then
 * retry"), the largest class is a slip the harness already guards, and the one detector aimed
 * at this class had already been calibrated here once and rejected (71 hits, 5 real). Writing
 * those into the store would fill the candidate pool with things the model already knows.
 */
import { deliveriesAtOrBefore, evictFailureShapes, failureShapeWorkspaces, failureShapes, noteFailureShape, windowRecords } from './db.js'
                                           
                                               
import { lastTurn } from './harvest.js'
import { visible } from './retrieve.js'
import { eventsOf } from './session.js'
import { identifierKey } from './tokenize.js'
                                                                           

/** Bytes one stored sample may keep. Enough to recognise the error, not to archive it. */
export const SAMPLE_MAX_BYTES = 120

/**
 * Collapse an error message to its shape.
 *
 * The shape has to survive the parts that differ every time — the file it happened to be, the
 * id, the offset — or every occurrence would be its own row and the count would always be one.
 * Measured on the real week of failures, this collapses 358 failures into 38 shapes, which is
 * the resolution the report needs: fine enough that two different bugs stay apart, coarse
 * enough that the same bug in two files is one line.
 *
 * Only the first line is kept. Stack traces and "expected/got" dumps differ per occurrence and
 * would defeat the whole point.
 */
export function failureShape(text        )         {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  return firstLine
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')     // an absolute Windows path
    .replace(/(?:^|\s)\/[^\s"']+/g, ' <path>')      // a POSIX path
    .replace(/"[^"]*"/g, '"<x>"')                   // a quoted file name or value
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')          // a hash, a call id, a hex offset
    .replace(/\d+/g, 'N')                           // a line number, an offset, a count
    .trim()
    .slice(0, 96)
}

/** The readable text of the first block of a tool result, as `harvest.ts` reads it. */
function errorText(blocks                    )         {
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const inner = (block                         ).content
    if (!Array.isArray(inner)) continue
    for (const piece of inner) {
      if (typeof piece !== 'object' || piece === null) continue
      const text = (piece                      ).text
      if (typeof text === 'string' && text.trim() !== '') return text
    }
  }
  return ''
}

/** One failure found in a turn's events. */
                                  
              
               
                
 

/**
 * The failures in one turn, paired with the tool that produced them.
 *
 * Note what is *not* here: the `AGENT_TOOLING` filter that `harvest.ts` applies. That filter
 * asks "is this a lesson about the project?" and answers no for the agent's own tools — a
 * defensible answer that, applied here, would hide the single most frequent failure in this
 * workspace. Counting asks a different question and must not inherit that answer.
 */
export function failuresIn(turn                             )                    {
  const toolOf = new Map                ()
  const found                    = []
  for (const event of turn) {
    if (event.type === 'tool/call') {
      const name = event.data?.name
      const callId = event.data?.callId
      if (typeof name === 'string' && typeof callId === 'string') toolOf.set(callId, name)
      continue
    }
    if (event.type !== 'tool/result') continue
    const callId = event.data?.message?.source?.callId ?? event.data?.source?.callId
    if (typeof callId !== 'string') continue
    const tool = toolOf.get(callId)
    if (tool === undefined) continue
    const blocks = event.data?.message?.content ?? event.data?.content
    if (!Array.isArray(blocks)) continue
    const failed = blocks.some(block =>
      typeof block === 'object' && block !== null && (block                         ).isError === true)
    if (!failed) continue
    const text = errorText(blocks)
    if (text.trim() === '') continue
    found.push({ tool, shape: failureShape(text), sample: text.replace(/\s+/g, ' ').trim().slice(0, SAMPLE_MAX_BYTES) })
  }
  return found
}

                                  
                  
                                                                                         
                    
 

/**
 * Record the failures of the turn that just ended.
 *
 * Runs at turn end on the newest turn only, which is the same bounded read `harvestTurn`
 * already does — a session log reaches tens of megabytes and rescanning it per turn would be a
 * cost with no matching benefit. Returns how many entries were written, for the tests and for
 * the census; a caller that cannot read the session writes nothing and moves on.
 */
export function noteFailures(
  db              ,
  agent                       ,
  workspaceId        ,
  sessionId        ,
  now        ,
  tracking                 ,
)         {
  if (!tracking.enabled) return 0
  const events = eventsOf(agent)
  if (events.length === 0 || workspaceId === '') return 0
  let written = 0
  for (const failure of failuresIn(lastTurn(events))) {
    noteFailureShape(db, {
      workspaceId,
      tool: failure.tool,
      shape: failure.shape,
      sample: failure.sample,
      sessionId,
      at: now,
    })
    written += 1
  }
  if (written > 0) evictFailureShapes(db, workspaceId, tracking.shapeLimit)
  return written
}

/**
 * Which of the four things is true about a shape that keeps happening.
 *
 * The distinction this draws is the one that decides what to do next, and it was invisible
 * before deliveries were written down: a lesson nobody was shown, and a lesson that was shown
 * and did not change the outcome, are the same row without it.
 */
                        
                                                                               
                   
                                                                     
                            
                                                                                        
                           
                                                  
             

/** How far back a delivery is allowed to count for a failure when no session id links them. */
export const DELIVERY_WINDOW_MS = 6 * 60 * 60_000

/** One line of the gap report: a shape, and how close the store comes to covering it. */
                         
                     
     
                                                                                        
    
                                                                                              
                                                                                                
                                                                                         
                                                                                             
                                                                                               
                                          
     
                                   
                                                             
                   
                                                                                           
                    
                                                     
                    
     
                                                                                             
    
                                                                                                 
                                                                                               
     
                     
     
                                                                                               
                                                          
    
                                                                                                 
                                                                                                  
                                                                                         
                                                                        
                                                                                                  
                                                                                            
     
                           
     
                                                                                         
                 
    
                                                                                            
                                                                                               
                                                                                           
                                    
     
             
                   
                                                            
                 
                                                
                                
                          
                                                                                     
                                            
   
                     
 

/**
 * How many occurrences after a record count as "it kept happening".
 *
 * Three rather than one or two because the underlying data is a rate, not a promise: a single
 * repeat is noise, and calling that "the lesson failed" is the kind of claim this report exists
 * to avoid making.
 */
export const LESSON_IGNORED_MIN = 3

/** A record has to be this old before "it did not stop the failure" is a fair thing to say. */
export const LESSON_GRACE_MS = 60 * 60_000

/**
 * Words worth searching the store for.
 *
 * The tool name is always one of them — `old_string was not found` and a lesson about
 * `old_string` are about the same thing — and the rest come from the shape itself, longest
 * first, because the longest words in an error message are the ones that carry its subject.
 */
export function gapKeywords(tool        , shape        )           {
  const words = (shape.toLowerCase().match(/[a-z_][a-z0-9_]{4,}/g) ?? [])
    .filter(word => !STOPWORDS.has(word))
    .sort((a, b) => b.length - a.length)
  const keys = [tool.toLowerCase(), ...words].map(word => identifierKey(word)).filter(word => word !== '')
  return [...new Set(keys)].slice(0, 3)
}

/**
 * Words that appear in nearly every error message, so sharing one says nothing.
 *
 * Short and deliberately incomplete, the same way the stop lists elsewhere in this plugin are:
 * it is extended when a false "covered" is observed, because a wrong *yes* here tells a reader
 * that a repeated mistake is handled when it is not.
 */
const STOPWORDS                      = new Set([
  'error', 'failed', 'failure', 'cannot', 'could', 'invalid', 'expected', 'unexpected',
  'found', 'missing', 'requires', 'required', 'because', 'while', 'after', 'before', 'which',
])

/**
 * Did the record that claims to cover this shape actually stop it?
 *
 * The question is answerable only because the table remembers *when* the recent occurrences
 * happened. Three conditions, all required — see {@link GapRow.lessonNotWorking} for why each is
 * there; the short version is that a false "your lesson is not working" costs more than a missed
 * one, because it makes the reader distrust records that are fine.
 */
export function lessonNotWorking(
  shape              ,
  best                                                     ,
  keywords                   ,
  now        ,
)                                               {
  if (best === undefined) return { sinceRecord: 0, notWorking: false }
  // A complete match, and more than one word: "edit" alone appears in dozens of records, and a
  // single shared word is not a claim about this failure.
  if (best.score < keywords.length || keywords.length < 2) return { sinceRecord: 0, notWorking: false }
  const createdAt = best.record.createdAt
  if (now - createdAt < LESSON_GRACE_MS) return { sinceRecord: 0, notWorking: false }
  const sinceRecord = shape.recentAt.filter(at => at > createdAt).length
  return { sinceRecord, notWorking: sinceRecord >= LESSON_IGNORED_MIN }
}

/**
 * The learning gap: shapes this workspace repeats, and how close the store comes to them.
 *
 * The overlap is reported as a score with the nearest record, never as a verdict — see
 * {@link GapRow.closest} for why a boolean would be dishonest here.
 *
 * The record's **body is deliberately excluded**. Not a detail: the first live run of this
 * report matched a 128-occurrence edit failure to a record about something else entirely,
 * because that record *quotes the error text* in its body while claiming nothing about the
 * failure. Quoting is not covering. What a record claims lives in its title, its "when this
 * applies" line, its failure mode and its lesson, so those four are what is compared.
 */
/**
 * Whether a lesson reached the agent before this shape last happened.
 *
 * Two association rules, and the weaker one is labelled as such. A matching session id is
 * the strong signal: the hint and the failure were in the same session, so "the lesson was in
 * front of the agent and it went wrong anyway" is a fair reading. Without one, the clock is all
 * that is left, and {@link DELIVERY_WINDOW_MS} is deliberately generous rather than tight —
 * a delivery wrongly counted here inflates "delivered", and the report already prints which
 * rule decided, so a reader can discount it instead of being misled silently.
 *
 * The scope is deliberately *any* delivery in the window, not only the closest record's: the
 * question is whether this workspace had the lesson in front of the agent at the time, and a
 * neighbouring record about the same failure is the same lesson for that purpose.
 */
function deliveryBeforeShape(
  db              ,
  shape              ,
  now        ,
)                     {
  const at = shape.lastSeen
  const rows = deliveriesAtOrBefore(db, at, { since: at - DELIVERY_WINDOW_MS, limit: 50 })
  const sessions = new Set(shape.sessionIds)
  const bySession = rows.find(row => row.sessionId !== null && sessions.has(row.sessionId))
  // The clock is a fallback, not a second chance. It applies only when the shape recorded no
  // session at all — otherwise a delivery from an unrelated session that merely happens to be
  // recent would be counted as having been shown for this failure, which is exactly the false
  // positive the "delivered" number must not have.
  const chosen = bySession ?? (sessions.size === 0 ? rows[0] : undefined)
  if (chosen === undefined) return { before: false, count: 0, recordId: undefined, at: undefined, bySession: 'none' }
  return {
    before: true,
    count: rows.length,
    recordId: chosen.recordId,
    at: chosen.at,
    bySession: bySession === undefined ? 'window' : 'session',
  }
}

export function gapReport(
  db              ,
  input                                                                                       ,
)           {
  const shapes = failureShapes(db, input.workspaceId, input.limit)
  const pool = windowRecords(db, input.workspaceId, input.domain, 512).filter(record =>
    record.status === 'confirmed'
    && record.supersededBy === null
    && (record.expiresAt === null || record.expiresAt > input.now)
    && visible(record, input.workspaceId, input.domain))
  const haystacks = pool.map(record => ({
    record,
    text: [record.title, record.trigger, record.failureMode, record.lesson].join('\n').toLowerCase(),
  }))

  const rows           = []
  for (const shape of shapes) {
    if (shape.count < input.minCount) continue
    const keywords = gapKeywords(shape.tool, shape.shape)
    let best                                                     
    for (const { record, text } of haystacks) {
      const score = keywords.filter(keyword => text.includes(keyword)).length
      if (score === 0) continue
      if (best === undefined || score > best.score) best = { record, score }
    }
    const lesson = lessonNotWorking(shape, best, keywords, input.now)
    const delivery = deliveryBeforeShape(db, shape, input.now)
    const completeMatch = best !== undefined && best.score >= keywords.length && keywords.length >= 2
    const verdict             = best === undefined
      ? 'not-delivered'
      : !delivery.before
        ? 'not-delivered'
        : completeMatch
          ? 'delivered-and-ignored'
          : 'delivered-still-failed'
    rows.push({
      shape,
      closest: best?.record,
      bestScore: best?.score ?? 0,
      keywords,
      workspaces: failureShapeWorkspaces(db, shape.tool, shape.shape),
      sinceRecord: lesson.sinceRecord,
      lessonNotWorking: lesson.notWorking,
      delivery,
      verdict,
    })
  }
  return rows
}

/** A repeated failure that no confirmed record even comes close to covering. */
                               
              
                                                             
               
                                                       
               
                                              
                    
                                                       
                
 

/**
 * The recurring failures worth turning into raw material — the missing link.
 *
 * Why this exists (measured 2026-09-25, `tools/prevention-ledger.mjs` on the live store): of
 * 21 recurring failure shapes, **11 had nothing delivered for them** — the top one, `edit`
 * before `read`, had happened **140 times across 8 sessions**, most recently that same day,
 * and the store contained no record about it at all; the other 9 had a related record
 * delivered and recurred anyway. The ledger could say all of that, and nothing acted on it:
 * `/memory-gaps` had to be run by a person, who then had to tell the agent to write a record.
 * The one automatic path, the harvester, **skips the agent's own tooling by design**
 * (`harvest.ts:26-30`), which is where those failures live.
 *
 * So the loop is closed here without inventing anything: the text is the harness's own error
 * line, verbatim and already normalised to a shape, and the title is mechanical. The row is
 * filed as a candidate, so it is invisible to the always-on layer and becomes a record only
 * when the model re-states it under the ordinary evidence gate.
 *
 * Only shapes where **nothing in the store comes close** (`closest === undefined`: not one
 * shared keyword) are proposed. A shape that already has a near record is a different
 * problem with a different fix — revise that record — and a second ungraded row beside it
 * would only add noise to the pool the model is asked to judge.
 */
export function gapCandidates(
  rows                   ,
  options                                   ,
)                 {
  return rows
    .filter(row => row.closest === undefined
      && row.shape.count >= options.minCount
      && row.shape.sample.trim() !== '')
    .slice(0, options.max)
    .map(row => ({
      tool: row.shape.tool,
      shape: row.shape.shape,
      count: row.shape.count,
      workspaces: row.workspaces,
      sample: row.shape.sample.trim(),
    }))
}

/**
 * What a `recurring-failure` candidate says, and why it says exactly this.
 *
 * The body is the error line and the count; it is **not** a rule. A rule would be a claim
 * about cause, and nothing here knows the cause — it knows how often and where. The count is
 * included because it is the only thing that makes the row worth a reader's attention, and
 * the `read the file, then retry` half of an error is often the fix already.
 */
export function gapCandidateText(candidate              )         {
  const spread = candidate.workspaces > 1 ? `，跨 ${candidate.workspaces} 个工作区` : ''
  return `本工作区反复出现的失败 ${candidate.count} 次${spread}（工具 ${candidate.tool}）：${candidate.sample}`
}

/** A mechanical title: the tool, then the head of the shape. Never a paraphrase. */
export function gapCandidateTitle(candidate              )         {
  return `${candidate.tool}: ${candidate.shape}`.slice(0, 120)
}

