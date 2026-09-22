/**
 * Just-in-time recall regressions.
 *
 * The resident digest competes for five slots and is gated on the turn's query, so a lesson
 * can lose exactly when it matters. The case that produced this suite: a record saying
 * "confirm Steam is logged in before launching Bannerlord" was injected on nine of a
 * session's fifteen turns and absent on the turn the work started, because the user had
 * typed "开始吧". The agent launched without Steam and the run was wasted.
 *
 * So these tests do not call the matcher directly — they drive a **real tool call through
 * the tool runtime** and look at what came back attached to it. Calling the helper would
 * only prove the helper works; the question is whether the plugin is wired to the waterfall
 * the runtime actually runs, and only driving it answers that.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import Commands from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_RUNTIME_SCHEDULER, defineTool } from '@deepseek-ai/dsh-tools'
import * as experienceMemory from '../src/index.ts'
import { deliveriesAtOrBefore, openDb } from '../src/db.ts'
import { resolveWorkspace } from '../src/domain.ts'
import { recallForCall } from '../src/precall.ts'
import { callFacts } from '../src/anchors.ts'
import { assert, eq } from './assert.ts'
import type { DatabaseSync } from 'node:sqlite'

/** What the plugin reads off an agent. Declared here so the fixture is typed, not cast. */
interface AgentLike {
  id: string
  session: { header: { cwd: string }; snapshotEvents: () => readonly unknown[] }
}

