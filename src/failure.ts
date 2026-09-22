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
import { deliveriesAtOrBefore, evictFailureShapes, failureShapeWorkspaces, failureShapes, noteFailureShape, windowRecords } from './db.ts'
import type { FailureShape } from './db.ts'
import type { DatabaseSync } from 'node:sqlite'
import { lastTurn } from './harvest.ts'
import { visible } from './retrieve.ts'
import { eventsOf } from './session.ts'
import { identifierKey } from './tokenize.ts'
import type { AgentLike, MemoryRecord, SessionEventLike } from './types.ts'

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
export function failureShape(text: string): string {
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
function errorText(blocks: readonly unknown[]): string {
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const inner = (block as { content?: unknown }).content
    if (!Array.isArray(inner)) continue
    for (const piece of inner) {
      if (typeof piece !== 'object' || piece === null) continue
      const text = (piece as { text?: unknown }).text
      if (typeof text === 'string' && text.trim() !== '') return text
    }
  }
  return ''
}

/** One failure found in a turn's events. */
export interface ObservedFailure {
  tool: string
  shape: string
  sample: string
}

/**
 * The failures in one turn, paired with the tool that produced them.
 *
 * Note what is *not* here: the `AGENT_TOOLING` filter that `harvest.ts` applies. That filter
 * asks "is this a lesson about the project?" and answers no for the agent's own tools — a
 * defensible answer that, applied here, would hide the single most frequent failure in this
 * workspace. Counting asks a different question and must not inherit that answer.
 */
export function failuresIn(turn: readonly SessionEventLike[]): ObservedFailure[] {
  const toolOf = new Map<string, string>()
  const found: ObservedFailure[] = []
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
      typeof block === 'object' && block !== null && (block as { isError?: unknown }).isError === true)
    if (!failed) continue
    const text = errorText(blocks)
    if (text.trim() === '') continue
    found.push({ tool, shape: failureShape(text), sample: text.replace(/\s+/g, ' ').trim().slice(0, SAMPLE_MAX_BYTES) })
  }
  return found
}

export interface FailureTracking {
  enabled: boolean
  /** Shapes kept per workspace; beyond it the least frequent and stalest are dropped. */
  shapeLimit: number
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
  db: DatabaseSync,
  agent: AgentLike | undefined,
  workspaceId: string,
  sessionId: string,
  now: number,
  tracking: FailureTracking,
): number {
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
export type GapVerdict =
  /** No record claims this shape, or none was delivered before it happened. */
  | 'not-delivered'
  /** A related lesson was delivered and the shape still happened. */
  | 'delivered-still-failed'
  /** A lesson whose keywords fully match was delivered and the shape still happened. */
  | 'delivered-and-ignored'
  /** The timestamps cannot carry the question. */
  | 'unclear'

/** How far back a delivery is allowed to count for a failure when no session id links them. */
export const DELIVERY_WINDOW_MS = 6 * 60 * 60_000

/** One line of the gap report: a shape, and how close the store comes to covering it. */
export interface GapRow {
  shape: FailureShape
  /**
   * The confirmed record that shares the most words with this shape, if any shares one.
   *
   * Deliberately *not* a boolean "covered". The check is a keyword overlap, and the two sides
   * are written in different languages in practice — the error text is English, the records are
   * mostly Chinese — so a record that genuinely covers a failure can still score zero. A
   * boolean would turn that into "nothing covers this, write a record", which is the kind of
   * check that looks like it verifies something and does not. The score and the nearest record
   * are what a reader can actually judge.
   */
  closest: MemoryRecord | undefined
  /** How many of the shape's keywords that record shares. */
  bestScore: number
  /** Keywords used for the check, so the reader can see what was measured against what. */
  keywords: string[]
  /** How many workspaces have hit the same shape. */
  workspaces: number
  /**
   * Occurrences recorded *after* the matched record was written; `0` when there is no match.
   *
   * Counted over the bounded list of recent occurrences the table keeps, so it is "N of the last
   * M" rather than a lifetime total — the honest unit, and enough to see a lesson not working.
   */
  sinceRecord: number
  /**
   * The matched record is not stopping the failure: it claims to cover this shape, it predates
   * the occurrences, and the shape kept happening anyway.
   *
   * Three conditions must all hold, because a false alarm here is expensive — it would teach the
   * reader to distrust records that are fine. The match must be *complete* (every keyword, and at
   * least two of them: a one-word overlap is a coincidence), the record must predate the
   * occurrences by more than a token margin, and there must be at least
   * {@link LESSON_IGNORED_MIN} of them. Even then it is a question, not a verdict: the record may
   * be right but arriving too late, or right about something adjacent. The command says so.
   */
  lessonNotWorking: boolean
  /**
   * Whether a lesson reached the agent before this shape last happened, and how that was
   * established.
   *
   * The association is weaker than it looks and says so: a delivery either shares a session
   * id with one of the occurrences, or falls inside {@link DELIVERY_WINDOW_MS} before the last
   * one. `bySession` names which of the two decided it, so a reader can discount an answer
   * that rests on the window alone.
   */
  delivery: {
    before: boolean
    /** Deliveries that fell in the window, newest first. */
    count: number
    /** The delivery that decided it, if any. */
    recordId: string | undefined
    at: number | undefined
    /** `session` when a session id linked them, `window` when only the clock did. */
    bySession: 'session' | 'window' | 'none'
  }
  verdict: GapVerdict
}

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
export function gapKeywords(tool: string, shape: string): string[] {
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
const STOPWORDS: ReadonlySet<string> = new Set([
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
  shape: FailureShape,
  best: { record: MemoryRecord; score: number } | undefined,
  keywords: readonly string[],
  now: number,
): { sinceRecord: number; notWorking: boolean } {
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
  db: DatabaseSync,
  shape: FailureShape,
  now: number,
): GapRow['delivery'] {
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
  db: DatabaseSync,
  input: { workspaceId: string; domain: string; now: number; limit: number; minCount: number },
): GapRow[] {
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

  const rows: GapRow[] = []
  for (const shape of shapes) {
    if (shape.count < input.minCount) continue
    const keywords = gapKeywords(shape.tool, shape.shape)
    let best: { record: MemoryRecord; score: number } | undefined
    for (const { record, text } of haystacks) {
      const score = keywords.filter(keyword => text.includes(keyword)).length
      if (score === 0) continue
      if (best === undefined || score > best.score) best = { record, score }
    }
    const lesson = lessonNotWorking(shape, best, keywords, input.now)
    const delivery = deliveryBeforeShape(db, shape, input.now)
    const completeMatch = best !== undefined && best.score >= keywords.length && keywords.length >= 2
    const verdict: GapVerdict = best === undefined
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
