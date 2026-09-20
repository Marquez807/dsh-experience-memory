/**
 * Operator-command regressions.
 *
 * These drive the commands through the **real** command service — the same one
 * `/compact` and `/goal` register with — rather than a stub. That matters twice
 * over: registration validates the definitions (a malformed one throws at mount),
 * and it proves the commands can actually be reached, which a stub asserting its
 * own inputs never would.
 *
 * The suite also pins the design rule these commands exist to satisfy: the model
 * gets four tools, and audit/import stay behind a human trigger.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { assert, eq } from './assert.ts'
import { COMMAND_NAMES, parseArgs, tokenizeArgs } from '../src/commands.ts'
import { openDb } from '../src/db.ts'
import * as memory from '../src/index.ts'

/** An append-only fake session log, so lifecycle events can be inspected. */
interface Append {
  type: string
  data: Record<string, unknown>
}

const userMessage = (text: string) => ({
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

export async function run(): Promise<void> {
  // ── Argument parsing is pure, so test it without a Context ───────────────
  eq(tokenizeArgs('a "b c" --d'), ['a', 'b c', '--d'], 'quoted values survive as one token')
  eq(tokenizeArgs('  '), [], 'blank input yields no tokens')
  eq(parseArgs('--apply'), { positional: [], flags: { apply: true } }, 'a bare flag is true')
  eq(parseArgs('root --out dir'), { positional: ['root'], flags: { out: 'dir' } },
    'a flag takes the following token as its value')
  eq(parseArgs('root --apply --selection x').flags, { apply: true, selection: 'x' },
    'a valueless flag does not swallow the next flag')

  const dir = mkdtempSync(join(tmpdir(), 'expmem-cmd-'))
  const dbPath = join(dir, 'memory.db')
  const ctx = new Context()
  let disposed = false
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(Commands, {})
    await ctx.plugin(memory, { enabled: true, dbPath })

    const appended: Append[] = []
    const agent = (events: readonly unknown[] = []) => ({
      id: 'cmd-session',
      session: {
        header: { cwd: dir },
        // The real accessor, plus the append hook the command service calls.
        snapshotEvents: () => events,
        append: (type: string, data: Record<string, unknown>) => { appended.push({ type, data }) },
      },
    })
    const signal = new AbortController().signal

    /** Execute one command line exactly as the UI would. */
    const execute = async (line: string, target = agent()) => {
      const settled = await ctx.commands.execute(target, line, [], signal)
      assert(settled !== undefined, `${line} resolves to a registered command`)
      return settled!.result
    }
    const text = (result: { text?: string }): string => result.text ?? ''

    // ── Every command is registered and reachable ─────────────────────────
    for (const name of COMMAND_NAMES) {
      const settled = await ctx.commands.execute(agent(), `/${name}`, [], signal)
      assert(settled !== undefined, `/${name} is registered on the real command service`)
    }

    // ── They are discoverable the way the composer discovers them ─────────
    // The slash menu renders `ctx.commands.list(agent)`, so this is the data a
    // person would actually see. A command that does not appear here is not
    // reachable however well its handler works — which is the failure this suite
    // exists to catch, since this surface is a menu rather than an import.
    const descriptors = ctx.commands.list(agent())
    const mine = descriptors.filter(entry => entry.name.startsWith('memory-'))
    eq(mine.map(entry => entry.name), [...COMMAND_NAMES].sort(),
      'the slash menu lists exactly the five operator commands')
    const listed = descriptors.map(entry => entry.name)
    eq(listed, [...listed].sort(), 'and the service returns them name-sorted')
    for (const entry of mine) {
      assert(typeof entry.description === 'string' && entry.description.trim() !== '',
        `/${entry.name} carries a description for the menu`)
    }
    // The three that take arguments must advertise their syntax, or the composer
    // has nothing to hint.
    for (const name of ['memory-preview', 'memory-audit', 'memory-import']) {
      const entry = mine.find(item => item.name === name)
      assert(entry?.input?.hint !== undefined && entry.input.hint !== '',
        `/${name} advertises its argument hint`)
    }
    for (const name of ['memory-status', 'memory-maintain']) {
      eq(mine.find(item => item.name === name)?.input, undefined,
        `/${name} takes no arguments and advertises none`)
    }

    // ── The registration-time rules hold ─────────────────────────────────
    eq(appended.filter(entry => entry.type === 'command/run').length, COMMAND_NAMES.length,
      'running each command opened a lifecycle pair')
    assert(appended.filter(entry => entry.type === 'command/run')
      .every(entry => !('args' in entry.data)),
    'operator commands keep their input out of the transcript (recordInput: false)')

    // ── Status ───────────────────────────────────────────────────────────
    const empty = await execute('/memory-status')
    eq(empty.kind, 'success', 'status succeeds on an empty store')
    assert(text(empty).includes('记录 0 条'), 'and reports an empty store')
    assert(text(empty).includes(dbPath), 'and names the database it read')

    // ── Preview ──────────────────────────────────────────────────────────
    const noQuery = await execute('/memory-preview')
    eq(noQuery.kind, 'error', 'preview without a query and without a session message is an error')
    assert(text(noQuery).includes('需要一个查询词'), 'and says what it needs')

    // A verified record, so it is eligible for the resident layer.
    const quote = '部署一律写到 F 盘，不要写 C 盘'
    const sessionAgent = agent([userMessage(quote)])
    const remember = ctx.tools.get('memory_remember')
    assert(remember !== undefined, 'the remember tool is registered')
    const saved = await remember!.execute(
      { kind: 'experience', title: '部署目标盘', body: '部署一律写到 F 盘', quote, trigger: '部署' },
      { signal, agent: sessionAgent },
    ) as { id: string; status: string }
    eq(saved.status, 'confirmed', 'a verbatim user assertion confirms the record')

    const preview = await execute('/memory-preview 部署', sessionAgent)
    eq(preview.kind, 'success', 'preview succeeds for a matching query')
    assert(text(preview).includes('部署目标盘'), 'and shows what would be injected this turn')
    assert(text(preview).includes('常驻注入'), 'and separates injection from on-demand recall')

    // Ahead of any query the command falls back to the session, exactly as the
    // plugin's own query builder does.
    const fromSession = await execute('/memory-preview', sessionAgent)
    eq(fromSession.kind, 'success', 'preview falls back to the session messages')
    assert(text(fromSession).includes('部署'), 'and uses them as the query')

    // ── Maintain ─────────────────────────────────────────────────────────
    const maintained = await execute('/memory-maintain')
    eq(maintained.kind, 'success', 'maintenance runs on demand')
    assert(text(maintained).includes('扫描'), 'and reports how much it scanned')

    // ── Audit ────────────────────────────────────────────────────────────
    const legacy = join(dir, 'legacy')
    const legacyMemory = join(legacy, '.memory')
    mkdirSync(legacyMemory, { recursive: true })
    writeFileSync(join(legacy, 'package.json'), JSON.stringify({ name: '@acme/legacy' }))
    writeFileSync(join(legacyMemory, 'entries.jsonl'), [
      { type: 'fact', text: `一条值得保留的旧记录${'说明'.repeat(20)}`, summary: '旧记录',
        status: 'confirmed', scope: 'project', admission: { proof: { kind: 'file' } } },
      { type: 'fact', text: 'Tool call_00_abcdefghijklmnopqrst exited 1', summary: '工具事件',
        status: 'confirmed', scope: 'project', admission: { proof: { kind: 'tool' } } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8')

    const noRoot = await execute('/memory-audit')
    eq(noRoot.kind, 'error', 'audit without a root is an error rather than scanning somewhere')
    assert(text(noRoot).includes('用法'), 'and prints its usage')

    const out = join(dir, 'reports')
    const audited = await execute(`/memory-audit "${legacy}" --out "${out}"`)
    eq(audited.kind, 'success', 'audit succeeds on a legacy tree')
    assert(text(audited).includes('建议导入'), 'and reports what it recommends')
    for (const file of ['legacy-memory-audit.md', 'legacy-memory-recommended.md',
      'legacy-memory-selection.json', 'legacy-memory-records.tsv']) {
      assert(existsSync(join(out, file)), `audit wrote ${file}`)
    }

    // ── Import ───────────────────────────────────────────────────────────
    const countRecords = (): number => {
      const side = openDb(dbPath)
      try {
        return (side.prepare('SELECT count(*) AS n FROM record').get() as { n: number }).n
      } finally {
        side.close()
      }
    }
    const before = countRecords()
    const dry = await execute(`/memory-import "${legacy}"`)
    eq(dry.kind, 'success', 'a dry run succeeds')
    // The substantive property first, then the wording: a mutant that applies by
    // default must fail on "the store did not change", not on a phrase.
    eq(countRecords(), before, 'and writes nothing')
    assert(text(dry).includes('试运行'), 'and says plainly that nothing was written')

    const applied = await execute(`/memory-import "${legacy}" --apply`)
    eq(applied.kind, 'success', 'applying succeeds')
    assert(text(applied).includes('写入完成'), 'and reports what it wrote')
    assert(countRecords() > before, 'and the store actually gained a record')

    const missing = await execute(`/memory-import "${legacy}" --selection "${join(dir, 'nope.json')}"`)
    eq(missing.kind, 'error', 'an unreadable selection file is an error')
    assert(text(missing).includes('无法读取清单'), 'and says which file it could not read')

    // ── The model surface did not grow with the commands ─────────────────
    // Exactly the five registered tools and nothing else: the operator commands
    // are a menu, not tools, so they cost the model nothing per turn.
    const toolNames = ctx.tools.schemas().map(schema => schema.name).sort()
    eq(toolNames, ['memory_feedback', 'memory_forget', 'memory_recall', 'memory_remember', 'memory_stats'],
      'the operator commands added no model-facing tool')

    // ── Unmounting releases the database ─────────────────────────────────
    await ctx.fiber.dispose()
    disposed = true
    const reopened = openDb(dbPath)
    reopened.close()
  } finally {
    if (!disposed) await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  commands   ok')
}
