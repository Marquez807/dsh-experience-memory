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
import { openDb } from '../src/db.ts'
import { resolveWorkspace } from '../src/domain.ts'
import { identifiersOf, recallForCall } from '../src/precall.ts'
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
  // ── What counts as an identifier ──────────────────────────────────────────
  eq(identifiersOf({ query: '部署' }), [], 'prose with no identifier yields nothing to match on')
  // A tool call names itself: the script it runs, the file it edits, the switch it passes.
  const named = identifiersOf({ command: 'pwsh -File .\\launch-a-runtime-clean.ps1 -ResetSafeExit' })
  assert(named.some(id => id.includes('launch-a-runtime-clean.ps1')),
    `the script it runs is an identifier: ${named.join(', ')}`)
  assert(named.some(id => id.toLowerCase().replace(/^-+/, '') === 'resetsafeexit'),
    `and so is a named switch: ${named.join(', ')}`)
  // The stoplist is the difference between "specific" and "matches half the store".
  const generic = identifiersOf({ command: 'node tests/run.ts --force' })
  assert(!generic.some(id => /^(node|tests?|force)$/i.test(id)),
    `words that identify nothing are excluded: ${generic.join(', ')}`)
  // Only the values. Every edit carries `file_path` and `old_string`, so counting keys would
  // make every edit match every record that ever mentioned editing — which is what the first
  // version of this module did, and it attached something to two calls in three.
  const keys = identifiersOf({ file_path: 'x', old_string: 'y', new_string: 'z' })
  eq(keys, [], `argument names are the tool's schema, not what the call is about: ${keys.join(', ')}`)
  const asJson = identifiersOf('{"file_path":"x","command":"pwsh -File .\\\\drain-state.ps1"}')
  assert(asJson.some(id => id.includes('drain-state.ps1')),
    `and the same holds when the arguments arrive as the JSON string the log stores: ${asJson.join(', ')}`)
  assert(!asJson.some(id => id === 'file_path'), 'the key is dropped in that form too')
  eq(identifiersOf(undefined), [], 'a call with no arguments has nothing to match on')

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

    // One confirmed record that names the script, written the ordinary way.
    const remembered = await call('memory_remember', {
      kind: 'experience',
      title: '启动游戏前必须确认 Steam 已登录',
      body: '无人值守启动前要确认 Steam 已登录，否则游戏约 10 秒后静默退出（launch-a-runtime-clean.ps1 里有这道检查）。',
      quote,
    }) as { id: string; status: string }
    eq(remembered.status, 'confirmed', 'the lesson is a real record, not a candidate')
    // A second, unrelated lesson, so the per-turn ceiling can be told apart from "nothing else
    // matched": two records, two identifiers, one turn.
    const other = await call('memory_remember', {
      kind: 'experience',
      title: '还原存档要认准备份文件',
      body: '还原存档前先确认备份文件是 restore-save-backup.ps1 生成的那一份，否则会覆盖掉好档。',
      quote,
    }) as { id: string; status: string }
    eq(other.status, 'confirmed', 'and a second record, with an identifier of its own')

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

    // ── A call about something else gets nothing ───────────────────────────
    const unrelated = await runTool({
      name: 'probe_run',
      arguments: { command: 'Get-ChildItem -Force' },
      callId: 'call_test_unrelated',
    })
    eq((unrelated.additionalContexts ?? []).length, 0,
      'a call that names nothing in the store costs nothing — no identifier, no attachment')

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
      })
      await cappedCall('memory_remember', {
        kind: 'experience',
        title: '还原存档要认准备份文件',
        body: '还原存档前先确认备份文件是 restore-save-backup.ps1 生成的那一份。',
        quote,
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

    // ── An identifier the whole window shares identifies nothing ───────────
    // This is the gate the real replay forced: `Bannerlord` is in 13 of the 17 records that
    // workspace could see, so a `Bannerlord` hit picks out no record at all — yet on the
    // first version of this module it was exactly what filled the hint slot, two calls in
    // three. Three records about one script and nothing is attached; raise the ceiling to
    // three and one of them is, which is what shows the ceiling did the deciding.
    const sharedScript = 'drain-campaign-state.ps1'
    for (const variant of ['甲', '乙', '丙']) {
      const written = await call('memory_remember', {
        kind: 'experience',
        title: `排空战役状态的写法（${variant}）`,
        body: `第 ${variant} 种写法：无论怎么排空，最后都要跑 ${sharedScript} 收尾。`,
        quote,
      }) as { status: string }
      eq(written.status, 'confirmed', `a record about the shared script is a real record: ${variant}`)
    }
    const gateDb = openDb(dbPath)
    try {
      const workspace = resolveWorkspace(dir, '')
      const shared = { command: `pwsh -File .\\${sharedScript}` }
      eq(recallForCall(gateDb, workspace.id, workspace.domain, shared, Date.now()), undefined,
        'a script that three visible records mention picks out none of them')
      const raised = recallForCall(
        gateDb, workspace.id, workspace.domain, shared, Date.now(), { maxDocFrequency: 3 },
      )
      assert(raised !== undefined && raised.title.includes('排空战役状态'),
        `and the ceiling is what decided that, not the matching: ${raised?.title ?? '(nothing)'}`)
    } finally {
      gateDb.close()
    }
  } finally {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  precall    ok')
}
