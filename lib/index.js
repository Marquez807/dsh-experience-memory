/**
 * experience-memory — domain-scoped long-term experience for DeepSeek Harness.
 *
 * Three surfaces:
 *
 * 1. A resident digest contributed through `ctx.systemPrompt.context`, which is
 *    re-evaluated at every assembly, so it always reflects the current task
 *    rather than a snapshot taken once at boot.
 * 2. Model-facing tools: recall, remember, feedback, forget.
 * 3. A bounded maintenance pass at `agent/turn-stopping`, which is where decay
 *    and retirement run — never on the retrieval path.
 *
 * The plugin deliberately has no `agent/pre-step` injection: writing synthetic
 * user messages into the session would put memory text into the transcript,
 * where the next turn's own retrieval query would read it back and reinforce
 * it. That feedback loop is what turned Mem0's production store into 97.8%
 * noise. The query builder below excludes plugin-sourced messages for the same
 * reason.
 */
                                                  
import { defineTool } from '@deepseek-ai/dsh-tools'
                                               
import { Config, resolveConfig,                                 } from './config.js'
import { openDb } from './db.js'
import { resolveWorkspace } from './domain.js'
import { forget, maintain, recordUsage, remember } from './lifecycle.js'
import { renderDigest, renderRecall, renderResident } from './inject.js'
import { retrieve, retrieveCore } from './retrieve.js'
                                             

export const name = 'experience-memory'

/** Both services must be present for the plugin's surfaces to exist. */
export const inject = ['tools', 'systemPrompt']

export { Config }
                                

/** The context name shown in prompt diagnostics. */
const CONTEXT_NAME = 'experience-memory:resident'

/**
 * Sections render in ascending order: `-100` harness identity, `0` persona,
 * `100`–`199` tool guidance. Experience sits at the end of the guidance band so
 * it reads immediately before the conversation.
 */
const CONTEXT_ORDER = 150

/**
 * Headings for the two digest sections.
 *
 * They say *why* a line is present, because the two reasons carry different
 * weight: a corroborated cross-project lesson is a standing rule, while a
 * query-matched record is a suggestion for this task. Presenting them under one
 * heading would hide that difference from the model.
 */
const CORE_LABEL = '经验记忆（领域通用，已由多个项目独立印证）：'
const MATCHED_LABEL = '经验记忆（与本轮相关）：'

/** Bounds on the derived retrieval query, so one huge message cannot dominate. */
const QUERY_USER_MESSAGES = 2
const QUERY_MESSAGE_BYTES = 600

/** Records a single `memory_recall` answer may carry. */
const RECALL_MAX = 32

/** The slice of the session this plugin reads. Structural: no import. */
                            
               
                                                          
 

                     
             
                                                                               
 

/** The execution view a tool body receives. */
                    
                   
                      
 

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
 * Derive this turn's retrieval query from the conversation.
 *
 * Messages this plugin contributed are skipped. Without that, the digest
 * injected on turn N is read back as context on turn N+1 and the same few
 * records would keep selecting themselves.
 */
export function recentQueryText(agent                       )         {
  const events = agent?.session?.events
  if (events === undefined) return ''
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
  return parts.join('\n')
}

/** The workspace a turn runs in, defaulting to the process directory. */
function workspaceOf(agent                       , configuredDomain        ) {
  return resolveWorkspace(agent?.session?.header?.cwd, configuredDomain)
}

