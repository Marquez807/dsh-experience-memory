/**
 * experience-memory — domain-scoped long-term experience for DeepSeek Harness.
 *
 * The plugin contributes four surfaces:
 *
 * 1. Prompt contributions through `ctx.systemPrompt.context`, re-evaluated at every
 *    assembly so they track the current task rather than a boot-time snapshot: the
 *    resident digest, and a standing one-line reminder to record what is durable.
 * 2. Model-facing tools: recall, remember, feedback, forget, stats.
 * 3. A bounded maintenance pass at `agent/turn-stopping`, which is where decay
 *    and retirement run — never on the retrieval path.
 * 4. Operator commands (`ctx.commands.register`): status, preview, maintain,
 *    audit, import. These are for the person, not the model — audit and import
 *    reach outside the store, so they stay behind a human trigger and the model's
 *    tool surface stays small.
 *
 * The tool and command *counts* deliberately live in the README and the test suite
 * rather than here: a number written into a comment cannot be checked, and this
 * file previously declared the tool surface to be four in one paragraph while
 * listing five tools in the paragraph above it.
 *
 * The plugin deliberately has no `agent/pre-step` injection: writing synthetic
 * user messages into the session would put memory text into the transcript,
 * where the next turn's own retrieval query would read it back and reinforce
 * it. That feedback loop is what turned Mem0's production store into 97.8%
 * noise. The query builder in `./digest.ts` excludes plugin-sourced messages for
 * the same reason.
 */
                                                  
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
                                               
import { tmpdir } from 'node:os'
import { Config, resolveConfig,                                 } from './config.js'
import { buildIdentity } from './build-id.js'
import { suggestAnchors } from './anchors.js'
import { explainRefusals, guardAnchors } from './anchor-cost.js'
import { configureEffect } from './effect.js'
import { guardHintFor } from './guard-hints.js'
import { commandDefinitions } from './commands.js'
import { openDb, noteRetrieval, countCandidates, noteDelivery, defaultDbPath } from './db.js'
import { gapCandidateText, gapCandidateTitle, gapCandidates, gapReport, noteFailures } from './failure.js'
import { harvestFrom, lastTurn } from './harvest.js'
import { recallForCallWithIdentifiers, renderPrecall } from './precall.js'
import { eventsOf, memoryDisabled } from './session.js'
import { buildDigest, recentQueryText, workspaceOf, RECORD_HINT,                } from './digest.js'
import { census, renderCensus } from './census.js'
import { forget, maintain, recordUsage, remember, harvest } from './lifecycle.js'
import { renderRecall } from './inject.js'
import { retrieve } from './retrieve.js'
                                             

export const name = 'experience-memory'

/**
 * Every service the plugin's surfaces need must be present, or it does not
 * activate at all. `commands` comes from `dsh-base` — the same bundle that
 * provides `tools` and `systemPrompt` — so requiring it adds no constraint a
 * profile did not already carry.
 */
export const inject = ['tools', 'systemPrompt', 'commands']

export { Config }
                                

/** The context name shown in prompt diagnostics. */
const CONTEXT_NAME = 'experience-memory:resident'
/** The standing record hint, registered separately so it survives an empty store. */
const HINT_CONTEXT_NAME = 'experience-memory:record-hint'

/**
 * Sections render in ascending order: `-100` harness identity, `0` persona,
 * `100`–`199` tool guidance. Experience sits at the end of the guidance band so
 * it reads immediately before the conversation.
 */
const CONTEXT_ORDER = 150

/** Records a single `memory_recall` answer may carry. */
const RECALL_MAX = 32
/**
 * The bar for turning a repeated failure into candidate material, and the per-turn cap.
 *
 * Three, not two: `/memory-gaps` reports from two because a reader can judge a two-off, while
 * a row written into the store unprompted has to earn its place in a pool someone will read.
 * The cap is two per turn so one bad turn cannot flood it — the counts only grow, so a shape
 * that matters is still there next turn.
 */
