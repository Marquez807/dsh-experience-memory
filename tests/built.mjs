/**
 * Built-artifact acceptance test.
 *
 * This file is plain JavaScript and is run by node with NO experimental flag,
 * which is exactly how a consumer loads the published tarball: the shipped entry
 * must be real JavaScript under lib/, because Node refuses to strip TypeScript
 * types for files that live under node_modules.
 *
 * It proves what the source suite cannot:
 *   1. every emitted lib/ module resolves and imports (specifier rewriting worked);
 *   2. lib/ exports the same names as src/ (nothing was dropped by type stripping);
 *   3. the built plugin still behaves — same record/recall/retire semantics —
 *      when mounted into a real Cordis context;
 *   4. the packaging contract holds: what `files` promises is what exists, the
 *      entry point is inside the package, and no shipped module reaches back into
 *      the TypeScript sources. That last one is the defect this whole file exists
 *      to prevent: a shipped file importing `src/*.ts` cannot run at all from
 *      inside node_modules.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
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

// ── 0. The packaging contract ───────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
eq(JSON.stringify(manifest.files), JSON.stringify(['lib', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE']),
  'the shipped file list is exactly the runtime and its documents')
for (const entry of manifest.files) {
  check(existsSync(join(root, entry)), `every promised file exists: ${entry}`)
}
check(existsSync(join(root, manifest.main)), 'the entry point is inside the package')
check(manifest.dsh?.bundle?.patch !== undefined, 'the manifest declares a bundle patch')
check(existsSync(join(root, manifest.dsh.bundle.patch)), 'and that patch exists')
eq(manifest.license, 'UNLICENSED', 'the licence is stated rather than left absent')
check(existsSync(join(root, 'LICENSE')), 'and a LICENSE file ships with it')
check(manifest.peerDependencies['@deepseek-ai/dsh-commands'] !== undefined,
  'the command service is declared as a host-provided peer')

// A shipped module that reached into the sources would be unrunnable, and the
// requirement is not obvious from any single file, so it is asserted here.
for (const name of readdirSync(join(root, 'lib')).filter(entry => entry.endsWith('.js'))) {
  const text = readFileSync(join(root, 'lib', name), 'utf8')
  check(!/from\s+['"]\.\.\/src\//.test(text), `lib/${name} does not import the sources`)
  check(!/\.ts['"]/.test(text), `lib/${name} has no TypeScript specifier`)
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
  await ctx.plugin(Commands, {})
  await ctx.plugin(built, { enabled: true, dbPath: join(dir, 'memory.db') })

  const registered = ctx.tools.schemas().map(schema => schema.name)
  for (const tool of TOOLS) check(registered.includes(tool), `${tool} is registered from lib/`)
  eq(registered.length, TOOLS.length, 'and no operator command leaked into the model tool surface')

  // The built artifact registers its commands on the real service too, so a
  // build that dropped them would fail here rather than in a user's session.
  const commandAgent = { id: 'built-commands', session: { header: { cwd: dir }, events: [], append: () => {} } }
  const status = await ctx.commands.execute(commandAgent, '/memory-status', [], new AbortController().signal)
  check(status !== undefined, 'the built artifact registers /memory-status')
  eq(status?.result.kind, 'success', 'and it answers on the real command service')

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
