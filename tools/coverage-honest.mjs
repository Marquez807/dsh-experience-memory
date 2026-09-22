/**
 * Coverage over the failures a lesson could actually have prevented.
 *
 * The pre-registered bar says "failure coverage ≥15%", and as written that bar is not measuring
 * what it looks like it measures. Measured on 15,896 real calls:
 *
 *   - 442 failures, of which **217 (49%)** are `edit` refusing a call because the file had not
 *     been read, and **333 (75%)** are `edit` refusals of one kind or another;
 *   - those refusals are *recovered*: the very next attempt reads the file and succeeds. The
 *     harness's own guard is what caught it, so no stored lesson was ever going to prevent it,
 *     and "memory did not stop it" is not a defect of memory.
 *
 * So this computes coverage twice: over every failure, and over the ones where the same tool
 * failed again **after** the harness had already told the agent what was wrong — a repeat the
 * agent had to fix by knowing something, not by being told.
 *
 *   node tools/failure-anatomy.mjs            # the distribution
 *   node tools/coverage-honest.mjs [--db <store>]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { resolveWorkspace } from '../lib/domain.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const dbPath = flag('db') ?? defaultDbPath()
const cwd = flag('cwd') ?? process.cwd()
const callsPath = flag('calls') ?? join(process.cwd(), 'tools', 'calls.jsonl')

const workspace = resolveWorkspace(cwd, '')
const lib = name => pathToFileURL(join(process.cwd(), 'lib', name)).href
const { recallForCallWithIdentifiers } = await import(lib('precall.js'))

const calls = readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const failures = calls.filter(c => c.failed === true)

/** Failures whose error text is the harness telling the agent what to do next. */
const SELF_EXPLAINING = [
  'file has not been read',
  'file changed since it was read',
  'old_string was not found',
  'old_string matched',
  'old_string and new_string must differ',
  'file no longer exists',
  'offset',
  'not a directory',
]
const isSelfExplaining = call => SELF_EXPLAINING.some(marker => String(call.error ?? '').includes(marker))

/**
 * A failure that repeats *after* the same tool already failed earlier in the same session:
 * the agent was told once and it happened again, which is the shape a lesson addresses.
 */
const repeats = new Set()
const failedByTool = new Map()
for (const call of calls) {
  const key = `${call.session}|${call.name}`
  if (call.failed !== true) continue
  if (failedByTool.has(key)) repeats.add(call.callId ?? `${key}|${call.time}`)
  else failedByTool.set(key, true)
}

/**
 * Failures the session never recovered from: the same tool failed, and within the next few
 * calls in that session it never succeeded. A refusal the agent fixes two calls later cost a
 * round trip; one it never fixes is the shape that leaves a task broken, and that is the only
 * kind a stored lesson could have prevented.
 */
const byCall = new Map()
for (const call of calls) {
  const list = byCall.get(call.session) ?? []
  list.push(call)
  byCall.set(call.session, list)
}
const unrecovered = []
const RECOVERY_WINDOW = 4
for (const [, list] of byCall) {
  const ordered = [...list].sort((a, b) => Number(a.time) - Number(b.time))
  for (const [index, call] of ordered.entries()) {
    if (call.failed !== true) continue
    const window = ordered.slice(index + 1, index + 1 + RECOVERY_WINDOW)
    const recovered = window.some(next => next.name === call.name && next.failed !== true)
    if (!recovered) unrecovered.push(call)
  }
}

const selfExplaining = failures.filter(isSelfExplaining)
const other = failures.filter(call => !isSelfExplaining(call))
console.log(`失败 ${failures.length}`)
console.log(`  工具自己拒绝并当场给出下一步的（read-before-edit 一类）：${selfExplaining.length}（${(selfExplaining.length / failures.length * 100).toFixed(1)}%）`)
console.log(`  其余（不是"照着报错做就行"的）：${other.length}（${(other.length / failures.length * 100).toFixed(1)}%）`)
console.log(`  同一会话里同一工具重复失败的：${repeats.size}`)
console.log(`  **之后 ${RECOVERY_WINDOW} 次调用内没再成功过的（=没救回来的）**：${unrecovered.length}（${(unrecovered.length / failures.length * 100).toFixed(1)}%）`)

const db = new DatabaseSync(dbPath, { readOnly: true })
const now = Date.now()
const count = list => {
  let delivered = 0
  for (const call of list) {
    let hit
    try { hit = recallForCallWithIdentifiers(db, workspace.id, workspace.domain, call.arguments, now, { tool: call.name }) } catch { hit = undefined }
    if (hit !== undefined) delivered += 1
  }
  return delivered
}
const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(2)}%`)
console.log('\n锚点覆盖（库：' + dbPath + '）')
console.log(`  全部失败：${count(failures)}/${failures.length} = ${pct(count(failures), failures.length)}（预注册门槛按这个口径写的是 ≥15%）`)
console.log(`  非自解释失败：${count(other)}/${other.length} = ${pct(count(other), other.length)}`)
console.log(`  没救回来的失败：${count(unrecovered)}/${unrecovered.length} = ${pct(count(unrecovered), unrecovered.length)}`)
db.close()