/** JSON text is the canonical model-facing rendering for every tool here. */
function jsonRender(_args         , value         )                                   {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function apply(ctx         , config                  )       {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  let db              
  try {
    db = openDb(resolved.dbPath)
  } catch (error) {
    throw new Error(
      `experience-memory: cannot open the memory database (${resolved.dbPath ?? 'default'}): `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  ctx.effect(() => () => { db.close() }, 'experience-memory: database')

  // ── Resident layer ────────────────────────────────────────────────────────
  // Evaluated per assembly, not cached: the digest must track the live task.
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: (context                       )         => {
      try {
        const agent = context.agent
        const workspace = workspaceOf(agent, resolved.defaultDomain)
        const now = Date.now()
        const budget = {
          maxRecords: resolved.residentMaxRecords,
          maxBytes: resolved.residentMaxBytes,
        }

        // The query-matched layer. Query-gated by design, so it empties when the
        // turn carries no term to match — which is most short replies.
        const { ranked } = retrieve(db, {
          workspaceId: workspace.id,
          domain: workspace.domain,
          query: recentQueryText(agent),
          now,
          limit: resolved.residentMaxRecords,
          tier: 'resident',
        })

        // The core layer: lessons two independent workspaces reported, injected
        // whether or not this turn mentions them. Sharing one byte budget with
        // the matched layer means the guarantee re-allocates prompt rather than
        // growing it.
        const core = resolved.coreMaxRecords > 0
          ? retrieveCore(db, { domain: workspace.domain, now, limit: resolved.coreMaxRecords }).ranked
          : []

        if (core.length === 0) return renderResident(ranked, budget)

        // A record can be both, and must not be shown twice.
        const coreIds = new Set(core.map(entry => entry.record.id))
        return renderDigest([
          { label: CORE_LABEL, ranked: core },
          { label: MATCHED_LABEL, ranked: ranked.filter(entry => !coreIds.has(entry.record.id)) },
        ], budget)
      } catch {
        // A prompt contributor must never break an assembly; an unavailable
        // digest renders as no digest.
        return ''
      }
    },
  })

  // ── Maintenance ───────────────────────────────────────────────────────────
  // Bounded, resumable, and never on the retrieval path.
  ctx.on('agent/turn-stopping', () => {
    try {
      maintain(db, { now: Date.now(), batchSize: resolved.maintenanceBatchSize })
    } catch {
      // A failed maintenance pass must never break a turn.
    }
  })

  // ── On-demand recall ──────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Search long-term experience memory for lessons and facts relevant to the current work. '
      + 'Returns evidence-graded records with an importance score; the resident digest may already '
      + 'contain the highest-ranked ones, so call this for detail or for a different angle.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to look for, in the words of the current task.' },
      include_retired: { type: 'boolean', description: 'Also return retired records, for auditing.' },
      limit: { type: 'integer', description: 'Maximum records to return (1-32).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          returned: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args         , value         )                                   => [
        { type: 'text', text: (value                    ).text },
      ],
    },
    execute: (args                                                              , exec          ) => {
      const workspace = workspaceOf(exec.agent, resolved.defaultDomain)
      const limit = Math.max(1, Math.min(RECALL_MAX, Math.trunc(args.limit ?? 8)))
      const { ranked } = retrieve(db, {
        workspaceId: workspace.id,
        domain: workspace.domain,
        query: args.query,
        now: Date.now(),
        limit,
        tier: 'recall',
        includeRetired: args.include_retired ?? false,
      })
      const pack = renderRecall(ranked, resolved.recallMaxBytes)
      return {
        returned: pack.returned,
        total: pack.total,
        truncated: pack.truncated,
        text: pack.text === '' ? 'no matching experience' : pack.text,
      }
    },
  }))

  // ── Recording ─────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description:
      'Record a durable fact, experience or strategy for future tasks. Supply `quote` with the exact '
      + 'passage the claim rests on, and `source_ref` naming where it came from: the plugin verifies '
      + 'that passage against this session and the workspace and grades the record accordingly. '
      + 'Without a verifiable passage the record stays a candidate and is never injected automatically. '
      + 'Do not record one-off task detail, transient tool output, secrets, or unverified guesses.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['fact', 'experience', 'strategy'],
        description: 'fact: something true about this project. experience: what happened and what to do differently. '
          + 'strategy: a reusable approach, promoted only after repeated success.',
      },
      title: { type: 'string', required: true, description: 'One line, shown in the resident digest.' },
      body: { type: 'string', required: true, description: 'The atomic claim. One record, one claim.' },
      quote: {
        type: 'string',
        description: 'The verbatim passage from this conversation or from a workspace file that supports the claim.',
      },
      source_ref: {
        type: 'string',
        description: 'Where the passage lives: `path/to/file:line`, or the id of a tool call from this session.',
      },
      trigger: { type: 'string', description: 'When this should come to mind — the words a future task would use.' },
      failure_mode: { type: 'string', description: 'For an experience: what goes wrong without this lesson.' },
      lesson: { type: 'string', description: 'For an experience: the actionable instruction.' },
      scope: {
        type: 'string',
        enum: ['workspace', 'domain'],
        description: 'Defaults to workspace. Domain is for a rule that already holds beyond this project.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: { type: 'string', required: true },
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          evidence: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          corroborations: { type: 'integer', required: true },
        },
      },
      render: jsonRender,
    },
    execute: (args   
                
                   
                  
                    
                         
                      
                           
                     
                   
     , exec          ) => {
      const workspace = workspaceOf(exec.agent, resolved.defaultDomain)
      const result = remember(db, {
        workspaceId: workspace.id,
        domain: workspace.domain,
        scope: args.scope,
        kind: args.kind,
        title: args.title,
        body: args.body,
        trigger: args.trigger,
        failureMode: args.failure_mode,
        lesson: args.lesson,
        sourceRef: args.source_ref,
        quote: args.quote,
        agent: exec.agent,
        now: Date.now(),
      })
      return {
        outcome: result.outcome,
        id: result.record.id,
        status: result.record.status,
        evidence: result.grade,
        reason: result.reason,
        corroborations: result.corroborations,
      }
    },
  }))

  // ── Outcome linkage ───────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_feedback',
    description:
      'Report whether a recalled record actually helped. A success counts toward promotion; two '
      + 'consecutive failures retire the record, because a wrong memory that keeps being recalled is '
      + 'worse than a missing one. Link an outcome only when you can point at what happened.',
    parameters: {
      record_id: { type: 'string', required: true, description: 'The id shown in brackets when the record was recalled.' },
      outcome: { type: 'string', required: true, enum: ['success', 'failure'], description: 'What actually happened.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: { type: 'string', required: true },
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          fail_streak: { type: 'integer', required: true },
        },
      },
      render: jsonRender,
    },
    execute: (args                                                       , exec          ) => {
      const result = recordUsage(db, {
        recordId: args.record_id,
        outcome: args.outcome,
        sessionId: exec.agent?.id,
        now: Date.now(),
        failStreakLimit: resolved.failStreakLimit,
      })
      if (result.record === undefined) {
        throw new Error(`experience-memory: no record with id ${args.record_id}`)
      }
      return {
        outcome: result.outcome,
        id: result.record.id,
        status: result.record.status,
        fail_streak: result.failStreak ?? 0,
      }
    },
  }))

  // ── Forgetting ────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description:
      'Retire a record that is wrong, outdated or no longer useful. Retirement is reversible and '
      + 'stops the record from being recalled or injected. Pass purge=true only when the content '
      + 'itself must not remain on disk.',
    parameters: {
      record_id: { type: 'string', required: true, description: 'The record to retire.' },
      reason: { type: 'string', required: true, description: 'Why it is being retired. Kept in the audit log.' },
      purge: { type: 'boolean', description: 'Delete the content as well as retiring it. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: { type: 'string', required: true },
          id: { type: 'string', required: true },
        },
      },
      render: jsonRender,
    },
    execute: (args                                                        ) => {
      const outcome = forget(db, {
        recordId: args.record_id,
        reason: args.reason,
        actor: 'agent',
        purge: args.purge ?? false,
        now: Date.now(),
      })
      if (outcome === 'missing') {
        throw new Error(`experience-memory: no record with id ${args.record_id}`)
      }
      return { outcome, id: args.record_id }
    },
  }))
}