const GAP_CANDIDATE_MIN_COUNT = 3
const GAP_CANDIDATE_MAX_PER_TURN = 2

/** The execution view a tool body receives. */
                    
                   
                      
                                                                                    
                 
 

/**
 * A read-only observer names its own call, so the caller can cite it.
 *
 * `route: tool-call` was reachable only through a failure: the grade matches a tool
 * result's `callId`, a model never sees that id as text, and the one place it was ever
 * printed was the reason of a *failing* record. So "record what the tool just told me"
 * cost a wasted attempt whose only purpose was to discover the id. Printing it in the
 * observer's own answer removes that attempt.
 *
 * Only the read-only observers carry it. A call that merely writes the framework's own
 * bookkeeping is not evidence about the workspace, and `source_ref` exists for facts a
 * later session can re-check.
 */
function callIdLine(exec          )         {
  return typeof exec.callId === 'string' && exec.callId !== ''
    ? `\n本调用 id ${exec.callId}（把它填进 source_ref 即可判 verified-tool）`
    : ''
}

/** What a tool execution hands the `tools/execute` waterfall. */
                             
                   
                     
                                                                                         
               
               
                                                                 
                                           
 

/**
 * Just-in-time recall, attached to the tool call it is about.
 *
 * Runs on the `tools/execute` waterfall, which wraps the tool body and hands out an execution
 * carrying `deferContext`. Whatever it defers is ferried into the turn as a plugin-sourced
 * message, so the agent reads it immediately after the result — at the moment it is about to
 * act, rather than whenever the resident digest next happens to carry it. A lesson about
 * launching a game is worth nothing on the turn before the launch.
 *
 * Two rules are absolute, and both are about not making things worse:
 *
 *   - **`next()` is always called, by the caller, whatever happens here.** This waterfall runs
 *     outermost-first and a listener that never calls `next()` vetoes everything after it,
 *     including the tool itself. A recall hint must never be able to stop a tool call.
 *   - **Nothing escapes.** A throw here would surface as an `isError` result on a call that was
 *     otherwise fine. The only acceptable consequence of a failure is that this turn got no
 *     hint.
 */
function attachPrecall(
  db              ,
  exec                   ,
  config                ,
  sent                     ,
  budget                                      ,
  report                                        ,
)       {
  try {
    if (typeof exec.deferContext !== 'function') return
    if (memoryDisabled(exec.agent, config.disabledPresets)) return
    const workspace = workspaceOf(exec.agent, config.defaultDomain)
    const now = Date.now()
    const recall = recallForCallWithIdentifiers(db, workspace.id, workspace.domain, exec.arguments, now, {
      // The tool name is part of what the call is, and `tool:` anchors are matched against it.
      tool: exec.name ?? exec.tool,
    })
    if (recall === undefined) return
    const record = recall.record

    // A cooldown per record, and a hard session ceiling counted in hints actually delivered.
    // A hint on every matching call would be noise the agent learns to skip, which is worse
    // than never sending it — but the throttle is the *cooldown*, not a per-turn limit: a
    // per-turn limit was measured against the real session this feature exists for, and it
    // handed the turn's slot to whatever else matched first, so the lesson about launching
    // the game never went out at all.
    const last = sent.get(record.id)
    if (last !== undefined && now - last < config.precallCooldownMinutes * 60_000) return
    if (budget.session >= config.precallMaxPerSession) return
    sent.set(record.id, now)
    budget.session += 1

    // Written only now that the hint is really going out. This is the one place in the whole
    // framework that answers "did this lesson ever reach the agent" — before it existed, a
    // ledger could see that a lesson was written and could not see whether anyone was shown it.
    noteDelivery(db, {
      recordId: record.id,
      // Both spellings, because a real execution and a hand-built one do not carry the same
      // one: the session id belongs to the session, and `AgentLike.id` is what the waterfall
      // actually hands over. Neither is invented — a delivery with no session keeps the gap.
      sessionId: exec.agent?.session?.header?.id ?? exec.agent?.id,
      tool: exec.name ?? exec.tool,
      matched: recall.matched,
      reason: 'identifier',
      at: now,
    })

    exec.deferContext(createUserMessage({
      content: [{ type: 'text', text: renderPrecall(record) }],
      source: { kind: 'plugin', plugin: 'experience-memory' },
    }))
  } catch (error) {
    // Visible in the log, and never fatal to the call it was riding on.
    report('just-in-time recall', error)
  }
}

