/**
 * The resident digest, in one place.
 *
 * `apply()` contributes this through `ctx.systemPrompt.context`, and the
 * `/memory-preview` command prints it. Both must be the *same* function: a
 * preview that computed the digest its own way could disagree with what is
 * actually sent, which would defeat the only reason it exists.
 *
 * The query builder deliberately skips messages this plugin contributed. Without
 * that, the digest injected on turn N is read back as context on turn N+1 and the
 * same few records keep selecting themselves.
 */
                                               
                                                 
import { resolveWorkspace } from './domain.js'
import { renderDigest, renderRecall, renderResident } from './inject.js'
import { retrieve, retrieveCore } from './retrieve.js'
import { eventsOf } from './session.js'
                                           

                         

/**
 * Headings for the two digest sections.
 *
 * They say *why* a line is present, because the two reasons carry different
 * weight: a corroborated cross-project lesson is a standing rule, while a
 * query-matched record is a suggestion for this task. Presenting them under one
 * heading would hide that difference from the model.
 */
export const CORE_LABEL = '经验记忆（领域通用，已由多个项目独立印证）：'
export const MATCHED_LABEL = '经验记忆（与本轮相关）：'

/**
 * The standing instruction that makes recording happen at all.
 *
 * Without it the store stays empty in practice. The model already had the tool
 * schema — this is measured, not assumed: across five real sessions and roughly
 * 5,900 tool calls, with the memory tools present in every request epoch after
 * installation, `memory_remember` was never called once until a human asked for a
 * record by name. A capability nobody is reminded of is a capability nobody uses.
 *
 * It is contributed as its own prompt context rather than appended to the digest,
 * because the digest renders `''` whenever no record is eligible — which is exactly
 * the state in which the reminder is needed. Appending it there would make the
 * instruction disappear precisely when it matters, which is how the store stayed
 * empty in the first place.
 *
 * Kept to one short line and bounded by a test, because it costs tokens on every
 * single turn whether or not the memory has anything to say.
 */
/**
 * The standing hint. Unconditional, query-independent, paid for on every turn.
 *
 * It asks for both halves of the loop. Recording was the half that got a hint first,
 * and the reason is measured rather than assumed: across five real sessions and ~5,900
 * tool calls the memory tools were offered on every request after installation, and
 * `memory_remember` was never called once until someone named it explicitly. Being
 * available was not the same as being used.
 *
 * Retrieval had exactly the same problem and no hint. The consequence was worse than
 * symmetric: a memory that no later session looks for cannot earn the reuse bonus that
 * keeps it in the always-on layer, so it fell silent within hours of being written and
 * the store filled with records nothing would ever read. Hence "查" first, then "记".
 */
export const RECORD_HINT =
  '经验记忆：动手前先用 memory_recall 查有没有相关经验；学到可复用的约定/边界/教训就用 memory_remember 记下（附原文与出处），用过就 memory_feedback 记一笔。'

/**
 * The ceiling the standing hint may not exceed, in UTF-8 bytes.
 *
 * A number rather than a habit: the hint is paid for on every turn, so widening it
 * is a product decision. The README states this figure and the hint's current size,
 * and the suite checks all three against each other.
 */
export const RECORD_HINT_MAX_BYTES = 256

/**
 * Bounds on the derived retrieval query, so one huge message cannot dominate.
 *
 * What the query is built *from* matters more than its size, and the first version got
 * that wrong: it read only the user's messages. On a turn where the user says "开始吧" the
 * query therefore carried nothing, and the always-on layer went empty exactly when the
 * agent was about to act. It happened for real — a recorded lesson saying "confirm Steam is
 * logged in before launching Bannerlord" was in the store, was injected on nine of the
 * session's fifteen turns, and was absent on the one turn where the work started, because
 * those three characters share no term with it. The agent then launched without Steam and
 * the run was wasted.
 *
 * Who is doing the work decides what is relevant — not how the request happened to be
 * phrased. So the query now also carries what the agent is *doing*: its own last statement,
 * its todo list, and the arguments of its recent tool calls, which for a shell tool is the
 * command itself. That is the difference between "the user said 开始吧" and "the agent is
 * about to run `launch-a-runtime-clean.ps1`".
 */
export const QUERY_USER_MESSAGES = 2
export const QUERY_MESSAGE_BYTES = 600
/** Recent actions to read, and how much of each argument blob (a shell command is long). */
export const QUERY_ACTIONS = 3
export const QUERY_ACTION_BYTES = 240
/** The agent's own last statement, and how many todo lines. */
export const QUERY_STATEMENT_BYTES = 400
export const QUERY_TODOS = 6

/** The slice of the session this plugin reads. Structural: no import. */
                                   
               
          
                              
                     
                                                               
                 
                       
                   
   
 

                            
            
                
 