/** A tool that does nothing, so the only interesting thing in the result is what rode along. */
const probeTool = defineTool({
  name: 'probe_run',
  description: 'run a command; used by the suite to observe just-in-time recall',
  parameters: { command: { type: 'string', required: true } },
  output: {
    schema: {
      type: 'object', additionalProperties: false,
      properties: { text: { type: 'string', required: true } },
    },
    render: (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [
      { type: 'text', text: (value as { text: string }).text },
    ],
  },
  execute: (args: { command: string }) => ({ text: `ran: ${args.command}` }),
})

/** What a real execution carries back: the contexts the plugin deferred onto it. */
interface Dispatched {
  content?: unknown
  isError?: boolean
  additionalContexts?: { content?: { text?: string }[] }[]
}

export async function run(): Promise<void> {
  // ── What a call is *about*, as the anchor matcher reads it ────────────────
  // The retired identifier extractor has its own suite (`anchors.test.ts`); what matters here
  // is the end of the chain — a call the record declared, and a call it did not.
  const facts = callFacts('probe_run', { command: 'pwsh -File .\\launch-a-runtime-clean.ps1 -ResetSafeExit' })
  assert(facts.paths.some(path => path.includes('launch-a-runtime-clean.ps1')),
    `the script the call runs is a path fact: ${facts.paths.join(', ')}`)
  eq(callFacts('probe_run', { query: '部署' }).paths, [],
    'a call whose arguments are prose offers no path facts')
  eq(callFacts('probe_run', { file_path: 'x', old_string: 'y', new_string: 'z' }).paths, [],
    'and short single letters are not file names either')

  const dir = mkdtempSync(join(tmpdir(), 'expmem-precall-'))
  const dbPath = join(dir, 'memory.db')
  const ctx = new Context()
  // The lesson has to be a real record, and a record is confirmed by evidence. Here the
  // evidence is the user having said the sentence, which is the strongest grade there is.
  const quote = '无人值守启动前要确认 Steam 已登录，否则游戏会静默退出'
  const agent: AgentLike = {
    id: 'session-precall',
    session: {
      header: { cwd: dir },
      snapshotEvents: () => [{
        type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: quote }] },
      }],
    },
  }
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(Commands, {})
    await ctx.plugin(experienceMemory, { enabled: true, dbPath })
    ctx.tools.register({
      ...probeTool,
      // Registered after the plugin so the waterfall has both ends wired.
    })

    const call = async (name: string, args: unknown) =>
      await ctx.tools.get(name)!.execute(args, { signal: new AbortController().signal, agent })

    // One confirmed record that names the script, written the ordinary way. It declares where
    // it applies — `recall_for` — because that declaration, not a shared word, is what decides
    // whether a hint goes out; see `criteria.ts` for the measurement that retired the old rule.
    const remembered = await call('memory_remember', {
      kind: 'experience',
      title: '启动游戏前必须确认 Steam 已登录',
      body: '无人值守启动前要确认 Steam 已登录，否则游戏约 10 秒后静默退出（launch-a-runtime-clean.ps1 里有这道检查）。',
      quote,
      recall_for: ['command:launch-a-runtime-clean.ps1'],
    }) as { id: string; status: string }
    eq(remembered.status, 'confirmed', 'the lesson is a real record, not a candidate')
    // A second, unrelated lesson, so the per-turn ceiling can be told apart from "nothing else
    // matched": two records, two anchors, one turn.
    const other = await call('memory_remember', {
      kind: 'experience',
      title: '还原存档要认准备份文件',
      body: '还原存档前先确认备份文件是 restore-save-backup.ps1 生成的那一份，否则会覆盖掉好档。',
      quote,
      recall_for: ['command:restore-save-backup.ps1'],
    }) as { id: string; status: string }
    eq(other.status, 'confirmed', 'and a second record, with an anchor of its own')

    // ── The call that is about to launch the game ──────────────────────────
    // Driven exactly the way `dsh-agent-loop` drives it — prepare, dispatch, finalize —
    // because the question is whether the plugin is attached to the waterfall the runtime
    // really runs, and calling the matcher directly would not answer that.
    interface Stage {
      prepare: (exec: unknown) => Promise<{ kind: string; exec: unknown; result?: Dispatched }>
      dispatch: (exec: unknown) => Promise<{ kind: string; result: Dispatched }>
      finalize: (exec: unknown, result: Dispatched) => Promise<Dispatched>
      finish: (exec: unknown, result: Dispatched) => Dispatched
    }
    const scheduler = (ctx.tools as unknown as Record<symbol, Stage>)[TOOL_RUNTIME_SCHEDULER]
    const runTool = async (exec: {
      name: string; arguments: unknown; callId: string
    }, on = agent): Promise<Dispatched> => {
      const prepared = await scheduler.prepare({
        ...exec, agent: on, signal: new AbortController().signal,
      })
      if (prepared.kind === 'dispatch') {
        const dispatched = await scheduler.dispatch(prepared.exec)
        return dispatched.kind === 'post-result'
          ? await scheduler.finalize(prepared.exec, dispatched.result)
          : scheduler.finish(prepared.exec, dispatched.result)
      }
      if (prepared.kind === 'post-result') {
        return await scheduler.finalize(prepared.exec, prepared.result as Dispatched)
      }
      return scheduler.finish(prepared.exec, prepared.result as Dispatched)
    }
    const attachedTo = (result: Dispatched): string => (result.additionalContexts ?? [])
      .flatMap(context => context.content ?? [])
      .map(block => block.text ?? '')
      .join('\n')

    const launched = await runTool({
      name: 'probe_run',
      arguments: { command: 'pwsh -File .\\launch-a-runtime-clean.ps1' },
      callId: 'call_test_launch',
    })
    assert(launched.isError !== true, 'the tool call itself still succeeded')
    const attached = attachedTo(launched)
    assert(attached.includes(remembered.id),
      `the lesson is attached to the very call it warns about: ${attached}`)
    assert(attached.includes('Steam'), 'and it carries the lesson, not just an id')

    // ── The delivery is written down ───────────────────────────────────────
    // This is the record that makes the framework's central claim checkable, so it is asserted
    // on the real waterfall rather than by calling the recorder: the hint the agent sees and
    // the row the ledger reads must come from the same event, or the ledger measures fiction.
    const deliverySide = openDb(dbPath)
    try {
      const deliveries = deliveriesAtOrBefore(deliverySide, Date.now() + 1000)
      eq(deliveries.length, 1, 'exactly one delivery is recorded for the one hint that went out')
      eq(deliveries[0]?.recordId, remembered.id, 'and it names the lesson that was attached')
      assert((deliveries[0]?.matched ?? '').includes('launch-a-runtime-clean.ps1'),
        `and the identifier that carried it: ${deliveries[0]?.matched ?? '(none)'}`)
      eq(deliveries[0]?.tool, 'probe_run', 'with the tool the call was about')
      assert(typeof deliveries[0]?.sessionId === 'string' && deliveries[0].sessionId !== '',
        'and the session, without which the ledger could only ever associate by the clock')
      eq(deliveries[0]?.sessionId, agent.id,
        'which is the agent the call ran as, not a placeholder')

      // ── A call about something else gets nothing ───────────────────────────
      const unrelated = await runTool({
        name: 'probe_run',
        arguments: { command: 'Get-ChildItem -Force' },
        callId: 'call_test_unrelated',
      })
      eq((unrelated.additionalContexts ?? []).length, 0,
        'a call that names nothing in the store costs nothing — no identifier, no attachment')
      eq(deliveriesAtOrBefore(deliverySide, Date.now() + 1000).length, 1,
        'and a call that was shown nothing writes nothing — absence is the record of a miss')
    } finally {
      deliverySide.close()
    }

    // ── The throttle is the cooldown, not a per-turn limit ─────────────────
    // A per-turn limit was tried and replayed against the real session this feature exists
    // for: the turn's one slot went to whichever record some *other* call matched first, and
    // the lesson about launching the game was never delivered, in any turn. So the throttle is
    // a per-record cooldown, and this pair of calls shows what that means: a turn boundary does
    // not release it, while a different record is free to go out in the same turn.
    const endTurn = async (): Promise<void> => {
      await agentEvents(ctx, agent).serial('agent/turn-stopping', {
        turn: 1,
        signal: new AbortController().signal,
      })
    }

    await endTurn()
    const repeatedInNewTurn = await runTool({
      name: 'probe_run',
      arguments: { command: 'pwsh -File .\\launch-a-runtime-clean.ps1' },
      callId: 'call_test_launch_new_turn',
    })
    eq((repeatedInNewTurn.additionalContexts ?? []).length, 0,
      'the same lesson inside its cooldown is not shown again, because a lesson repeated on '
      + 'every call is one the agent learns to skip')

    const secondRecord = await runTool({
      name: 'probe_run',
      arguments: { command: 'pwsh -File .\\restore-save-backup.ps1' },
      callId: 'call_test_other_record_same_turn',
    })
    const otherHint = attachedTo(secondRecord)
    assert(otherHint.includes(other.id),
      'while a different record still goes out in that same turn, which is what shows the '
      + `cooldown is the only thing blocking the one above: ${otherHint}`)

    // ── The session ceiling counts hints, not records ──────────────────────
    // The knob says "a session may be shown at most N hints". Counting distinct records
    // instead would let one record be sent an unbounded number of times, which is the
    // difference between a ceiling and a rounding error.
    const capped = mkdtempSync(join(tmpdir(), 'expmem-precall-capped-'))
    const cappedCtx = new Context()
    try {
      await cappedCtx.plugin(SystemPrompt, {})
      await cappedCtx.plugin(ToolRuntime, {})
      await cappedCtx.plugin(Commands, {})
      await cappedCtx.plugin(experienceMemory, {
        enabled: true, dbPath: join(capped, 'memory.db'), precallMaxPerSession: 1,
      })
      cappedCtx.tools.register({ ...probeTool })
      const cappedCall = async (name: string, args: unknown) =>
        await cappedCtx.tools.get(name)!.execute(args, { signal: new AbortController().signal, agent })
      await cappedCall('memory_remember', {
        kind: 'experience',
        title: '启动游戏前必须确认 Steam 已登录',
        body: '无人值守启动前要确认 Steam 已登录（launch-a-runtime-clean.ps1 里有这道检查）。',
        quote,
        recall_for: ['command:launch-a-runtime-clean.ps1'],
      })
      await cappedCall('memory_remember', {
        kind: 'experience',
        title: '还原存档要认准备份文件',
        body: '还原存档前先确认备份文件是 restore-save-backup.ps1 生成的那一份。',
        quote,
        recall_for: ['command:restore-save-backup.ps1'],
      })
      const cappedScheduler = (cappedCtx.tools as unknown as Record<symbol, Stage>)[TOOL_RUNTIME_SCHEDULER]
      const cappedRun = async (command: string, callId: string): Promise<Dispatched> => {
        const prepared = await cappedScheduler.prepare({
          name: 'probe_run',
          arguments: { command },
          agent,
          signal: new AbortController().signal,
          callId,
        })
        const dispatched = await cappedScheduler.dispatch(prepared.exec)
        return await cappedScheduler.finalize(prepared.exec, dispatched.result)
      }
      const first = await cappedRun('pwsh -File .\\launch-a-runtime-clean.ps1', 'call_capped_1')
      eq((first.additionalContexts ?? []).length, 1, 'the first hint of the session goes out')
      const beyond = await cappedRun('pwsh -File .\\restore-save-backup.ps1', 'call_capped_2')
      eq((beyond.additionalContexts ?? []).length, 0,
        'and the session ceiling of 1 holds even for a record it has never shown')
    } finally {
      await cappedCtx.fiber.dispose()
      rmSync(capped, { recursive: true, force: true })
    }

    // ── A broken store must not break a tool call ──────────────────────────
    // The whole point of attaching a hint is that it is optional. If the matcher throws and
    // the throw escapes, an otherwise-fine call comes back as an error — strictly worse than
    // no hint at all.
    const broken = mkdtempSync(join(tmpdir(), 'expmem-precall-broken-'))
    const brokenPath = join(broken, 'memory.db')
    const brokenCtx = new Context()
    try {
      await brokenCtx.plugin(SystemPrompt, {})
      await brokenCtx.plugin(ToolRuntime, {})
      await brokenCtx.plugin(Commands, {})
      await brokenCtx.plugin(experienceMemory, { enabled: true, dbPath: brokenPath })
      brokenCtx.tools.register({ ...probeTool })
      const side: DatabaseSync = (await import('../src/db.ts')).openDb(brokenPath)
      side.exec('DROP TABLE record')
      side.close()

      const brokenScheduler = (brokenCtx.tools as unknown as Record<symbol, {
        prepare: (exec: unknown) => Promise<{ kind: string; exec: unknown; result?: Dispatched }>
        dispatch: (exec: unknown) => Promise<{ kind: string; result: Dispatched }>
        finalize: (exec: unknown, result: Dispatched) => Promise<Dispatched>
        finish: (exec: unknown, result: Dispatched) => Dispatched
      }>)[TOOL_RUNTIME_SCHEDULER]
      const brokenAgent = {
        id: 'session-broken', session: { header: { cwd: broken }, snapshotEvents: () => [] },
      }
      const prepared = await brokenScheduler.prepare({
        name: 'probe_run',
        arguments: { command: 'pwsh -File .\\launch-a-runtime-clean.ps1' },
        agent: brokenAgent,
        signal: new AbortController().signal,
        callId: 'call_test_broken',
      })
      const survived = prepared.kind === 'dispatch'
        ? await brokenScheduler.finalize(prepared.exec, (await brokenScheduler.dispatch(prepared.exec)).result)
        : (prepared.result as Dispatched)
      assert(survived.isError !== true,
        'a matcher that cannot run leaves the tool call untouched: it returns its own value')
      eq((survived.additionalContexts ?? []).length, 0, 'and attaches nothing')
    } finally {
      await brokenCtx.fiber.dispose()
      rmSync(broken, { recursive: true, force: true })
    }

    // ── A script the whole window mentions still picks out nothing ─────────
    // The old gate tried to solve this with a document-frequency ceiling: `Bannerlord` was in
    // 13 of the 17 records a workspace could see, so a `Bannerlord` hit picked out no record,
    // and the ceiling was tuned until that stopped mattering. The ceiling is gone, because
    // tuning it was never going to work — the replay in `docs/DELIVERY-GAPS.md` shows why.
    // What decides now is whether the record said so. Three records that merely *mention* the
    // script attach nothing; the one that declares the anchor is the one that arrives, and no
    // threshold is involved.
    const sharedScript = 'drain-campaign-state.ps1'
    for (const variant of ['甲', '乙', '丙']) {
      const written = await call('memory_remember', {
        kind: 'experience',
        title: `排空战役状态的写法（${variant}）`,
        body: `第 ${variant} 种写法：无论怎么排空，最后都要跑 ${sharedScript} 收尾。`,
        quote,
      }) as { status: string }
      eq(written.status, 'confirmed', `a record that only mentions the script is a real record: ${variant}`)
    }
    const gateDb = openDb(dbPath)
    try {
      const workspace = resolveWorkspace(dir, '')
      const shared = { command: `pwsh -File .\\${sharedScript}` }
      eq(recallForCall(gateDb, workspace.id, workspace.domain, shared, Date.now()), undefined,
        'three records that merely mention the script are all silent — mentioning is not declaring')

      const declared = await call('memory_remember', {
        kind: 'experience',
        title: '排空战役状态前先停掉正在跑的 worker',
        body: '排空战役状态之前要先确认 worker 已停，否则收尾脚本会写到一半被顶掉。',
        quote,
        recall_for: [`command:${sharedScript}`],
      }) as { id: string; status: string }
      eq(declared.status, 'confirmed', 'and the one that declares the anchor is a real record too')
      const arrived = recallForCall(gateDb, workspace.id, workspace.domain, shared, Date.now())
      eq(arrived?.id, declared.id, 'the declared anchor is what decides, and no threshold is involved')
    } finally {
      gateDb.close()
    }
  } finally {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  precall    ok')
}
