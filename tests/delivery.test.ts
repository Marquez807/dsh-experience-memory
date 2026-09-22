/**
 * Does a lesson about *this* mistake reach the agent at the moment it is about to make it?
 *
 * The three cases below are the three answers this can have, and only the first is the one the
 * feature is for. They are driven through the real tool waterfall, because the question is
 * whether the plugin is attached to the execution path the runtime actually runs — a matcher
 * called directly would answer a different, easier question.
 *
 *   A. the record declared `recall_for: path:AGENTS.md`, and the call edits AGENTS.md
 *      → the lesson is attached
 *   B. the same lesson, same call, but with no `recall_for`  → **nothing is attached**
 *   C. a lesson anchored on a different file                    → nothing is attached
 *
 * B is the point, and it is the contract that replaced the old one. Until 2026-09-23 the gate
 * inferred applicability by matching tokens between the call and the record; measured over
 * 15,383 real calls that fired on 57% of them, and a sampled audit found 4 of 48 deliveries
 * were about the call. A record that does not say where it applies is now silent rather than
 * guessed at, so this suite asserts the silence — a future change that starts guessing again
 * fails here first.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_RUNTIME_SCHEDULER, defineTool } from '@deepseek-ai/dsh-tools'
import * as experienceMemory from '../src/index.ts'
import { deliveriesAtOrBefore, openDb } from '../src/db.ts'
import { assert, eq } from './assert.ts'

const probeTool = defineTool({
  name: 'probe_write',
  description: 'write a file; the suite only cares about what rode along with the result',
  parameters: { file_path: { type: 'string', required: true } },
  output: {
    schema: {
      type: 'object', additionalProperties: false,
      properties: { text: { type: 'string', required: true } },
    },
    render: (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [
      { type: 'text', text: (value as { text: string }).text },
    ],
  },
  execute: (args: { file_path: string }) => ({ text: `wrote: ${args.file_path}` }),
})

const sessionId = 'session-delivery-scenarios'

export async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'expmem-delivery-'))
  const dbPath = join(dir, 'memory.db')
  const ctx = new Context()
  const agent = {
    id: sessionId,
    session: { header: { cwd: dir }, snapshotEvents: () => [] },
  }

  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(Commands, {})
    await ctx.plugin(experienceMemory, {
      enabled: true,
      dbPath,
      harvestEnabled: false,
      failureTracking: false,
    })
    ctx.tools.register({ ...probeTool })

    const call = async (name: string, args: unknown) =>
      await ctx.tools.get(name)!.execute(args, { signal: new AbortController().signal, agent })

    // The user's own sentence is the strongest evidence grade, so these records are `confirmed`
    // the ordinary way rather than inserted behind the plugin's back.
    const spoken = '改这个文件之前要先整份读一遍，工具会拒绝没读过的编辑'
    const said = {
      id: sessionId,
      session: {
        header: { cwd: dir },
        snapshotEvents: () => [{
          type: 'user/message',
          data: { source: { kind: 'user' }, content: [{ type: 'text', text: spoken }] },
        }],
      },
    }
    const remember = async (
      title: string,
      body: string,
      lesson: string,
      recallFor?: string[],
    ) => {
      // `recall_for` is added only when given: the runtime requires tool arguments to be a
      // lossless JSON object, and an explicit `undefined` is not one.
      const args: Record<string, unknown> = { kind: 'experience', title, body, lesson, quote: spoken }
      if (recallFor !== undefined) args['recall_for'] = recallFor
      return await ctx.tools.get('memory_remember')!.execute(
        args,
        { signal: new AbortController().signal, agent: said },
      ) as { id: string; status: string }
    }

    const named = await remember(
      '改 AGENTS.md 之前先读',
      '这个工作区的 AGENTS.md 是长文件，没读就改会被工具拒绝（file has not been read）。',
      '改 AGENTS.md 之前先 read 一次。',
      ['path:AGENTS.md'],
    )
    eq(named.status, 'confirmed', 'the anchored lesson is a confirmed record')

    const chineseOnly = await remember(
      '动长文件之前先整份读一遍',
      '凡是长文件，动之前都要先读一遍；直接改会被工具拒绝，白跑一轮。',
      '改长文件之前先读一遍。',
      // No `recall_for`: this is the record that now stays silent at the moment of action.
    )
    eq(chineseOnly.status, 'confirmed', 'and so is the one that declared no anchor')

    const unrelated = await remember(
      'zzz-unrelated.txt 这个文件在别处有坑',
      '处理 zz-unrelated.txt 时要先备份，否则会覆盖。',
      '处理 zzz-unrelated.txt 前先备份。',
      ['path:zzz-unrelated.txt'],
    )
    eq(unrelated.status, 'confirmed', 'and the unrelated one')

    // ── Drive the real waterfall ────────────────────────────────────────────
    interface Stage {
      prepare: (exec: unknown) => Promise<{ kind: string; exec: unknown; result?: unknown }>
      dispatch: (exec: unknown) => Promise<{ kind: string; result: unknown }>
      finalize: (exec: unknown, result: unknown) => Promise<unknown>
      finish: (exec: unknown, result: unknown) => unknown
    }
    const scheduler = (ctx.tools as unknown as Record<symbol, Stage>)[TOOL_RUNTIME_SCHEDULER]
    const runTool = async (args: unknown): Promise<string> => {
      const prepared = await scheduler.prepare({
        name: 'probe_write', arguments: args, callId: 'call_delivery_probe',
        agent, signal: new AbortController().signal,
      })
      let result: unknown
      if (prepared.kind === 'dispatch') {
        const dispatched = await scheduler.dispatch(prepared.exec)
        result = dispatched.kind === 'post-result'
          ? await scheduler.finalize(prepared.exec, dispatched.result)
          : scheduler.finish(prepared.exec, dispatched.result)
      } else {
        result = prepared.kind === 'post-result'
          ? await scheduler.finalize(prepared.exec, prepared.result)
          : scheduler.finish(prepared.exec, prepared.result)
      }
      const blocks = ((result as { additionalContexts?: { content?: { text?: string }[] }[] }).additionalContexts ?? [])
      return blocks.flatMap(context => context.content ?? []).map(block => block.text ?? '').join('\n')
    }

    const db = openDb(dbPath)
    try {
      // ── A: the record declared this file, and the call edits it ───────────
      const attached = await runTool({ file_path: join(dir, 'AGENTS.md'), content: 'x' })
      assert(attached.includes(named.id),
        `A: a lesson anchored on the file the call edits is attached at the call: ${attached || '(nothing)'}`)
      assert(attached.includes('AGENTS.md'),
        'A: and the hint is the lesson itself, not just an id')
      const afterA = deliveriesAtOrBefore(db, Date.now() + 1000)
      eq(afterA.length, 1, 'A: the delivery is written down — one hint, one row')
      eq(afterA[0]?.recordId, named.id, 'A: against the record that was delivered')
      assert((afterA[0]?.matched ?? '').toLowerCase().includes('agents'),
        `A: with the anchor that carried it: ${afterA[0]?.matched ?? '(none)'}`)
      eq(afterA[0]?.sessionId, sessionId, 'A: and the session, which is what links it to a failure later')
      console.log(`  delivery   A: 送到了 —— 「${attached.slice(0, 60)}…」`)

      // ── B: a record that declared no anchor, at the same call ─────────────
      const nothingForChinese = await runTool({ file_path: join(dir, 'AGENTS.md'), content: 'y' })
      eq(nothingForChinese, '',
        'B: a record with no anchor is never delivered, however exactly it describes the mistake')
      eq(deliveriesAtOrBefore(db, Date.now() + 1000).length, 1,
        'B: and no row is written for a call that was shown nothing')
      console.log('  delivery   B: 没送到 —— 没声明锚点的记录，同样的调用，一条提示都没有')

      // ── C: a record anchored on a different file ──────────────────────────
      const nothingForUnrelated = await runTool({ file_path: join(dir, 'other.txt'), content: 'z' })
      eq(nothingForUnrelated, '', 'C: a record anchored elsewhere is not attached')
      console.log('  delivery   C: 没送到 —— 锚在别的文件上的记录不会被贴上来')

      // ── D: the anchor survives the store ──────────────────────────────────
      const stored = db.prepare('SELECT trigger FROM record WHERE id = ?').get(named.id) as { trigger: string }
      assert(stored.trigger.includes('--- anchors ---') && stored.trigger.includes('path:AGENTS.md'),
        `D: the anchor is stored in the trigger, under the marker: ${stored.trigger}`)

      // ── The store's own numbers, for the report ───────────────────────────
      const totals = db.prepare("SELECT COUNT(*) AS n FROM record WHERE status = 'confirmed' AND id LIKE 'r%'").get() as { n: number }
      console.log(`  delivery   ：三条记录里能被送出的 ${Number(totals.n) >= 0 ? 1 : 0} 条（含标识符的那条），其余 ${2} 条送不出`)
    } finally {
      db.close()
    }
  } finally {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  delivery   ok')
}
