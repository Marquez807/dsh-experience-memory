/**
 * Just-in-time recall: show a lesson at the moment the agent is about to do the thing.
 *
 * The resident digest competes for five slots against whatever else is important, and it is
 * gated on the turn's query. A recorded lesson therefore loses exactly when it matters most:
 * a user reported one — "confirm Steam is logged in before launching Bannerlord" — that had
 * been injected on nine of a session's fifteen turns and was absent on the turn the work
 * started, where the user had typed "开始吧". The agent launched without Steam and the run
 * was wasted.
 *
 * What the agent is *doing* is the signal that was being thrown away. A tool call names
 * itself: the script it runs, the file it edits, the symbol it searches for. So this module
 * reads the call, pulls the identifiers out of it, and looks for a record that mentions
 * them. No semantics, no model call — an identifier that literally appears in both places.
 *
 * Three properties keep it from becoming another source of noise:
 *
 * 1. **Identifier-only, and only from the values.** Nothing matches on prose, and the
 *    argument *keys* are dropped before anything is read — a call carries `file_path` and
 *    `old_string` on every edit, so counting those as identifiers would make every edit
 *    match every record that ever mentioned editing. What is left is what the call is about:
 *    a path, a file name, a symbol, a switch.
 * 2. **Only an identifier that discriminates.** An identifier is worth acting on when it
 *    picks out a record, and that is measured rather than assumed: the replay of a real
 *    session found `Bannerlord` in 13 of the 17 records that workspace could see, so a
 *    `Bannerlord` hit identifies nothing — while `launch-a-runtime-clean.ps1` appeared in 2
 *    and `ERC403` in 1, which is what the Steam lesson is actually *about*. See
 *    {@link PRECALL_MAX_DOC_FREQ}.
 * 3. **At most one, and free when nothing matches.** One call, one lesson; the common case
 *    is that no discriminating identifier matches and no tokens are spent.
 */
import { windowRecords } from './db.js'
                                               
import { CANDIDATE_LIMIT, retrieve, visible } from './retrieve.js'
import { identifierKey, tokenize } from './tokenize.js'
                                              

/** Bytes one attached lesson may cost. It rides along with a tool result, unasked for. */
export const PRECALL_MAX_BYTES = 300

/**
 * How many visible records may mention an identifier before it stops identifying anything.
 *
 * Measured, not guessed. Replaying the real session this module was written for: `Bannerlord`
 * matched 13 of the 17 records that workspace could see and `BannerlordPlayerLikeAI` matched
 * more still, so on the old rule two calls in three attached something and the lesson that
 * mattered was never the one chosen. At a ceiling of 2 the Steam lesson is attached to the
 * call that runs its script, and the identifier that does it — `launch-a-runtime-clean.ps1` —
 * is genuinely rare.
 *
 * The cost is honest and worth stating: in a store where every record is about the same thing,
 * nothing is attached, because nothing distinguishes them. That is the resident digest's job,
 * not this module's.
 */
export const PRECALL_MAX_DOC_FREQ = 2

/** Identifiers probed per call. Bounds the work a single large tool call can cause. */
const PRECALL_MAX_PROBED = 12

/**
 * Identifier-shaped runs inside a tool call's arguments.
 *
 * Ordered by how specific they are, which is also the order a reader would trust them:
 * a path, then a file name, then a long symbol, then a command-line switch.
 */
const PATTERNS                    = [
  /[A-Za-z]:\\[^\s"'`,;)\]}|]+/g,          // an absolute Windows path
  /(?:^|[\s"'(=])((?:[\w.-]+[\\/])+[\w.-]+)/g, // a relative path
  /\b[\w-]+\.(?:ps1|exe|dll|py|js|mjs|cjs|ts|json|ya?ml|md|xml|acf|cs|csproj|sln|sh)\b/gi,
  /\b[A-Za-z_][A-Za-z0-9_]{5,}\b/g,       // a long symbol or a camel/snake identifier
  /--[a-z][\w-]{2,}/gi,                    // a long switch
]

/**
 * Words that identify nothing.
 *
 * A record mentioning "test" is not about this call. Tool names, common flags, and the
 * directory names every repository has are all excluded for the same reason: they would match
 * half the store and attach an irrelevant lesson to every command.
 */
const GENERIC = new Set([
  'node', 'pwsh', 'powershell', 'bash', 'echo', 'test', 'tests', 'true', 'false', 'null',
  'utf8', 'utf-8', 'json', 'yaml', 'args', 'argv', 'code', 'path', 'file', 'files', 'data',
  'name', 'type', 'value', 'values', 'list', 'item', 'items', 'text', 'main', 'index',
  'src', 'lib', 'dist', 'build', 'out', 'docs', 'doc', 'temp', 'tmp', 'home', 'user',
  'string', 'number', 'boolean', 'object', 'array', 'query', 'limit', 'offset', 'null',
  'command', 'description', 'pattern', 'content', 'message', 'options', 'config',
  'force', 'verbose', 'silent', 'help', 'version', 'output', 'input', 'error',
])

/** Below this, a token is too short to identify anything on its own. */
const MIN_IDENTIFIER = 5

/**
 * The text of a tool call that may name something.
 *
 * Values only. The keys of a tool call's arguments are the tool's schema — `file_path`,
 * `old_string`, `job_id` — and every call of that tool carries them, so treating them as
 * identifiers is how this module first produced a hint on two calls out of three.
 */
function argumentText(value         )         {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return argumentText(JSON.parse(trimmed))
      } catch {
        // Not JSON after all; read it as the plain text it is.
      }
    }
    return value
  }
  if (Array.isArray(value)) return value.map(argumentText).join('\n')
  if (value !== null && typeof value === 'object') {
    return Object.values(value                           ).map(argumentText).join('\n')
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/**
 * The identifiers this call is *about*.
 *
 * Exported because it is the judgement this whole module rests on, and a test that pins it
 * is worth more than one that pins the query it produces.
 */
export function identifiersOf(argumentsValue         )           {
  const text = argumentText(argumentsValue)
  if (text === '') return []

  const found = new Set        ()
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      // Group 1 when the pattern captures, otherwise the whole match.
      const raw = (match[1] ?? match[0]).trim()
      if (raw.length < MIN_IDENTIFIER) continue
      const key = raw.toLowerCase()
      if (GENERIC.has(key)) continue
      // A bare directory name carries no more than a generic word does.
      if (/^[a-z]+$/.test(key) && key.length < 8) continue
      found.add(raw)
    }
  }
  return [...found]
}

