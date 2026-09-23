/**
 * Anchors: the record saying, in advance, which call it applies to.
 *
 * Everything else in the delivery path is an inference — match a token from the call against
 * a token in the record and hope the coincidence means relevance. That inference was
 * measured, and it does not hold up:
 *
 *   - **A sampled audit of 48 real deliveries found 4 that were about the call** (8.3%). The
 *     other 44 fired because some word happened to appear on both sides. `www.mohrss.gov.cn`
 *     matched a lesson about chunked decoding through the word `encoding`; a grep for
 *     `lifecycle` matched a lesson about compatibility shims; `Select-Object -AutoSize`
 *     matched a lesson about output truncation.
 *   - **Even with the loosest matching, only 14 of 25 hand-written "what should fire here"
 *     cases had the right record among the candidates at all** (`tools/replay.mjs
 *     --scenarios`), so no ranking improvement could have saved them. Tightening the rule far
 *     enough to cut the noise cut the recall to single digits.
 *   - The reason is structural, not a bug: a record's `trigger` field was written in prose
 *     ("when you are about to run a git command") and never was a set of keys. Matching
 *     call tokens against prose is guessing, and guessing at a 57%-of-calls rate is not a
 *     memory system, it is noise with a citation.
 *
 * So the mechanism changes from *inferring* applicability to *requiring* it. A meaningful
 * anchor is one of three things a call either touches or does not:
 *
 *   - `path:<file name>` — the call names that file, and **that is the deciding rule**. A
 *     basename is not enough on its own (this workspace has `NOTICE-*.md`, `NOTICE-*.json`
 *     and `NOTICE-*.yaml`, and matching all of them together was a real false positive in
 *     the sampled audit), so the extension must match too.
 *   - `tool:<name>` — the call is that tool. Only an exact name, never a prefix.
 *   - `command:<token>` — the call's command line contains that token.
 *
 * A record with no anchor is **never delivered just-in-time**. It still exists, still shows
 * in the resident digest, still answers `memory_recall`, and can still be `SUPERSEDED` or
 * retired. What it loses is the right to interrupt a tool call on a hunch.
 *
 * ## Where anchors come from
 *
 * Two places, both mechanical:
 *
 *   1. **Backfill from `source_ref`.** A file-verified record already records the file its
 *      claim rests on. When that file is a code or config path (not a report, not a
 *      transcript), it is the best available evidence of where the lesson applies —
 *      `dsh-experience-memory/src/domain.ts:27` came from a lesson about that module, and
 *      `repos/dsh-bigfat/lib/tools.js` from one about that file. `deriveAnchorFromSourceRef` does
 *      this, and it is **off by default**: the measurement in `docs/DELIVERY-GAPS.md` §12.5 found
 *      it fires 247 times on one record, because "the record mentions this file" is not "the
 *      record is about this change".
 *   2. **The record's own `anchors` field**, written by `memory_remember`'s `recall_for`
 *      parameter. This is the durable answer, and the only one that reaches the lessons that
 *      have no code file behind them (a provider quirk, a policy rule, a wrong API shape).
 *
 * The cost is stated rather than hidden: **a record that declares nothing stays silent.**
 * That is the trade this module makes on purpose — silence is recoverable, noise is not,
 * and the point of the whole framework is that a hint means something.
 */
                                                  

/**
 * File suffixes a "this lesson is about this code" anchor may carry.
 *
 * Deliberately a list rather than "anything with a dot": the reports this workspace writes
 * (`.md`, `.jsonl`) are *evidence* files, and a record verified by a report is a record about
 * a finding, not about that report. Anchoring on them would fire on every `read` of the
 * workspace's own audit trail.
 */
export const CODE_SUFFIXES                      = new Set([
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'py', 'ps1', 'psm1', 'sh', 'yml', 'yaml', 'toml',
  'sql', 'css', 'html', 'go', 'rs', 'java', 'cs', 'cpp', 'h', 'rb',
])

