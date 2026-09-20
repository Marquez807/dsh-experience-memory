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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { eventsOf } from './session.js'
                                                     

                         

                                  
                                                                                 
                
                                                                          
                    
                       
                   
 

/**
 * Which route produced the grade.
 *
 * `source_ref` is deliberately dual-purpose — a tool call id or a `path:line` — and a
 * caller could not tell from the result which one had been tried, so a path typed into
 * a field the plugin read as an id (or the reverse) looked exactly like a bad quote.
 * `none` means nothing verified the claim and `reason` enumerates what was attempted.
 */
                                                                          

                                  
                 
                      
                                                                                           
                
 

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
export function unsafeStatement(text        )          {
  const trimmed = text.trim()
  if (trimmed === '') return true
  return HEDGE.test(trimmed) || CITATION.test(trimmed)
}

function textOf(content         )         {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts           = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'text' in block) {
      const { text } = block                      
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** Split `path:line` into its parts; a line number is optional. */
export function parseSourceRef(sourceRef        )                                               {
  const trimmed = sourceRef.trim()
  if (trimmed === '') return null
  const match = /^(.*?):(\d+)$/.exec(trimmed)
  if (match?.[1] === undefined) return { path: trimmed, line: null }
  return { path: match[1], line: Number(match[2]) }
}

/** Why a cited file could not be checked. Every one of these used to be the same silence. */
                                                                       

/** The outcome of reading a cited file, carrying the reason when it failed. */
                               
                              
                                                                                            

/**
 * Read a workspace-relative file for quote verification.
 *
 * Never throws: an unverifiable claim is simply unverified. But it no longer returns a
 * bare `undefined` for four different situations, because the caller then had nothing
 * to report and every failure arrived as "no session or workspace evidence matched the
 * supplied passage" — a sentence that names the *quote* while the real problem was the
 * *path*. A caller misdiagnosed three of its own records that way before reading this
 * file. The reason is now data.
 */
export function readWorkspaceFile(root        , relPath        )                    {
  if (relPath === '') return { ok: false, miss: 'missing', path: relPath }
  if (isAbsolute(relPath)) return { ok: false, miss: 'absolute', path: relPath }
  const target = resolve(root, relPath)
  const rel = relative(resolve(root), target)
  if (rel.startsWith('..') || isAbsolute(rel)) return { ok: false, miss: 'escape', path: relPath }
  try {
    if (!existsSync(target)) {
      // A cited path is usually one segment away from the real one, and the useful
      // listing is therefore of the *nearest existing ancestor*: a caller that wrote
      // `lib/tools.js` for a repo checked out at `repos/dsh-quant/lib/tools.js` has no
      // `lib/` to list, and the fact it needs is that the root holds `repos/`.
      let entries                      
      let where                    
      try {
        let probe = dirname(target)
        for (let depth = 0; depth < 8; depth += 1) {
          if (existsSync(probe)) {
            entries = readdirSync(probe).slice(0, 12)
            where = relative(resolve(root), probe) || '.'
            break
          }
          const parent = dirname(probe)
          if (parent === probe) break
          probe = parent
        }
      } catch {
        entries = undefined
      }
      return { ok: false, miss: 'missing', path: relPath, where, entries }
    }
    return { ok: true, text: readFileSync(target, 'utf8').slice(0, FILE_BYTES) }
  } catch {
    return { ok: false, miss: 'unreadable', path: relPath }
  }
}

/** Markdown decoration that a quote copied out of a table or a doc comment tends to drop. */
const DECORATION = /\*\*|__|`|^\s*\*\s?/gm

/**
 * What to tell a caller whose quote did not appear in the file it cited.
 *
 * A quote taken from a JSDoc comment, a bolded table row or any markdown line usually
 * loses its decoration in transit, and strict matching then fails with no clue why.
 * The decorated difference is *diagnosed* here rather than accepted: verification keeps
 * meaning verbatim, and the caller gets the one fact it needs to fix its own quote.
 */
function describeQuoteMiss(text        , quote        )         {
  const bare = (value        )         => value.replace(DECORATION, '').replace(/\s+/g, ' ').trim()
  if (bare(text).includes(bare(quote))) {
    return 'the quote matches this file only after markdown decoration is ignored '
      + '(`**`, backticks, a leading `* `) — copy the line verbatim, decoration included, to verify it'
  }
  const quoteTokens = new Set(quote.replace(DECORATION, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  let bestLine = 0
  let bestScore = 0
  let bestText = ''
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const tokens = lines[index] .toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
    if (tokens.length === 0) continue
    let shared = 0
    for (const token of tokens) if (quoteTokens.has(token)) shared += 1
    const score = shared / Math.max(1, Math.min(tokens.length, quoteTokens.size))
    if (score > bestScore) {
      bestScore = score
      bestLine = index + 1
      bestText = lines[index] .trim().slice(0, 100)
    }
  }
  if (bestScore >= 0.5) {
    return `the quote is not a verbatim substring; line ${bestLine} is closest: ${JSON.stringify(bestText)}`
  }
  return 'the quote does not appear in the cited file at all'
}

/** One sentence naming why a cited path could not be checked, with the fix when there is one. */
function describeMiss(
  read                                                                               ,
  root        ,
)         {
  switch (read.miss) {
    case 'absolute':
      return `source_ref is an absolute path (${read.path}); a file claim must name a workspace-relative `
        + `path — rewrite it as <dir>/<file>:<line> against the working root ${root}`
    case 'escape':
      return `the path leaves the workspace (${read.path})`
    case 'unreadable':
      return `the file exists but could not be read (${read.path})`
    case 'missing':
    default:
      return `no such file in the workspace (${read.path} against ${root})`
        + (read.entries === undefined || read.entries.length === 0
          ? ''
          : `; the nearest existing directory "${read.where ?? '.'}" holds ${read.entries.join(', ')}`)
  }
}

/** Find a successful tool result for one call id in this session. */
function toolResultSucceeded(events                             , callId        )                      {
  for (const event of [...events].reverse()) {
    if (event.type !== 'tool/result') continue
    const message = event.data?.message
    const id = message?.source?.callId ?? event.data?.source?.callId
    if (id !== callId) continue
    const blocks = message?.content ?? event.data?.content
    if (!Array.isArray(blocks)) return true
    // A single-error block marks the call failed; anything else counts as success.
    return !blocks.some(block =>
      typeof block === 'object' && block !== null && (block                         ).isError === true)
  }
  return undefined
}

/** Find the non-plugin user message containing the quote, and return it. */
function userMessageContaining(events                             , quote        )                     {
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
export function sentenceAround(text        , quote        )         {
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
export function gradeEvidence(request                 )                  {
  const quote = (request.quote ?? '').trim()
  if (quote === '') {
    return {
      grade: 'inferred',
      route: 'none',
      reason: 'no verbatim passage supplied, so nothing can be verified',
    }
  }

  const events = eventsOf(request.agent)
  const sourceRef = request.sourceRef?.trim() ?? ''
  // Every attempt is recorded so a failure can name what was tried. A caller that has
  // to design experiments to discover why its own record was not verified is a caller
  // losing an hour to a return value.
  const tried           = []

  if (sourceRef !== '' && events.length > 0) {
    const succeeded = toolResultSucceeded(events, sourceRef)
    if (succeeded === true) {
      return {
        grade: 'verified-tool',
        route: 'tool-call',
        reason: `tool call ${sourceRef} completed without error in this session`,
      }
    }
    tried.push(succeeded === false
      ? `source_ref "${sourceRef}" is a tool call that reported an error, so it proves nothing`
      : `source_ref "${sourceRef}" matched no tool call in this session`)
  } else if (sourceRef !== '') {
    tried.push(`source_ref "${sourceRef}" could not be checked against tool calls: no session log is available`)
  } else {
    tried.push('no source_ref was supplied, so only the session\'s own messages could be checked')
  }

  if (sourceRef !== '') {
    const parsed = parseSourceRef(sourceRef)
    if (parsed === null) {
      tried.push(`source_ref "${sourceRef}" is empty once trimmed`)
    } else {
      tried.push(`source_ref "${sourceRef}" was read as the path "${parsed.path}"`)
      const read = readWorkspaceFile(request.workspaceRoot, parsed.path)
      if (read.ok) {
        if (read.text.includes(quote)) {
          return {
            grade: 'verified-file',
            route: 'file',
            reason: `quote appears in ${parsed.path}${parsed.line === null ? '' : ` (cited line ${parsed.line})`}`,
          }
        }
        tried.push(`the file was read but the quote is not in it — ${describeQuoteMiss(read.text, quote)}`)
      } else {
        tried.push(describeMiss(read, request.workspaceRoot))
      }
    }
  }

  if (events.length > 0) {
    tried.push('no message the user sent contains the quote verbatim')
  } else {
    tried.push('no session log is available, so no user message could be checked')
  }

  const said = events.length > 0 ? userMessageContaining(events, quote) : undefined
  if (said !== undefined) {
    const sentence = sentenceAround(said, quote)
    if (unsafeStatement(sentence)) {
      return {
        grade: 'inferred',
        route: 'user-message',
        reason: 'the sentence containing this passage is a question or a hedge, not an assertion',
      }
    }
    return {
      grade: 'verified-user',
      route: 'user-message',
      reason: 'verbatim quote appears in an assertion the user made',
    }
  }

  return {
    grade: 'inferred',
    route: 'none',
    reason: `nothing verified this claim. Tried: ${tried.join('; ')}.`,
  }
}