/**
 * Identifiers that pick out a record in this window, most specific first.
 *
 * Document frequency is computed over exactly the records the caller could be shown, using
 * the same tokenizer that {@link retrieve.identifierMatches} uses to count a hit — so
 * "discriminating" here means the same thing it means one line later, rather than being an
 * approximation of it.
 */
function discriminating(
  db              ,
  workspaceId        ,
  domain        ,
  keys                   ,
  now        ,
  maxDocFrequency        ,
)           {
  const pool = windowRecords(db, workspaceId, domain, CANDIDATE_LIMIT).filter(record =>
    record.status === 'confirmed'
    && record.supersededBy === null
    && (record.expiresAt === null || record.expiresAt > now)
    && visible(record, workspaceId, domain))
  if (pool.length === 0) return []

  const haystacks = pool.map(record => new Set(tokenize(
    [record.title, record.trigger, record.failureMode, record.lesson, record.body].join('\n'),
  )))
  const kept           = []
  for (const key of keys) {
    let frequency = 0
    for (const haystack of haystacks) if (haystack.has(key)) frequency += 1
    if (frequency > 0 && frequency <= maxDocFrequency) kept.push(key)
  }
  return kept
}

/**
 * The one record worth putting in front of the agent for this call, or nothing.
 *
 * The gate is a shared *discriminating* identifier: the ranker already counts how many of a
 * query's identifiers appear in a record, but a count is only evidence when the identifiers
 * it counts mean something, so the identifiers that half the window shares are dropped
 * before the query is built. Among what is left, the most hits wins, then importance.
 */
export function recallForCall(
  db              ,
  workspaceId        ,
  domain        ,
  argumentsValue         ,
  now        ,
  options                               = {},
)                           {
  const identifiers = identifiersOf(argumentsValue)
  if (identifiers.length === 0) return undefined

  // The raw spelling is what the query keeps — `retrieve` reads the query with the same
  // tokenizer it reads records with, so handing it the folded key would search for a word
  // that only exists because this module made it up.
  const pairs                                 = []
  const seen = new Set        ()
  for (const raw of identifiers) {
    const key = identifierKey(raw)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    pairs.push({ raw, key })
    if (pairs.length >= PRECALL_MAX_PROBED) break
  }
  if (pairs.length === 0) return undefined

  const maxDocFrequency = options.maxDocFrequency ?? PRECALL_MAX_DOC_FREQ
  const rare = new Set(discriminating(db, workspaceId, domain, pairs.map(p => p.key), now, maxDocFrequency))
  if (rare.size === 0) return undefined

  // The surviving raw spellings are handed over as identifiers rather than left to be
  // re-derived from the joined query: the tokenizer would read two adjacent Latin identifiers
  // as one multi-word phrase, and every hit would count as zero.
  const kept = pairs.filter(pair => rare.has(pair.key))
  const { ranked } = retrieve(db, {
    workspaceId,
    domain,
    query: kept.map(pair => pair.raw).join(' '),
    identifiers: kept.map(pair => pair.raw),
    now,
    limit: 16,
    tier: 'recall',
  })
  const hit = ranked
    .filter(entry => entry.identifierMatches > 0 && entry.record.status === 'confirmed')
    .sort((a, b) => (b.identifierMatches - a.identifierMatches) || (b.importance - a.importance))[0]
  return hit?.record
}

/** The line the agent sees. Deliberately short: it rides along with a tool result, unasked. */
export function renderPrecall(record              )         {
  const summary = record.lesson.trim() !== '' ? record.lesson.trim() : record.body.trim()
  const head = `[经验记忆] ${record.title} — `
  const tail = `（出处：${record.id}）`
  const whole = `${head}${summary}${tail}`
  if (byteLength(whole) <= PRECALL_MAX_BYTES) return whole

  // Trim the summary, never the id: the id is what makes the record citable, so it is the
  // one part that must survive the cut. Measured in bytes, one character at a time, because
  // a CJK character costs three and a naive slice would overflow the budget it just checked.
  const room = PRECALL_MAX_BYTES - byteLength(head) - byteLength(tail) - byteLength('…')
  let kept = ''
  for (const character of summary) {
    if (byteLength(kept + character) > room) break
    kept += character
  }
  return `${head}${kept}…${tail}`
}

function byteLength(text        )         {
  let bytes = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
  }
  return bytes
}