/**
 * Tools whose call is an *act* on a file rather than a look at it.
 *
 * The distinction is the difference between a hint and a nuisance. A lesson about
 * `lib/tools.js` is worth interrupting for when that file is about to be written; it is not
 * worth interrupting for when its directory is listed or it is grepped for a symbol. Derived
 * anchors — the ones backfilled from `source_ref` — are only allowed to fire on these tools,
 * because "this file is mentioned in the record's evidence" is weaker evidence than "this file
 * is what the record is about", and the weaker claim only holds up when the call is about to
 * change the file.
 */
export const ACTING_TOOLS                      = new Set(['edit', 'write', 'notebook_edit'])

/** Whether an anchor derived from `source_ref` (rather than declared) may fire on this tool. */
export function actingTool(tool        )          {
  return ACTING_TOOLS.has(tool.trim().toLowerCase())
}

/** One requirement a call must satisfy, parsed from an anchor string. */
                    
                                   
                                   
                                      

/**
 * The marker that separates a record's human prose trigger from its machine anchors.
 *
 * Both live in the `trigger` column, which is the field that already answers "when should
 * this come to mind". A separate column would need a schema version and a migration to carry
 * one string; this keeps the name the model wrote next to the keys it declared, stays
 * readable in the store, and lets `splitTrigger` give the resident digest back exactly the
 * prose it had before. Revisit if a third thing ever needs to live there.
 */
export const ANCHOR_MARKER = '--- anchors ---'

/** Split a `trigger` value into its prose half and its declared anchor strings. */
export function splitTrigger(trigger                           )                                       {
  const text = String(trigger ?? '')
  const at = text.indexOf(ANCHOR_MARKER)
  if (at === -1) return { prose: text, anchors: [] }
  const prose = text.slice(0, at).trim()
  const anchors = text.slice(at + ANCHOR_MARKER.length)
    .split(/[\n,;]+/)
    .map(piece => piece.trim())
    .filter(piece => piece !== '')
  return { prose, anchors }
}

/** Join prose and anchor strings back into one `trigger` value. */
export function joinTrigger(prose        , anchors                   )         {
  const clean = anchors.map(a => a.trim()).filter(a => a !== '')
  if (clean.length === 0) return prose.trim()
  const head = prose.trim()
  const block = `${ANCHOR_MARKER}\n${clean.join('\n')}`
  return head === '' ? block : `${head}\n${block}`
}

/** Parse one anchor string. Unrecognised text is ignored, not guessed at. */
export function parseAnchor(raw        )                     {
  const text = raw.trim()
  if (text === '') return undefined
  const colon = text.indexOf(':')
  if (colon > 0) {
    const kind = text.slice(0, colon).toLowerCase()
    const token = text.slice(colon + 1).trim().toLowerCase()
    if (token === '') return undefined
    if (kind === 'path' || kind === 'tool' || kind === 'command') return { kind, token }
  }
  // A bare file name or path is the common case and is read as a path.
  if (CODE_SUFFIXES.has(suffixOf(text))) return { kind: 'path', token: text.toLowerCase() }
  return undefined
}

