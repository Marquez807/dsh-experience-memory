/**
 * Does a lesson about *this* mistake reach the agent at the moment it is about to make it?
 *
 * The three cases below are the three answers this can have, and only the first is the one the
 * feature is for. They are driven through the real tool waterfall, because the question is
 * whether the plugin is attached to the execution path the runtime actually runs — a matcher
 * called directly would answer a different, easier question.
 *
 *   A. the call names the file the lesson is about          → the lesson is attached
 *   B. the same lesson, same call, but written in Chinese   → **nothing is attached**, because
 *      the matcher reads identifiers out of the arguments and Chinese prose yields none
 *   C. a lesson about something else entirely               → nothing is attached
 *
 * B is the point. A real store measured on 2026-09-23 held 156 confirmed records and 44 of them
 * carried no identifier at all, so no tool call could ever deliver them; and the arguments of a
 * Chinese-language call carry none either, which is most of what this workspace does. The suite
 * asserts that gap rather than describing it, so a future change that fixes it fails here first.
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
    const remember = async (title: string, body: string, lesson: string) =>
      await ctx.tools.get('memory_remember')!.execute(
        { kind: 'experience', title, body, lesson, quote: spoken },
        { signal: new AbortController().signal, agent: said },
      ) as { id: string; status: string }

    const named = await remember(
      '改 AGENTS.md 之前先读',
      '这个工作区的 AGENTS.md 是长文件，没读就改会被工具拒绝（file has not been read）。',
      '改 AGENTS.md 之前先 read 一次。',
    )
    eq(named.status, 'confirmed', 'the named lesson is a confirmed record')

    const chineseOnly = await remember(
      '动长文件之前先整份读一遍',
      '凡是长文件，动之前都要先读一遍；直接改会被工具拒绝，白跑一轮。',
      '改长文件之前先读一遍。',
    )
    eq(chineseOnly.status, 'confirmed', 'and so is the one written without any identifier')

    const unrelated = await remember(
      'zzz-unrelated.txt 这个文件在别处有坑',
      '处理 zz-unrelated.txt 时要先备份，否则会覆盖。',
      '处理 zzz-unrelated.txt 前先备份。',
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
      // ── A: the call names the file the lesson is about ────────────────────
      const attached = await runTool({ file_path: join(dir, 'AGENTS.md'), content: 'x' })
      assert(attached.includes(named.id),
        `A: a lesson naming the file the call is about is attached at the call: ${attached || '(nothing)'}`)
      assert(attached.includes('AGENTS.md'),
        'A: and the hint is the lesson itself, not just an id')
      const afterA = deliveriesAtOrBefore(db, Date.now() + 1000)
      eq(afterA.length, 1, 'A: the delivery is written down — one hint, one row')
      eq(afterA[0]?.recordId, named.id, 'A: against the record that was delivered')
      assert((afterA[0]?.matched ?? '').toLowerCase().includes('agents'),
        `A: with the identifier that carried it: ${afterA[0]?.matched ?? '(none)'}`)
      eq(afterA[0]?.sessionId, sessionId, 'A: and the session, which is what links it to a failure later')
      console.log(`  delivery   A: 送到了 —— 「${attached.slice(0, 60)}…」`)

      // ── B: the same lesson in Chinese prose, the same call ────────────────
      const nothingForChinese = await runTool({ file_path: join(dir, 'AGENTS.md'), content: 'y' })
      eq(nothingForChinese, '',
        'B: a lesson with no identifier is not delivered, however exactly it describes the mistake')
      eq(deliveriesAtOrBefore(db, Date.now() + 1000).length, 1,
        'B: and no row is written for a call that was shown nothing')
      console.log('  delivery   B: 没送到 —— 中文写的同一条经验，同样的调用，一条提示都没有')

      // ── C: a lesson about something else entirely ─────────────────────────
      const nothingForUnrelated = await runTool({ file_path: join(dir, 'other.txt'), content: 'z' })
      eq(nothingForUnrelated, '', 'C: an unrelated lesson is not attached')
      console.log('  delivery   C: 没送到 —— 无关的经验不会被贴上来')

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
