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
import { evictFailureShapes, failureShapeWorkspaces, failureShapes, noteFailureShape, windowRecords } from './db.ts'
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
}

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
 * The learning gap: shapes this workspace repeats, and how close the store comes to them.
 *
 * The overlap is reported as a score with the nearest record, never as a verdict — see
 * {@link GapRow.closest} for why a boolean would be dishonest here.
 */
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
    text: [record.title, record.trigger, record.failureMode, record.lesson, record.body].join('\n').toLowerCase(),
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
    rows.push({
      shape,
      closest: best?.record,
      bestScore: best?.score ?? 0,
      keywords,
      workspaces: failureShapeWorkspaces(db, shape.tool, shape.shape),
    })
  }
  return rows
}