/** Parse a record's declared anchors — one per line or comma-separated. */
export function parseAnchors(text                           )           {
  if (text === undefined || text === null) return []
  const out           = []
  const seen = new Set        ()
  for (const piece of String(text).split(/[\n,;]+/)) {
    const anchor = parseAnchor(piece)
    if (anchor === undefined) continue
    const key = `${anchor.kind}:${anchor.token}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(anchor)
  }
  return out
}

/** Lower-case suffix after the last dot, or `''`. */
export function suffixOf(path        )         {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** The file name of a path, folded to lower case. */
export function baseNameOf(path        )         {
  return (path.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase()
}

/**
 * Whether a `source_ref` is a code path this lesson can be anchored to.
 *
 * `path/file.ts:123` → `path:path/file.ts`; a `.md`/`.jsonl` reference returns `undefined`
 * because the record's evidence is a report, not the file it talks about.
 *
 * The whole relative path is kept, not the file name: the name alone matched three unrelated
 * `tools.js` files and fired 508 times (see {@link anchorSatisfied}).
 */
export function deriveAnchorFromSourceRef(sourceRef                           )                     {
  if (sourceRef === undefined || sourceRef === null) return undefined
  let text = String(sourceRef).trim()
  if (text === '') return undefined
  // A tool-call id is not a path; it proves the record, it does not locate it.
  if (/^call_/i.test(text)) return undefined
  // Strip a trailing `:line` or `:line:col`, but keep a Windows drive letter.
  text = text.replace(/:\d+(?::\d+)?$/, '')
  if (!CODE_SUFFIXES.has(suffixOf(text))) return undefined
  return { kind: 'path', token: text.replace(/\\/g, '/').toLowerCase() }
}

/** The call's own facts an anchor is checked against. */
                         
              
                                                                             
                 
                                                                 
                 
                                                                         
              
 

/** Collect the facts an anchor can be checked against, from one tool call. */
export function callFacts(tool        , argumentsValue         )            {
  const paths           = []
  const chunks           = []
  const walk = (value         )       => {
    if (typeof value === 'string') {
      chunks.push(value)
      for (const match of value.matchAll(PATH_LIKE)) paths.push(match[1] ?? match[0])
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value                           )) walk(item)
      return
    }
    if (typeof value === 'number' || typeof value === 'boolean') chunks.push(String(value))
  }
  walk(argumentsValue)
  const text = chunks.join('\n').toLowerCase()
  const command = typeof argumentsValue === 'object' && argumentsValue !== null
    ? String((argumentsValue                         ).command ?? '').toLowerCase()
    : ''
  return { tool: tool.toLowerCase(), paths: paths.map(p => p.toLowerCase()), command, text }
}

const PATH_LIKE = /([A-Za-z]:\\[^\s"'`,;)\]}|]+|(?:[\w.-]+[\\/])+[\w.-]+|\b[\w-]+\.[A-Za-z0-9]{1,6}\b)/g

/**
 * Whether one anchor is satisfied by a call.
 *
 * `path:` is the strict one, and stricter than a bare file name on purpose. Measured on the live
 * store: anchoring a lesson about one project's `lib/tools.js` by *name* made it fire **508
 * times** in 15,896 calls, because three unrelated files in this workspace are called
 * `tools.js`. So when the anchor names directories — `repos/dsh-bigfat/lib/tools.js` — the
 * call's path must end with that whole tail. A bare name still matches by name, because that is
 * what a hand-written `recall_for: ['path:service.yaml']` means; it is now the option a writer
 * chooses rather than the one a backfill falls into.
 */
export function anchorSatisfied(anchor        , facts           )          {
  if (anchor.kind === 'tool') return facts.tool === anchor.token
  if (anchor.kind === 'command') return anchor.token !== '' && facts.command.includes(anchor.token)
  const wanted = anchor.token.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  const hasDirectory = wanted.includes('/')
  for (const path of facts.paths) {
    const given = path.replace(/\\/g, '/').toLowerCase()
    if (hasDirectory) {
      if (given === wanted || given.endsWith(wanted)) return true
    } else if (baseNameOf(given) === wanted) {
      return true
    }
  }
  // A path can also arrive as a bare fragment inside a longer command line.
  if (facts.command.includes(hasDirectory ? wanted : baseNameOf(anchor.token))) return true
  return false
}

/** Whether any of a record's anchors is satisfied. An empty list is never satisfied. */
export function anchorsSatisfied(anchors                   , facts           )          {
  for (const anchor of anchors) if (anchorSatisfied(anchor, facts)) return true
  return false
}

/** One anchor this plugin would propose, with the reason it is being proposed. */
                                   
                                                                       
                
                                                                                           
                 
 

