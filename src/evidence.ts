/**
 * Evidence grading, done automatically from the session's own record.
 *
 * The archived runtime graded evidence by requiring an operator to pre-register
 * a script hash and replay it 2–32 times before a record could be promoted.
 * The mechanism was sound and the cost was fatal: after 139 work cycles the
 * store held zero confirmed facts. Grading here is cheap enough to actually
 * happen — a claim carries the verbatim passage it rests on, and the plugin
 * checks that passage against the session and the workspace.
 *
 * Grades, strongest first:
 *
 * - `verified-tool`   the claim cites a tool call that ran in this session and
 *                     did not report an error
 * - `verified-user`   the verbatim quote appears in a message the human sent,
 *                     and is not a question or a hedge
 * - `verified-file`   the quote appears in the file the claim cites, inside the
 *                     workspace
 * - `inferred`        none of the above; recorded, but never injected
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Evidence } from './types.ts'

/** The slice of the session this module reads. Structural, so nothing leaks in. */
export interface SessionEventLike {
  type?: string
  data?: {
    source?: { kind?: string; callId?: string }
    content?: unknown
    message?: {
      source?: { kind?: string; callId?: string }
      content?: unknown
    }
  }
}

export interface SessionLike {
  session?: { header?: { cwd?: string }; events?: readonly SessionEventLike[] }
}

export interface EvidenceRequest {
  /** The verbatim passage the claim rests on. Absent means no verified grade. */
  quote?: string
  /** `path:line` for a file claim, or a tool call id for a tool claim. */
  sourceRef?: string
  workspaceRoot: string
  agent?: SessionLike
}

export interface EvidenceVerdict {
  grade: Evidence
  /** Why this grade, in a form a human can audit. */
  reason: string
}

/** Cap on how much file text is read to verify one quote. */
const FILE_BYTES = 1_048_576

/**
 * Phrasing that must not be promoted to a confirmed fact even when the user
 * typed it. A question is a request for an answer, not an assertion, and a
 * hedge is the speaker declining to commit.
 */
const HEDGE = /[?？]|可能|也许|大概|似乎|不确定|假设|假如|如果|应该是|会不会/
/** A passage wrapped in quotation marks is a citation of someone else's words. */
const CITATION = /^[\s]*[「『“"'][\s\S]*[」』”"'][\s]*$/

/** Whether a user passage is too weak to become a confirmed fact. */
export function unsafeStatement(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  return HEDGE.test(trimmed) || CITATION.test(trimmed)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'text' in block) {
      const { text } = block as { text?: unknown }
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** Split `path:line` into its parts; a line number is optional. */
export function parseSourceRef(sourceRef: string): { path: string; line: number | null } | null {
  const trimmed = sourceRef.trim()
  if (trimmed === '') return null
  const match = /^(.*?):(\d+)$/.exec(trimmed)
  if (match?.[1] === undefined) return { path: trimmed, line: null }
  return { path: match[1], line: Number(match[2]) }
}

/**
 * Read a workspace-relative file for quote verification.
 *
 * Returns `undefined` rather than throwing for anything that is not a readable
 * regular file inside the workspace: an unverifiable claim is simply unverified.
 */
export function readWorkspaceFile(root: string, relPath: string): string | undefined {
  if (relPath === '' || isAbsolute(relPath)) return undefined
  const target = resolve(root, relPath)
  const rel = relative(resolve(root), target)
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined
  try {
    if (!existsSync(target)) return undefined
    return readFileSync(target, 'utf8').slice(0, FILE_BYTES)
  } catch {
    return undefined
  }
}

/** Find a successful tool result for one call id in this session. */
function toolResultSucceeded(events: readonly SessionEventLike[], callId: string): boolean | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== 'tool/result') continue
    const message = event.data?.message
    const id = message?.source?.callId ?? event.data?.source?.callId
    if (id !== callId) continue
    const blocks = message?.content ?? event.data?.content
    if (!Array.isArray(blocks)) return true
    // A single-error block marks the call failed; anything else counts as success.
    return !blocks.some(block =>
      typeof block === 'object' && block !== null && (block as { isError?: unknown }).isError === true)
  }
  return undefined
}

/** Find the non-plugin user message containing the quote, and return it. */
function userMessageContaining(events: readonly SessionEventLike[], quote: string): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind === 'plugin') continue
    const text = textOf(event.data?.content)
    if (text.includes(quote)) return text
  }
  return undefined
}

const SENTENCE_BREAK = ['。', '\n', '.', '！', '？', '!', '?', '；', ';']

/**
 * The sentence the quote sits in.
 *
 * Judging the quote alone is not enough: `部署在 F 盘` is a plain assertion, but
 * the same words inside `部署在 F 盘吗？` are a question. The unit that carries
 * the speaker's stance is the sentence, so that is what gets judged.
 */
export function sentenceAround(text: string, quote: string): string {
  const at = text.indexOf(quote)
  if (at < 0) return quote
  let start = 0
  for (const mark of SENTENCE_BREAK) {
    const found = text.lastIndexOf(mark, at)
    if (found + 1 > start) start = found + 1
  }
  let end = text.length
  for (const mark of SENTENCE_BREAK) {
    const found = text.indexOf(mark, at + quote.length)
    if (found >= 0 && found + 1 < end) end = found + 1
  }
  return text.slice(start, end).trim()
}

/** Grade one claim. Never throws: an unverifiable claim is `inferred`. */
export function gradeEvidence(request: EvidenceRequest): EvidenceVerdict {
  const quote = (request.quote ?? '').trim()
  if (quote === '') {
    return { grade: 'inferred', reason: 'no verbatim passage supplied, so nothing can be verified' }
  }

  const events = request.agent?.session?.events ?? []
  const sourceRef = request.sourceRef?.trim() ?? ''

  if (sourceRef !== '' && events.length > 0) {
    const succeeded = toolResultSucceeded(events, sourceRef)
    if (succeeded === true) {
      return { grade: 'verified-tool', reason: `tool call ${sourceRef} completed without error in this session` }
    }
    if (succeeded === false) {
      return { grade: 'inferred', reason: `tool call ${sourceRef} reported an error, so it proves nothing` }
    }
  }

  if (sourceRef !== '') {
    const parsed = parseSourceRef(sourceRef)
    const text = parsed === null ? undefined : readWorkspaceFile(request.workspaceRoot, parsed.path)
    if (text !== undefined && text.includes(quote)) {
      return { grade: 'verified-file', reason: `quote appears in ${parsed?.path ?? sourceRef}` }
    }
  }

  if (events.length > 0) {
    const said = userMessageContaining(events, quote)
    if (said !== undefined) {
      const sentence = sentenceAround(said, quote)
      if (unsafeStatement(sentence)) {
        return { grade: 'inferred', reason: 'the sentence containing this passage is a question or a hedge, not an assertion' }
      }
      return { grade: 'verified-user', reason: 'verbatim quote appears in an assertion the user made' }
    }
  }

  return { grade: 'inferred', reason: 'no session or workspace evidence matched the supplied passage' }
}
