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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as memory from 'dsh-experience-memory'

let failed = 0
const check = (ok, label) => {
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
  await ctx.plugin(memory, { enabled: true, dbPath: join(dir, 'memory.db') })

  const registered = ctx.tools.schemas().map(s => s.name)
  for (const tool of ['memory_recall', 'memory_remember', 'memory_feedback', 'memory_forget']) {
    check(registered.includes(tool), `installed plugin registers ${tool}`)
  }

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

  await ctx.fiber.dispose()
  disposed = true
} finally {
  if (!disposed) await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed === 0 ? 'PASS installed package' : `FAIL installed package (${failed})`)
process.exit(failed === 0 ? 0 : 1)
