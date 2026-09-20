// Consumer-level probe: import the INSTALLED package by bare specifier, with
// plain node and no experimental flags.
//
// This is the scenario that fails with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
// when a plugin ships TypeScript entry points, so it is the acceptance test for
// publishing built JavaScript instead.
//
// Run it from a profile directory that has the plugin installed, because the bare
// specifier `dsh-experience-memory` and the @deepseek-ai/* peers must both resolve
// from there:
//
//   dsh plugin --profile <name> add <tarball-or-path>
//   cp tools/verify-install.mjs "$DSH_HOME/profiles/<name>/"
//   node "$DSH_HOME/profiles/<name>/verify-install.mjs"
//
// tests/built.mjs covers the same ground in-repo; this one additionally proves
// that module resolution works from node_modules rather than from a source tree.
//
// Every service the plugin injects must be mounted here, or it will not activate
// and every assertion below fails for the wrong reason. That is not hypothetical:
// adding `commands` to `inject` broke this file until it was updated, because
// nothing in the suite runs it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as memory from 'dsh-experience-memory'

let failed = 0
let checked = 0
const check = (ok, label) => {
  checked += 1
  if (!ok) { failed += 1; console.error(`  FAIL ${label}`) } else console.log(`  ok   ${label}`)
}

for (const key of ['name', 'inject', 'Config', 'apply']) {
  check(key in memory, `installed package exports ${key}`)
}
check(memory.name === 'experience-memory', 'the plugin name is stable')

const dir = mkdtempSync(join(tmpdir(), 'expmem-installed-'))
const ctx = new Context()
let disposed = false
try {
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(Commands, {})
  await ctx.plugin(memory, { enabled: true, dbPath: join(dir, 'memory.db') })

  const registered = ctx.tools.schemas().map(s => s.name)
  const expectedTools = ['memory_recall', 'memory_remember', 'memory_feedback', 'memory_forget', 'memory_stats']
  for (const tool of expectedTools) {
    check(registered.includes(tool), `installed plugin registers ${tool}`)
  }
  check(registered.length === expectedTools.length,
    `and the model tool surface is exactly those ${expectedTools.length}`)

  const call = async (name, args, events = []) =>
    await ctx.tools.get(name).execute(args, {
      signal: new AbortController().signal,
      agent: { id: 'probe', session: { header: { cwd: dir }, events } },
    })

  const quote = '部署一律写到 F 盘，不要写 C 盘'
  const saved = await call(
    'memory_remember',
    { kind: 'experience', title: '部署目标盘', body: '部署一律写到 F 盘', quote, trigger: '部署' },
    [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: quote }] } }],
  )
  check(saved.status === 'confirmed', 'a verified claim is confirmed')
  const recalled = await call('memory_recall', { query: '部署' })
  check(recalled.returned === 1, 'and the installed plugin recalls it')

  // The resident text is what the agent actually sees every turn.
  const prompt = ctx.get('systemPrompt')
  check(prompt !== undefined, 'SystemPrompt is mounted')

  // The operator commands must be registered from the installed package too,
  // which is the half of the surface a tarball could silently lose.
  const commandAgent = { id: 'probe', session: { header: { cwd: dir }, events: [], append: () => {} } }
  for (const name of ['memory-status', 'memory-preview', 'memory-maintain', 'memory-audit', 'memory-import']) {
    const settled = await ctx.commands.execute(commandAgent, `/${name}`, [], new AbortController().signal)
    check(settled !== undefined, `installed plugin registers /${name}`)
  }
  const status = await ctx.commands.execute(commandAgent, '/memory-status', [], new AbortController().signal)
  check(status?.result.kind === 'success', 'and /memory-status answers')
  check(String(status?.result.text ?? '').includes('记录 1 条'), 'and sees the record just written')

  // ── Nothing accumulated ────────────────────────────────────────────────
  // This is also the hot-reload self-check a caller asked for. Every surface the plugin
  // contributes is registered through a fiber-scoped effect, so unloading the plugin
  // takes all three away again; if it ever stopped doing that, the symptom would be the
  // same names appearing twice, and this is what would show it. Run it after a reload.
  const descriptors = ctx.commands.list(commandAgent).map(entry => entry.name)
  const mine = descriptors.filter(name => name.startsWith('memory-'))
  check(new Set(mine).size === mine.length, `no command name is registered twice: ${mine.join(', ')}`)
  check(mine.length === 5, `the command surface is exactly five, not five per reload: ${mine.length}`)
  const contexts = (await ctx.systemPrompt.assemble({ agent: commandAgent })).contexts
    .map(entry => entry.name)
    .filter(name => name.startsWith('experience-memory:'))
  check(new Set(contexts).size === contexts.length, `no prompt context is contributed twice: ${contexts.join(', ')}`)
  check(contexts.length === 2, `the context surface is exactly two: ${contexts.join(', ')}`)

  // The build id, so the copy under test can be identified at all.
  check(/插件构建 [0-9a-f]{12}/.test(String(status?.result.text ?? '')),
    'and the report names the build the process loaded')

  await ctx.fiber.dispose()
  disposed = true
} finally {
  if (!disposed) await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}

// The count is printed by the script rather than quoted from a document: a number a
// human retypes is a number that goes stale, and one already did — a receipt said 27
// while every run printed 26 `ok` lines.
console.log(failed === 0
  ? `PASS installed package (${checked} checks)`
  : `FAIL installed package (${failed} of ${checked} checks failed)`)
process.exit(failed === 0 ? 0 : 1)
