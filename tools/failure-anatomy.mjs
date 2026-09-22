/**
 * What the failures actually are, and which of them a 2%-budget trigger could ever reach.
 *
 * The coverage bar (≥15% of failures) can only be met by anchors that are *specific*. This
 * prints the two distributions that decide whether that is possible at all: which tool failed,
 * and how concentrated the file names in the failed calls are. A tool that fails 302 times is a
 * workflow problem, not a knowledge problem, and anchoring a lesson on it would be the magnet
 * disease the whole rewrite removed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseNameOf, callFacts } from '../lib/anchors.js'

const callsPath = process.argv[2] ?? join(process.cwd(), 'tools', 'calls.jsonl')
const calls = readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const failures = calls.filter(c => c.failed === true)

const byTool = new Map()
for (const call of failures) byTool.set(call.name, (byTool.get(call.name) ?? 0) + 1)
console.log(`失败 ${failures.length} / 调用 ${calls.length}\n`)
console.log('失败次数按工具：')
for (const [tool, n] of [...byTool.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${String(tool).padEnd(16)} ${(n / failures.length * 100).toFixed(1)}%`)
}

// How many *calls overall* carry each tool: an anchor is only specific if that share is small.
const toolShare = new Map()
for (const call of calls) toolShare.set(call.name, (toolShare.get(call.name) ?? 0) + 1)
console.log('\n同一工具在全部调用里的占比（锚在它上面等于按 2% 预算买多少触发）：')
for (const [tool, n] of [...toolShare.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(5)}  ${String(tool).padEnd(16)} ${(n / calls.length * 100).toFixed(2)}%`)
}

// Error text families: what class of mistake each failure belongs to.
const families = new Map()
for (const call of failures) {
  const text = String(call.error ?? '')
  const family = text
    .replace(/"[^"]*"/g, '"<x>"')
    .replace(/\b\d+\b/g, 'N')
    .slice(0, 90)
    .trim() || '(no text)'
  families.set(family, (families.get(family) ?? 0) + 1)
}
console.log('\n失败文本的前 12 类：')
for (const [family, n] of [...families.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(4)}  ${family}`)
}

// File names in failed calls, and how many *calls* mention each (the specificity test).
const fileNameCalls = new Map()
for (const call of calls) {
  const facts = callFacts(String(call.name ?? ''), call.arguments)
  for (const name of new Set(facts.paths.map(baseNameOf).filter(n => n !== ''))) {
    fileNameCalls.set(name, (fileNameCalls.get(name) ?? 0) + 1)
  }
}
const failNames = new Map()
for (const call of failures) {
  const facts = callFacts(String(call.name ?? ''), call.arguments)
  for (const name of new Set(facts.paths.map(baseNameOf).filter(n => n !== ''))) {
    failNames.set(name, (failNames.get(name) ?? 0) + 1)
  }
}
const rare = [...failNames.entries()]
  .filter(([name]) => (fileNameCalls.get(name) ?? 0) <= 0.02 * calls.length)
  .sort((a, b) => b[1] - a[1])
console.log(`\n失败调用里出现、且在整个语料里出现 ≤2% 的文件名（这些才是能进预算的锚点）：`)
let covered = 0
for (const [name, n] of rare.slice(0, 20)) {
  covered += n
  console.log(`  ${String(n).padStart(3)} 次失败  ${name}  （全书出现 ${fileNameCalls.get(name)} 次）`)
}
console.log(`  这些稀有文件名一共覆盖 ${covered} 次失败 = 失败的 ${(covered / failures.length * 100).toFixed(1)}%`)