/**
 * Harvest raw material from the turn that just ended.
 *
 * Reads the newest turn only — `lastTurn` finds the last `turn/start` — because a session
 * log in this workspace reaches 40 MB and 12,000 events, and a harvester that rescanned it
 * every turn would be a cost with no matching benefit: the material worth keeping is by
 * definition the material the model just handled.
 *
 * At most one candidate comes out, and the detector chooses it: a repaired failure beats a
 * correction, which beats a statement. One turn is one moment; filing several would be
 * filing the same thing several ways.
 */
function harvestTurn(
  db              ,
  agent                       ,
  config                ,
  now        ,
)       {
  const workspace = workspaceOf(agent, config.defaultDomain)
  const candidate = harvestFrom(lastTurn(eventsOf(agent)), { broad: config.harvestBroad })
  if (candidate === undefined) return
  harvest(db, { workspaceId: workspace.id, domain: workspace.domain, candidate, now })
}

// The session shapes, the query builder and the digest itself live in
// `./digest.ts`, because `/memory-preview` must compute the digest exactly the way
// `apply()` does — a preview that disagreed with what is actually sent would
// defeat the only reason it exists. Re-exported here so the plugin entry stays the
// single import surface that callers and tests already use.
export { recentQueryText }

/** JSON text is the canonical model-facing rendering for every tool here. */
function jsonRender(_args         , value         )                                   {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function apply(ctx         , config                  )       {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  // The deletion-effect vocabulary is configured once, here, from resolved config: its two consumers
  // (`rank.ts` scoring, `lifecycle.ts` retirement) are called from a dozen places that have no
  // business knowing about configuration. Both switches default to off, so this call is a no-op on
  // a default store — see `src/effect.ts` for why they ship off.
  configureEffect({
    weight: resolved.effectWeight,
    decisionLossRetirement: resolved.decisionLossRetirement,
  })

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

  // Record which build this process loaded, once, so a caller can tell "the fix is on
  // disk" apart from "the restart picked it up" — see `build-id.ts` for why the running
  // process has to be the one to say it.
  const build = buildIdentity()
  ctx.logger?.info(`experience-memory: build ${build.id} (${build.modules} modules)`)

  // ── Failure reporting ─────────────────────────────────────────────────────
  // A prompt contributor must never break an assembly, so a failing digest renders
  // as no digest. Silence, though, is how a broken memory becomes indistinguishable
  // from an empty one — so it is reported, throttled per distinct message because
  // this runs on every assembly.
  const WARN_INTERVAL_MS = 60_000
  let lastWarning = { at: 0, message: '' }
  const report = (what        , error         )       => {
    const message = error instanceof Error ? error.message : String(error)
    const now = Date.now()
    if (message === lastWarning.message && now - lastWarning.at < WARN_INTERVAL_MS) return
    lastWarning = { at: now, message }
    ctx.logger?.warn(`experience-memory: ${what} failed — ${message}`)
  }

  // ── Which store this process opened, said out loud ────────────────────────
  // An empty store and a *wrong* store look identical from the outside: both answer every query
  // with nothing. That cost real data once — a maintenance script resolved `DSH_HOME` to the live
  // directory and cleared 271 records, and nothing in the plugin's own output would have said
  // which file it was holding. Two lines at activation make the path and the count visible, so a
  // store that is unexpectedly empty reads as a fact rather than as lost memory.
  try {
    const where = resolved.dbPath ?? 'default'
    const total = db.prepare('SELECT COUNT(*) AS n FROM record').get()                 
    const confirmed = db.prepare("SELECT COUNT(*) AS n FROM record WHERE status = 'confirmed'").get()                 
    const anchored = db.prepare("SELECT COUNT(*) AS n FROM record WHERE status = 'confirmed' AND trigger LIKE '%--- anchors ---%'").get()                 
    ctx.logger?.info(
      `experience-memory: store ${where} — ${Number(total.n)} records, `
      + `${Number(confirmed.n)} confirmed, ${Number(anchored.n)} anchored`,
    )
  } catch (error) {
    report('store summary', error)
  }

  // ── Resident layer ────────────────────────────────────────────────────────
  // Evaluated per assembly, not cached: the digest must track the live task.
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: (context                       )         => {
      try {
        // A mode listed in `disabledPresets` gets nothing: no digest, and (below) no record
        // hint either. Both halves matter — the hint is what tells a mode that recording
        // exists, and a model-test mode should not be told.
        if (memoryDisabled(context.agent, resolved.disabledPresets)) return ''
        return buildDigest({
          db,
          config: resolved,
          workspace: workspaceOf(context.agent, resolved.defaultDomain),
          query: recentQueryText(context.agent),
          now: Date.now(),
        })
      } catch (error) {
        report('resident digest', error)
        return ''
      }
    },
  })

  // ── Standing instruction ──────────────────────────────────────────────────
  // Deliberately separate from the digest above, and deliberately unconditional for every mode
  // that has memory: the digest is empty whenever no record is eligible, and that is the state
  // in which the model most needs to be told that recording exists. See RECORD_HINT for the
  // measurement behind this. A disabled mode is the one exception, and it is checked per
  // assembly for the same reason the digest is: the mode can change inside one process.
  ctx.systemPrompt.context({
    name: HINT_CONTEXT_NAME,
    order: CONTEXT_ORDER + 1,
    text: (context                       )         =>
      memoryDisabled(context.agent, resolved.disabledPresets) ? '' : RECORD_HINT,
  })

  // ── Maintenance, harvest, and what keeps failing ──────────────────────────
  // Bounded, resumable, and never on the retrieval path.
  ctx.on('agent/turn-stopping', (payload                                   ) => {
    const now = Date.now()
    try {
      maintain(db, {
        now,
        batchSize: resolved.maintenanceBatchSize,
        candidateTtlDays: resolved.harvestCandidateTtlDays,
        candidatePoolLimit: resolved.harvestPoolLimit,
        // The provenance step needs the workspace root to resolve a record's relative
        // `source_ref`. Deliberately no fallback: a wrong root would flag every record whose
        // evidence file lives elsewhere, which is a worse silence than skipping the check.
        workspaceRoot: payload?.agent?.session?.header?.cwd,
      })
    } catch (error) {
      // A failed maintenance pass must never break a turn — but it must be
      // visible, or a store that quietly stopped aging out looks healthy.
      report('maintenance pass', error)
    }
    // Harvesting runs after maintenance, so a candidate written now is aged by the next
    // pass rather than in the same breath. A mode with memory disabled is skipped here — that
    // is the *recording* half of "no memory", and it is what keeps a test session's turns out
    // of the store. Maintenance itself still runs: it is store hygiene that no session sees,
    // and skipping it would mean a memory-free mode silently stops aging out everyone's store.
    const disabled = memoryDisabled(payload?.agent, resolved.disabledPresets)
    if (!disabled && resolved.harvestEnabled && resolved.harvestMaxPerTurn > 0) {
      try {
        harvestTurn(db, payload?.agent, resolved, now)
      } catch (error) {
        // Same rule as maintenance: a failed harvest must not fail a turn, and staying
        // silent would make a harvester that stopped working look like a quiet session.
        report('turn harvest', error)
      }
    }
    // Counting the turn's failures runs here because this is the only place the plugin
    // already holds the turn's events for free. The count itself writes no lesson and injects
    // nothing — see `failure.ts` for why the count and the lesson are deliberately kept apart.
    //
    // The gap pass below is the one thing that does act on the count, and it is the answer to
    // a measured complaint: the store's most frequent failure (`edit` before `read`) had
    // happened 140 times across 8 sessions with **no record about it at all**, and the only
    // way that was ever noticed was a person running `tools/prevention-ledger.mjs` and then
    // asking for a record to be written. It runs only on a turn that actually failed, so a
    // clean turn costs one integer comparison.
    if (!disabled) {
      try {
        const workspace = workspaceOf(payload?.agent, resolved.defaultDomain)
        const failures = noteFailures(db, payload?.agent, workspace.id, payload?.agent?.id ?? '', now, {
          enabled: resolved.failureTracking,
          shapeLimit: resolved.failureShapeLimit,
        })
        if (failures > 0 && resolved.failureTracking) {
          const rows = gapReport(db, {
            workspaceId: workspace.id,
            domain: workspace.domain,
            now,
            limit: resolved.failureShapeLimit,
            minCount: GAP_CANDIDATE_MIN_COUNT,
          })
          for (const candidate of gapCandidates(rows, { minCount: GAP_CANDIDATE_MIN_COUNT, max: GAP_CANDIDATE_MAX_PER_TURN })) {
            harvest(db, {
              workspaceId: workspace.id,
              domain: workspace.domain,
              now,
              candidate: {
                text: gapCandidateText(candidate),
                signal: 'recurring-failure',
                title: gapCandidateTitle(candidate),
              },
            })
          }
        }
      } catch (error) {
        report('failure shape count', error)
      }
    }
  })

  // ── Just-in-time recall ───────────────────────────────────────────────────
  // Attached to the tool call it is about, on the waterfall that wraps the tool body. The
  // listener always calls `next()`: in this waterfall a listener that does not is a veto,
  // and a recall hint must never be able to stop a tool call.
  const hinted = new Map                ()
  const hintBudget = { session: 0 }
  if (resolved.precallEnabled) {
    ctx.on('tools/execute', (exec                   , next               ) => {
      attachPrecall(db, exec, resolved, hinted, hintBudget, report)
      return next()
    })
  }

  // ── On-demand recall ──────────────────────────────────────────────────────
  /**
   * Refuse to act, loudly, in a mode that has memory switched off.
   *
   * The preset's own tool filter removes these tools from the catalogue, so this should never
   * fire — which is exactly why it exists. If the filter is ever missing or ineffective, the
   * alternative is a model-test session quietly reading and writing the shared store, and the
   * operator would have no way to tell. A refusal with the remedy in the message is the honest
   * failure. Thrown rather than returned because every tool here has its own required output
   * shape, and an error result carries the same sentence through all five.
   */
  const refuseWhenDisabled = (exec          )       => {
    if (!memoryDisabled(exec.agent, resolved.disabledPresets)) return
    throw new TypeError(
      'experience-memory: this agent preset is listed in `disabledPresets`, so this mode has no '
      + 'memory — nothing is recalled, nothing is recorded, and nothing is injected. Remove the '
      + 'preset id from that list to use memory here.',
    )
  }

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Call this before starting work in an unfamiliar area, before repeating a decision '
      + 'that may already have been made, or whenever a previous convention might apply. '
      + 'Search long-term experience memory for lessons and facts relevant to the current work. '
      + 'Returns evidence-graded records with an importance score; the one-line resident digest may '
      + 'already contain the highest-ranked ones, so call this when you need detail, a different '
      + 'angle, or to check whether anything was ever recorded about this subject.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to look for, in the words of the current task.' },
      include_retired: { type: 'boolean', description: 'Also return retired records, for auditing.' },
      include_candidates: {
        type: 'boolean',
        description: 'Also return candidates — claims recorded without a verifiable passage. '
          + 'Use this to review what you recorded but never verified, and either re-record it with '
          + 'evidence or forget it. Candidates are never injected into the prompt, so this is the only '
          + 'way to see them again.',
      },
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
    execute: (args   
                   
                               
                                  
                    
     , exec          ) => {
      refuseWhenDisabled(exec)
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
        includeCandidates: args.include_candidates ?? false,
      })
      const pack = renderRecall(ranked, resolved.recallMaxBytes)
      // Count only what was actually handed over: `renderRecall` stops at the byte
      // budget, so the tail of `ranked` never reached the caller and must not be
      // recorded as having been looked at.
      noteRetrieval(db, ranked.slice(0, pack.returned).map(entry => entry.record.id), Date.now())
      // A harvester that fills a pool nobody looks at is just a store-filling machine. This
      // line appears exactly when the model is already thinking about memory, which is the
      // one moment it can act on it — and it costs nothing on turns that never recall.
      const pending = args.include_candidates === true ? 0 : countCandidates(db, 'harvest')
      const footer = pending === 0
        ? ''
        : `\n另有 ${pending} 条自动采集的候选待确认（include_candidates: true 可看；`
          + '有用的用 memory_remember 复述一遍即可转正，没用的不必管，14 天后自动退役）'
      return {
        returned: pack.returned,
        total: pack.total,
        truncated: pack.truncated,
        text: (pack.text === '' ? 'no matching experience' : pack.text) + footer + callIdLine(exec),
      }
    },
  }))

  // ── Store census ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description:
      'Report what the experience memory currently holds: how many records exist, how many are '
      + 'eligible for the always-on digest, what has been reused, and what was retired and why. '
      + 'Read-only. Use it to answer questions about your own memory, or to check whether something '
      + 'you recorded is actually reaching you.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          records: { type: 'integer', required: true },
          confirmed: { type: 'integer', required: true },
          candidates: { type: 'integer', required: true },
          retired: { type: 'integer', required: true },
          resident_eligible: { type: 'integer', required: true },
          usage_total: { type: 'integer', required: true },
          corrections: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args         , value         )                                   => [
        { type: 'text', text: (value                    ).text },
      ],
    },
    // No arguments and no writes: a census the model can ask for while reasoning,
    // without the schema cost of options it would rarely use.
    execute: (_args                       , exec          ) => {
      refuseWhenDisabled(exec)
      const result = census(db, { now: Date.now() })
      return {
        records: result.records,
        confirmed: result.byStatus['confirmed'] ?? 0,
        candidates: result.byStatus['candidate'] ?? 0,
        retired: result.byStatus['retired'] ?? 0,
        resident_eligible: result.residentEligible,
        usage_total: result.usage.total,
        corrections: result.corrections,
        // The build id leads, because "which build is this" is the question a caller
        // cannot answer any other way: the version never changes, and a plugin's own
        // logger output does NOT reach `harness.log` — that file carries the process's
        // stdout/stderr only, which was verified after claiming otherwise. The operator
        // half of this line is `/memory-status`; this is the half a model-side caller
        // can actually read, in whatever session it happens to be running.
        text: `插件构建 ${build.id}（${build.modules} 个模块）\n`
          + renderCensus(result, { dbPath: resolved.dbPath })
          + callIdLine(exec),
      }
    },
  }))

  // ── Recording ─────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description:
      'Call this the moment you learn something that will still matter in a later session: a project '
      + 'convention, a boundary or invariant, a command that works, or a lesson from a mistake. '
      + 'Supply `quote` with the exact passage the claim rests on — and make sure that passage **says '
      + 'the thing you are claiming**, because a later reader checks exactly that and throws the record '
      + 'away when it does not (see the `quote` parameter). `source_ref` names where it came from: the '
      + 'plugin verifies the passage against this session and the workspace and grades the record '
      + 'accordingly, accepting a verbatim user assertion, a file in the workspace, or a tool call that '
      + 'succeeded. Without a verifiable passage the record stays a candidate and is never injected '
      + 'automatically. Record the durable rule, not the errand: do not record one-off task detail, '
      + 'transient tool output, secrets, or unverified guesses.',
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
        description: 'The verbatim passage the claim rests on — and it has to **state the rule itself**, '
          + 'not merely come from the same file. A real model reading a record back checks exactly this: '
          + 'given a claim about a deployment vault and a quote that only says how to start the server '
          + 'locally, it answers "the cited evidence does not match the claim" and discards the record. '
          + 'So quote the sentence that says the thing (a rule, an order, a value, an error message), not '
          + 'the paragraph you happened to be reading. If no passage states it, the claim is not yet ready '
          + 'to record: write the `inferred` version and say what is missing.',
      },
      source_ref: {
        type: 'string',
        description: 'Where the passage lives: `path/file:line` when the claim rests on a file, or the '
          + 'id of a tool call that SUCCEEDED when the claim is that a command works. A lesson learned '
          + 'from a failure cannot cite the failed call — a failed call proves nothing here — so cite '
          + 'the file that records the finding instead.',
      },
      trigger: { type: 'string', description: 'When this should come to mind — the words a future task would use.' },
      recall_for: {
        type: 'array',
        items: { type: 'string' },
        description: 'The calls this lesson must interrupt, as facts a tool call either has or does not have: '
          + '`path:<file name>` (the call names that file), `tool:<name>` (the call is that tool), '
          + '`command:<token>` (the command line contains it). A bare file name counts as `path:`. '
          + 'This is what the just-before-acting hint fires on — **without it the lesson is never shown at '
          + 'the moment of action**, only in the every-turn digest and when something searches for it. '
          + 'Give one or two, and prefer the exact file or command the mistake happened in.',
      },
      failure_mode: { type: 'string', description: 'For an experience: what goes wrong without this lesson.' },
      lesson: { type: 'string', description: 'For an experience: the actionable instruction.' },
      scope: {
        type: 'string',
        enum: ['workspace', 'domain'],
        description: 'Defaults to workspace. Domain is for a rule that already holds beyond this project.',
      },
      expires_in_days: {
        type: 'integer',
        description: 'For a fact about a moving world: stop using this after N days. '
          + 'Set it whenever the claim could quietly become false — a version baseline, a command, a path.',
      },
      review_after_days: {
        type: 'integer',
        description: 'Re-verify this after N days if nothing has reused it. Maintenance retires it if it is '
          + 'still unreused 30 days past that date.',
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
          route: {
            type: 'string',
            required: true,
            description: 'Which route verified it: tool-call, file, user-message, or none. '
              + 'With `evidence: inferred` this says what to fix, and `reason` names what was tried.',
          },
          reason: { type: 'string', required: true },
          corroborations: { type: 'integer', required: true },
          revived: {
            type: 'boolean',
            required: true,
            description: 'True when this report brought a retired record back into the live pool. '
              + 'When `outcome` is `still-retired` it is false and the record stays out of every '
              + 'injection and recall — re-reporting content that was retired does not by itself restore it.',
          },
          recall_for_suggestions: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Anchors this turn suggests, read from the calls it just made (`path:`/`tool:`/'
              + '`command:`). They are **proposals, not declarations**: pass the ones that are right back '
              + 'in `recall_for` to make them stick. Without a declared anchor a record is never shown '
              + 'just before a call — it stays in the digest and in `memory_recall` only.',
          },
          anchors_refused: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Declared anchors that were dropped, one line each, with the measurement that '
              + 'dropped them. An anchor that matches a large share of all calls would make this one '
              + 'record own the hint budget of the whole workspace, so it is not stored — the record '
              + 'itself is, and it still reaches the digest and `memory_recall`.',
          },
          danger_examples: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'For a record about an action that cannot be undone: one computed line naming '
              + 'the live store\'s path and the disposable root, so the rule can be written as "refuse by '
              + 'default, and never touch this file" instead of a marker list that the real store\'s own '
              + 'path may satisfy. **Proposed, never written** — the record is stored exactly as given. '
              + 'Empty when the record is not about a destructive action, or already names those facts.',
          },
        },
      },
      render: jsonRender,
    },
    execute: (args   
                
                   
                  
                    
                         
                      
                           
                           
                     
                   
                              
                                
     , exec          ) => {
      refuseWhenDisabled(exec)
      const workspace = workspaceOf(exec.agent, resolved.defaultDomain)
      const now = Date.now()
      // Days are the model-facing unit because they are what a claim about the
      // world is actually stated in; the record stores absolute times, which is
      // what retrieval and maintenance can compare without re-deriving anything.
      const window = (days                    , name        )                     => {
        if (days === undefined) return undefined
        if (!Number.isSafeInteger(days) || days < 1) {
          throw new TypeError(`experience-memory: ${name} must be a whole number of days >= 1, got ${String(days)}`)
        }
        return now + days * 86_400_000
      }
      // A declared anchor decides how often this record interrupts, so it is checked against what
      // it would cost before it is stored. Two sessions learned this the expensive way in one night
      // (`docs/DELIVERY-GAPS.md` §25): `path:node_modules` matched 702 of 15,896 calls and
      // `tool:pwsh` matched 5,936, and the latter record owned 94.8% of every hint delivered. The
      // record is still written — it reaches the digest and `memory_recall` — only the anchor goes.
      const guard = guardAnchors(args.recall_for ?? [], {
        enabled: resolved.anchorCostTable,
        maxHits: resolved.anchorCostMaxHits,
      })
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
        recallFor: guard.kept,
        expiresAt: window(args.expires_in_days, 'expires_in_days'),
        reviewAfter: window(args.review_after_days, 'review_after_days'),
        agent: exec.agent,
        now,
      })
      // Proposed, never written: see `suggestAnchors` for the measured basis (a record's cited
      // file appears in the turn's calls 67.3% of the time at ±8 calls, 90.6% at ±24, with a
      // random control at 0%). The caller confirms, because a wrong anchor fires a lesson at the
      // wrong moment and 67–90% is a suggestion rather than a fact. Proposals run through the same
      // cost check, so nothing this tool suggests can be an anchor it would then refuse.
      const suggestions = suggestAnchors({ events: eventsOf(exec.agent), sourceRef: args.source_ref })
      const proposed = guardAnchors(suggestions.map(item => item.anchor), {
        enabled: resolved.anchorCostTable,
        maxHits: resolved.anchorCostMaxHits,
      })
      const refused = explainRefusals(guard)
      // The environment's own facts, offered when the record describes something that cannot be
      // undone. The plugin knows where the live store is and where throwaway stores may live; asking
      // the writer to type those is how a safety lesson ends up phrased as a guessable marker list
      // (`docs/DELIVERY-GAPS.md` §27). Proposed only — the record is stored exactly as written.
      const guardHint = resolved.guardHints
        ? guardHintFor({
          text: [args.title, args.body, args.lesson, args.failure_mode].filter(part => typeof part === 'string').join('\n'),
          facts: { realStorePath: resolved.dbPath ?? defaultDbPath(), disposableRoot: tmpdir() },
        })
        : undefined
      const dangerExamples = guardHint !== undefined && !guardHint.covered ? [guardHint.line] : []
      const notes = [
        ...refused,
        ...(dangerExamples.length === 0 ? [] : ['this record describes a destructive action — see danger_examples']),
      ]
      return {
        outcome: result.outcome,
        id: result.record.id,
        status: result.record.status,
        evidence: result.grade,
        route: result.route,
        reason: notes.length === 0 ? result.reason : `${result.reason}（${notes.join('；')}）`,
        corroborations: result.corroborations,
        revived: result.revived,
        recall_for_suggestions: proposed.kept,
        anchors_refused: refused,
        danger_examples: dangerExamples,
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
      refuseWhenDisabled(exec)
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
    execute: (args                                                        , exec          ) => {
      refuseWhenDisabled(exec)
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

  // ── Operator commands ─────────────────────────────────────────────────────
  // Registered through the same service the in-box commands use, so they appear
  // wherever `/compact` and `/goal` do. They are for the person: audit and import
  // reach outside the store, and keeping them out of the tool surface also keeps
  // the model's per-turn schema cost from growing.
  for (const definition of commandDefinitions({ db, config: resolved, build })) {
    ctx.commands.register(definition)
  }
}