/** The tool calls of the newest turn, oldest first. */
function turnCalls(events                             )                                         {
  let start = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') {
      start = index
      break
    }
  }
  const calls                                         = []
  for (let index = start; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type !== 'tool/call') continue
    const name = event.data?.name
    if (typeof name !== 'string' || name === '') continue
    calls.push({ name, arguments: event.data?.arguments })
  }
  return calls
}

/** Tool arguments arrive as a JSON string in the session log; parse them when they are. */
function parseArguments(value         )          {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * The first token of a command line, when it can plausibly name a program.
 *
 * Live check 2026-09-24: the first real call proposed `command:$target` — that turn's PowerShell
 * began with an assignment, so the "command" was a variable name, and the anchor would have
 * matched any later call that happened to mention it. A variable or a flag is not a program.
 */
function commandToken(command        )         {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const clean = first.replace(/^[&"']+/, '').replace(/["']+$/, '')
  if (clean === '' || clean.startsWith('$') || clean.startsWith('-')) return ''
  return /^[a-z0-9][a-z0-9._+-]*$/i.test(clean) ? clean : ''
}

/** Noise a workspace-relative anchor should never be built from. */
function anchorablePath(path        )          {
  if (path === '') return false
  if (/^[a-z]:\//.test(path) || path.startsWith('/')) return false // absolute: not portable
  if (path.includes('node_modules/') || path.startsWith('.git/')) return false
  if (!path.includes('/')) return false // a directory-bearing path; a bare name fired 508 times once
  // The rule `deriveAnchorFromSourceRef` already applies: a report is evidence, not a location.
  // Live check 2026-09-24 — the first real call proposed `path:.../DELIVERY-GAPS.md` because the
  // turn had read it, and anchoring there fires on whoever edits the audit trail rather than on
  // the edit the lesson is about.
  return CODE_SUFFIXES.has(suffixOf(path))
}

/**
 * Propose the anchors a record could declare, from the turn it is being written in.
 *
 * Measured on the live store (T1, 2026-09-23): across 159 records, the file a record cites was
 * named by the turn's own tool calls in **67.3%** of cases at a ±8-call window and **90.6%** at
 * ±24, against a random control that was **0%** at every window. `recall_for` is the only thing
 * that makes a lesson interrupt a call, and 152 of 163 deliverable records had never declared
 * one — the missing step was the reading, not the deciding.
 *
 * So this reads the turn and **proposes**; it never writes. A 67–90% signal is a suggestion,
 * and a wrong anchor fires a lesson at the wrong moment — the caller confirms, or nothing is
 * declared.
 */
export function suggestAnchors(input   
                                                                                             
                                     
                           
                
 )                     {
  const limit = Math.max(1, Math.trunc(input.limit ?? 2))
  const out                     = []
  const seen = new Set        ()
  const add = (kind        , token        , because        )          => {
    const clean = String(token).trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
    if (clean === '') return false
    const key = `${kind}:${clean}`
    if (seen.has(key)) return false
    seen.add(key)
    out.push({ anchor: `${kind}:${clean}`, because })
    return out.length >= limit
  }

  // The cited passage first: it is the one thing the writer has already decided the lesson is
  // about.
  const cited = deriveAnchorFromSourceRef(input.sourceRef)
  if (cited !== undefined && add(cited.kind, cited.token, 'cited as source_ref')) return out

  // Then the newest turn, newest call first: a lesson is usually learned from what the turn was
  // reading or writing when someone decided to record it.
  for (const call of turnCalls(input.events).reverse()) {
    const facts = callFacts(call.name, parseArguments(call.arguments))
    for (const path of facts.paths) {
      if (!anchorablePath(path)) continue
      if (add('path', path, `named by ${facts.tool} in this turn`)) return out
    }
    if (facts.command !== '') {
      const token = commandToken(facts.command)
      if (token !== '' && add('command', token, `run by ${facts.tool} in this turn`)) return out
    }
    if (add('tool', facts.tool, 'the tool this turn used')) return out
  }
  return out
}
