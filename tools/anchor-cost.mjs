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
 * So: before declaring an anchor, count it.
 *
 *   node tools/anchor-cost.mjs path:src/db.ts tool:pwsh command:git
 *
 * The corpus comes from `tools/session-calls.py` (15,896 real calls at the time of writing). The
 * number to read is not "is it nonzero" but "how many of my future calls will this interrupt".
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = name => pathToFileURL(join(here, '..', 'lib', name)).href
const { anchorSatisfied, callFacts, parseAnchor } = await import(lib('anchors.js'))

const callsPath = join(here, 'calls.jsonl')
if (!existsSync(callsPath)) {
  console.error(`没有调用语料：${callsPath}\n先生成：python tools/session-calls.py --out tools/calls.jsonl`)
  process.exit(2)
}
const candidates = process.argv.slice(2)
if (candidates.length === 0) {
  console.error('用法：node tools/anchor-cost.mjs <anchor> [<anchor> ...]（形如 path:a/b.ts、tool:read、command:git）')
  process.exit(2)
}

const calls = readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line) } catch { return undefined }
}).filter(Boolean)
const facts = calls.map(call => callFacts(call.name, call.arguments))

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
  const flag = hits >= 300 ? ' ❌ 单条就超过"<300 次"的门槛' : hits >= 100 ? ' ⚠️ 偏高' : ''
  console.log(`  ${raw.padEnd(50)} ${String(hits).padStart(6)} 次（${share.toFixed(2)}%）${flag}`)
}
if (worst >= 300) {
  console.log('\n提示：这个锚点会让一条记录自己吃掉可观的提示预算。要么带目录/换成更专有的词，要么不声明锚点——')
  console.log('      不声明锚点的记录仍然进每轮摘要、仍然能被 memory_recall 搜到，只是不再"动手前"弹。')
}
