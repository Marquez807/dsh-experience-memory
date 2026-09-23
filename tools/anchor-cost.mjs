#!/usr/bin/env node
/**
 * How much would this anchor cost? Count its hits over the recorded call corpus.
 *
 * Why this exists: an anchor that looks precise on paper can match a third of everything. Two
 * records did exactly that in one night (docs/DELIVERY-GAPS.md 25) — `path:node_modules` matched
 * 702 of 15,896 calls and `tool:pwsh` matched 5,936 — and one record ended up owning 94.8% of every
 * hint the store delivered. Neither was visible from the anchor's spelling; both were obvious the
 * moment they were counted.
 *
 * Two modes:
 *
 *   node tools/anchor-cost.mjs path:src/db.ts tool:pwsh     # measure candidates
 *   node tools/anchor-cost.mjs --write-table                # regenerate src/anchor-cost-table.ts
 *
 * `--write-table` enumerates every anchor a caller could plausibly declare (tool names, paths and
 * their suffixes, command-line tokens), counts each over the corpus, and writes the ones at or
 * above the threshold into the generated module the plugin consults at write time. The threshold
 * defaults to 300 — the same number as the pre-registered per-record gate, so "one record may not
 * own more than the gate allows" is the same fact in both places.
 *
 * The counting mirrors `anchorSatisfied` rather than approximating it: a `path:` declaration with
 * directories matches by `endsWith`, so every directory-boundary suffix of an observed path is
 * counted too. A `command:` declaration matches by substring, and only whitespace tokens of the
 * command line are enumerated — a deliberate undercount, noted in the table's header, because the
 * alternative is counting every substring of every command.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const lib = name => pathToFileURL(join(root, 'lib', name)).href
const { anchorSatisfied, callFacts, parseAnchor } = await import(lib('anchors.js'))

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const writeTable = args.includes('--write-table')
const threshold = Number(flag('threshold', '300'))
const callsPath = join(here, 'calls.jsonl')

if (!existsSync(callsPath)) {
  console.error(`没有调用语料：${callsPath}\n先生成：python tools/session-calls.py --out tools/calls.jsonl`)
  process.exit(2)
}
const calls = readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line) } catch { return undefined }
}).filter(Boolean)
const facts = calls.map(call => callFacts(call.name, call.arguments))

// ── Measure the anchors named on the command line ───────────────────────────
if (!writeTable) {
  const candidates = args.filter(arg => !arg.startsWith('--') && Number.isNaN(Number(arg)))
  if (candidates.length === 0) {
    console.error('用法：node tools/anchor-cost.mjs <anchor> [<anchor> ...]')
    console.error('      node tools/anchor-cost.mjs --write-table [--threshold 300]')
    process.exit(2)
  }
  console.log(`语料：${calls.length} 次真实调用\n`)
  let worst = 0
  for (const raw of candidates) {
    const anchor = parseAnchor(raw)
    if (anchor === undefined) {
      console.log(`  ${raw.padEnd(50)} —— 不是合法锚点，跳过`)
      continue
    }
    let hits = 0
    for (const f of facts) if (anchorSatisfied(anchor, f)) hits += 1
    worst = Math.max(worst, hits)
    const share = (hits / calls.length) * 100
    const mark = hits >= threshold ? ` ❌ 单条就超过"<${threshold} 次"的门槛` : hits >= 100 ? ' ⚠️ 偏高' : ''
    console.log(`  ${raw.padEnd(50)} ${String(hits).padStart(6)} 次（${share.toFixed(2)}%）${mark}`)
  }
  if (worst >= threshold) {
    console.log('\n提示：这个锚点会让一条记录自己吃掉可观的提示预算。要么带目录/换成更专有的词，要么不声明锚点——')
    console.log('      不声明锚点的记录仍然进每轮摘要、仍然能被 memory_recall 搜到，只是不再"动手前"弹。')
  }
  process.exit(0)
}

// ── Enumerate candidates and write the table ────────────────────────────────
const counts = new Map()
const bump = key => counts.set(key, (counts.get(key) ?? 0) + 1)
const normalise = value => String(value).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

for (const f of facts) {
  if (f.tool !== '') bump(`tool:${f.tool}`)

  const seenPaths = new Set()
  for (const raw of f.paths) {
    const path = normalise(raw)
    if (path === '') continue
    const parts = path.split('/').filter(Boolean)
    // The declaration may be the whole path or any directory-boundary tail of it, and a bare
    // name matches on the basename — that is exactly what `anchorSatisfied` accepts.
    for (let i = 0; i < parts.length; i += 1) {
      const tail = parts.slice(i).join('/')
      if (!seenPaths.has(`path:${tail}`)) {
        seenPaths.add(`path:${tail}`)
        bump(`path:${tail}`)
      }
    }
  }

  if (f.command !== '') {
    const seen = new Set()
    for (const token of f.command.split(/\s+/)) {
      const clean = token.replace(/^[&"']+/, '').replace(/["']+$/, '')
      // Same shape rule as `commandToken()` in `src/anchors.ts`: a variable, a flag or an operator
      // is not a program name. Without it the table fills with `command:|`, `command:{`, `command:=`
      // — tokens nobody would declare, which only make the generated file harder to read.
      if (clean === '' || clean.startsWith('$') || clean.startsWith('-')) continue
      if (!/^[a-z0-9][a-z0-9._+-]*$/i.test(clean)) continue
      if (seen.has(clean)) continue
      seen.add(clean)
      bump(`command:${clean}`)
    }
  }
}

const expensive = [...counts.entries()]
  .filter(([, hits]) => hits >= threshold)
  .sort((a, b) => b[1] - a[1])

const generatedAt = new Date().toISOString()
const lines = [
  '/**',
  ' * Generated by `node tools/anchor-cost.mjs --write-table`. Do not edit by hand.',
  ' *',
  ` * Corpus: ${relative(root, callsPath).replace(/\\/g, '/')} — ${calls.length} real tool calls.`,
  ` * Threshold: ${threshold} hits, i.e. the same number as the pre-registered per-record gate`,
  ' * (`docs/DELIVERY-GAPS.md` §5), so "one record may not own more hints than the gate allows"',
  ' * is one fact in both places rather than two.',
  ' *',
  ' * A snapshot, not a live measurement: calls change, so regenerate when the corpus does. The',
  ' * plugin fails **open** when this file is missing or empty — a stale table can only be too',
  ' * strict about a token that has since become rare, never silently permissive.',
  ' *',
  ` * Known undercount: \`command:\` costs count whitespace tokens only, while matching is by`,
  ' * substring, so a rare substring declaration can cost more than its entry says.',
  ' */',
  `export const ANCHOR_COST_TABLE = {`,
  `  generatedAt: '${generatedAt}',`,
  `  corpus: '${relative(root, callsPath).replace(/\\/g, '/')}',`,
  `  calls: ${calls.length},`,
  `  thresholdHits: ${threshold},`,
  '  tokens: {',
  ...expensive.map(([anchor, hits]) => `    '${anchor}': ${hits},`),
  '  },',
  '}',
  '',
]
const target = join(root, 'src', 'anchor-cost-table.ts')
writeFileSync(target, lines.join('\n'), 'utf8')

console.log(`语料：${calls.length} 次调用，候选 token ${counts.size} 个`)
console.log(`≥ ${threshold} 次的：${expensive.length} 个 → ${relative(root, target).replace(/\\/g, '/')}`)
for (const [anchor, hits] of expensive.slice(0, 12)) {
  console.log(`  ${anchor.padEnd(46)} ${String(hits).padStart(6)} 次（${(hits / calls.length * 100).toFixed(2)}%）`)
}
if (expensive.length > 12) console.log(`  …另有 ${expensive.length - 12} 个`)
