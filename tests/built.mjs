/**
 * Built-artifact acceptance test.
 *
 * This file is plain JavaScript and is run by node with NO experimental flag,
 * which is exactly how a consumer loads the published tarball: the shipped entry
 * must be real JavaScript under lib/, because Node refuses to strip TypeScript
 * types for files that live under node_modules.
 *
 * It proves three things the source suite cannot:
 *   1. every emitted lib/ module resolves and imports (specifier rewriting worked);
 *   2. lib/ exports the same names as src/ (nothing was dropped by type stripping);
 *   3. the built plugin still behaves — same record/recall/retire semantics —
 *      when mounted into a real Cordis context.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS = ['memory_recall', 'memory_remember', 'memory_feedback', 'memory_forget']

let failures = 0
const check = (ok, label) => {
  if (!ok) {
    failures += 1
    console.error(`    FAIL ${label}`)
  }
}
const eq = (actual, expected, label) => {
  check(Object.is(actual, expected), `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

// ── 1 + 2. Every module loads, and lib/ keeps the whole src/ surface ─────────
const srcNames = readdirSync(join(root, 'src')).filter(name => name.endsWith('.ts'))
const libNames = readdirSync(join(root, 'lib')).filter(name => name.endsWith('.js'))
eq(libNames.length, srcNames.length, 'lib/ has one module per src/ module')

for (const file of srcNames) {
  const stem = file.replace(/\.ts$/, '')
  const src = await import(pathToFileURL(join(root, 'src', file)).href)
  const lib = await import(pathToFileURL(join(root, 'lib', `${stem}.js`)).href)
  const missing = Object.keys(src).filter(key => !(key in lib))
  check(missing.length === 0, `lib/${stem}.js re-exports everything (missing: ${missing.join(', ')})`)
}

// ── 3. The built plugin works when mounted ──────────────────────────────────
const built = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
for (const key of ['name', 'inject', 'Config', 'apply']) {
  check(key in built, `the built entry exports ${key}`)
}

const dir = mkdtempSync(join(tmpdir(), 'expmem-built-'))
const ctx = new Context()
let disposed = false
try {
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(built, { enabled: true, dbPath: join(dir, 'memory.db') })

  const registered = ctx.tools.schemas().map(schema => schema.name)
  for (const tool of TOOLS) check(registered.includes(tool), `${tool} is registered from lib/`)

  const call = async (name, args, events = []) => {
    const definition = ctx.tools.get(name)
    check(definition !== undefined, `${name} resolves`)
    return await definition.execute(args, {
      signal: new AbortController().signal,
      agent: { id: 'built-session', session: { header: { cwd: dir }, events } },
    })
  }

  // An unverified claim stays a candidate and is never recalled.
  const weak = await call('memory_remember', { kind: 'experience', title: '部署目标盘', body: '部署一律写到 F 盘' })
  eq(weak.evidence, 'inferred', 'an unquoted claim is an inference')
  eq(weak.status, 'candidate', 'and stays a candidate')
  eq((await call('memory_recall', { query: '部署' })).returned, 0, 'a candidate is not recalled')

  // The same claim, quoted by the user, is verified and recalled.
  const quote = '部署一律写到 F 盘，不要写 C 盘'
  const verified = await call(
    'memory_remember',
    { kind: 'experience', title: '部署目标盘', body: '部署一律写到 F 盘', quote, trigger: '部署' },
    [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: quote }] } }],
  )
  eq(verified.evidence, 'verified-user', 'a verbatim user assertion verifies the claim')
  eq(verified.status, 'confirmed', 'so the record is confirmed')
  eq((await call('memory_recall', { query: '部署' })).returned, 1, 'the confirmed record is recalled')

  // Two consecutive failures retire it.
  await call('memory_feedback', { record_id: verified.id, outcome: 'failure' })
  const second = await call('memory_feedback', { record_id: verified.id, outcome: 'failure' })
  eq(second.outcome, 'retired', 'the second consecutive failure retires the record')
  eq((await call('memory_recall', { query: '部署' })).returned, 0, 'a retired record is not recalled')
  eq((await call('memory_recall', { query: '部署', include_retired: true })).returned, 1, 'an audit still sees it')

  await ctx.fiber.dispose()
  disposed = true
  const { DatabaseSync } = await import('node:sqlite')
  const reopened = new DatabaseSync(join(dir, 'memory.db'))
  reopened.close()
} finally {
  if (!disposed) await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? 'PASS built artifact' : `FAIL built artifact (${failures})`)
process.exit(failures === 0 ? 0 : 1)