function textOfContent(content         )         {
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

/**
 * What the agent is doing, as terms a search can use.
 *
 * Three sources, in the order a reader would weigh them: the arguments of what it just
 * ran (for a shell tool, the command itself), the last thing it said, and the task list it
 * is working through. Only `text` blocks of an assistant message are read — `reasoning` is
 * the model's private working, and feeding its own speculation back into the query is the
 * loop this plugin already refuses to open on the injection side.
 */
function whatTheAgentIsDoing(events                             )           {
  const actions           = []
  let statement = ''
  let todos = ''
  for (const event of [...events].reverse()) {
    if (event.data?.source?.kind === 'plugin') continue
    if (event.type === 'assistant/message') {
      if (statement !== '') continue
      const blocks = event.data?.message?.content ?? event.data?.content
      if (!Array.isArray(blocks)) continue
      const spoken = blocks
        .filter(block => typeof block === 'object' && block !== null
          && (block                      ).type === 'text')
        .map(block => String((block                      ).text ?? ''))
        .join('\n')
        .trim()
      if (spoken !== '') statement = spoken.slice(0, QUERY_STATEMENT_BYTES)
      continue
    }
    if (event.type === 'todo/write') {
      if (todos !== '') continue
      const list = event.data?.todos
      if (!Array.isArray(list)) continue
      todos = list
        .slice(0, QUERY_TODOS)
        .map(item => String((item                         )?.content ?? '').trim())
        .filter(line => line !== '')
        .join('；')
      continue
    }
    if (event.type === 'tool/call' && actions.length < QUERY_ACTIONS) {
      const name = event.data?.name
      if (typeof name !== 'string' || name === '') continue
      const args = event.data?.arguments
      const tail = typeof args === 'string' ? args.slice(0, QUERY_ACTION_BYTES) : ''
      actions.push(`${name} ${tail}`.trim())
    }
  }
  return [...actions, statement, todos].filter(part => part !== '')
}

/** Derive this turn's retrieval query: what was asked, and what the agent is doing. */
export function recentQueryText(agent                       )         {
  const events = eventsOf(agent)
  const parts           = []
  let seen = 0
  for (const event of [...events].reverse()) {
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind === 'plugin') continue
    const text = textOfContent(event.data?.content).trim()
    if (text === '') continue
    parts.unshift(text.slice(0, QUERY_MESSAGE_BYTES))
    seen += 1
    if (seen >= QUERY_USER_MESSAGES) break
  }
  // The request first, then the work: a reader skimming a preview sees the task before the
  // machinery, and the existing expectations for a session with no activity are unchanged.
  return [...parts, ...whatTheAgentIsDoing(events)].join('\n')
}

/** The workspace a turn runs in, defaulting to the process directory. */
export function workspaceOf(agent                       , configuredDomain        )            {
  return resolveWorkspace(agent?.session?.header?.cwd, configuredDomain)
}

                              
                  
                        
                      
               
             
 

/**
 * Render the digest for one assembly. Throws rather than returning `''` when a
 * lookup fails: an unavailable digest and an empty one look the same to a caller,
 * so the decision to hide a failure belongs to the caller, not here.
 */
export function buildDigest(input             )         {
  const { db, config, workspace, query, now } = input
  const budget = { maxRecords: config.residentMaxRecords, maxBytes: config.residentMaxBytes }

  // The query-matched layer. Query-gated by design, so it empties when the turn
  // carries no term to match — which is most short replies.
  const { ranked } = retrieve(db, {
    workspaceId: workspace.id,
    domain: workspace.domain,
    query,
    now,
    limit: config.residentMaxRecords,
    tier: 'resident',
  })

  // The core layer: lessons two independent workspaces reported, injected whether
  // or not this turn mentions them. Sharing one byte budget with the matched layer
  // means the guarantee re-allocates prompt rather than growing it.
  const core = config.coreMaxRecords > 0
    ? retrieveCore(db, { domain: workspace.domain, now, limit: config.coreMaxRecords }).ranked
    : []

  if (core.length === 0) return renderResident(ranked, budget)

  // A record can be both, and must not be shown twice.
  const coreIds = new Set(core.map(entry => entry.record.id))
  return renderDigest([
    { label: CORE_LABEL, ranked: core },
    { label: MATCHED_LABEL, ranked: ranked.filter(entry => !coreIds.has(entry.record.id)) },
  ], budget)
}

                                                   
                             
                          
                
 

/** What one turn would send: the digest, and what an on-demand recall adds. */
export function previewMemory(input              )   
                
                                                                               
  {
  const digest = buildDigest(input)
  const { ranked } = retrieve(input.db, {
    workspaceId: input.workspace.id,
    domain: input.workspace.domain,
    query: input.query,
    now: input.now,
    limit: input.limit ?? 8,
    tier: 'recall',
    includeCandidates: input.includeCandidates ?? false,
    includeRetired: input.includeRetired ?? false,
  })
  return { digest, recall: renderRecall(ranked, input.config.recallMaxBytes) }
}
