#!/usr/bin/env node
// Build step for dsh-experience-memory.
//
// The plugin is published as plain JavaScript under lib/ because Node refuses to
// strip TypeScript types for files that live under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Consumers install the packed
// tarball or the git repository, so the shipped entry must already be JavaScript
// — and because `lib/` is committed, it must also be *current*.
//
// Node's built-in type stripping is used instead of a bundler/dependency to keep
// the framework at zero third-party runtime *and* build dependencies. Because
// `stripTypeScriptTypes` never rewrites module specifiers, this script does that
// itself: every relative `./x.ts` specifier becomes `./x.js`.
//
//   node tools/build.mjs           emit lib/
//   node tools/build.mjs --check   verify lib/ matches src/ without writing it

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const outDir = join(root, 'lib')
const checkDir = join(root, '.build-check')

/** Matches `from './x.ts'`, `export * from './x.ts'` and `import('./x.ts')`. */
const SPECIFIERS = [
  /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+)\.ts\2/g,
  /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+)\.tsx\2/g,
]

async function walk(dir, accept) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await walk(full, accept)))
    else if (accept(entry.name)) found.push(full)
  }
  return found
}

/** Only `.ts` sources are inputs; `.d.ts` declarations carry no runtime code. */
const isSource = name => name.endsWith('.ts') && !name.endsWith('.d.ts')
const isOutput = name => name.endsWith('.js')

/** Strip types, rewrite specifiers, and write the result under `target`. */
async function emit(target, files) {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })

  let rewritten = 0
  for (const file of files) {
    const stripped = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' })
    let patched = stripped
    for (const pattern of SPECIFIERS) {
      patched = patched.replace(pattern, (_, lead, quote, spec) => {
        rewritten += 1
        return `${lead}${quote}${spec}.js${quote}`
      })
    }
    const destination = join(target, relative(srcDir, file).replace(/\.ts$/, '.js'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, patched, 'utf8')
  }
  return rewritten
}

/**
 * A leftover `.ts` specifier resolves in the source tree and fails for a
 * consumer, so the build refuses to succeed when one survives. A rewrite count of
 * zero means the rewriter never ran against real input, which is equally fatal.
 */
async function assertResolved(target, rewritten) {
  if (rewritten === 0) {
    console.error('build: no relative TypeScript specifiers were rewritten, which means the')
    console.error('       rewriter never ran against real input — refusing to publish.')
    return false
  }
  const leftovers = []
  for (const file of await walk(target, isOutput)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(['"])(\.\.?\/[^'"]+)\.tsx?\1/g)) {
      leftovers.push(`${relative(root, file)}: ${match[0]}`)
    }
  }
  if (leftovers.length === 0) return true
  console.error('build: unresolved TypeScript specifiers remain:')
  for (const item of leftovers) console.error(`  ${item}`)
  return false
}

const files = await walk(srcDir, isSource)
if (files.length === 0) {
  console.error('build: no TypeScript sources found under src/')
  process.exit(1)
}

// ── --check: is the committed lib/ still what src/ produces? ────────────────
if (process.argv.includes('--check')) {
  const rewritten = await emit(checkDir, files)
  const resolved = await assertResolved(checkDir, rewritten)
  const differences = []

  if (resolved) {
    const produced = (await walk(checkDir, isOutput)).map(file => relative(checkDir, file)).sort()
    const committed = existsSync(outDir)
      ? (await walk(outDir, isOutput)).map(file => relative(outDir, file)).sort()
      : []
    for (const name of produced) {
      const expected = join(outDir, name)
      if (!existsSync(expected)) differences.push(`missing from lib/: ${name}`)
      else if (readFileSync(expected, 'utf8') !== readFileSync(join(checkDir, name), 'utf8')) {
        differences.push(`stale: ${name}`)
      }
    }
    for (const name of committed) {
      if (!produced.includes(name)) differences.push(`not produced by src/: ${name}`)
    }
  }

  await rm(checkDir, { recursive: true, force: true })
  if (!resolved || differences.length > 0) {
    if (differences.length > 0) {
      console.error('build: lib/ does not match src/:')
      for (const item of differences) console.error(`  ${item}`)
    }
    console.error('build: run `node tools/build.mjs` and commit the result.')
    process.exit(1)
  }
  console.log(`build: lib/ is up to date (${files.length} module(s))`)
  process.exit(0)
}

// ── Default: emit lib/ ──────────────────────────────────────────────────────
const rewritten = await emit(outDir, files)
if (!(await assertResolved(outDir, rewritten))) process.exit(1)
console.log(`build: emitted ${files.length} module(s) to lib/ (${rewritten} specifier(s) rewritten)`)
