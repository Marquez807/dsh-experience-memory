/**
 * For each recalibrated failure, does a record even exist that *should* have fired?
 *
 * Coverage is 0%, and there are two very different reasons that could be true: no record covers
 * these failures, or records cover them but nothing locates the record on the call. The fix
 * differs completely — write the lesson, versus declare where it applies — so this separates them
 * by lexical search over the whole store (declared fields and body), then reports which records
 * came up and whether each one has an anchor today.
 *
 *   node tools/coverage-reach.mjs --cwd <workspace> [--top 15]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { resolveWorkspace } from '../lib/domain.js'
import { callFacts } from '../lib/anchors.js'
import { recordAnchors } from '../lib/criteria.js'
import { identifierKey, tokenize } from '../lib/tokenize.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const dbPath = flag('db') ?? defaultDbPath()
const cwd = flag('cwd') ?? process.cwd()
const callsPath = flag('calls') ?? join(process.cwd(), 'tools', 'calls.jsonl')
const top = Number(flag('top') ?? '15')

const workspace = resolveWorkspace(cwd, '')
const db = new DatabaseSync(dbPath, { readOnly: true })
const records = db.prepare(
  `SELECT id, title, trigger, failure_mode, lesson, body, source_ref
     FROM record WHERE status = 'confirmed' AND superseded_by IS NULL`,
).all().map(row => ({
  id: row.id,
  title: String(row.title),
  anchors: recordAnchors({ trigger: String(row.trigger ?? ''), sourceRef: String(row.source_ref ?? '') }, { derived: true }),
  terms: new Set(tokenize(`${row.title}\n${row.trigger ?? ''}\n${row.failure_mode ?? ''}\n${row.lesson ?? ''}\n${row.body ?? ''}`)),
}))
db.close()

const calls = readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))

const SELF_EXPLAINING = [
  'file has not been read', 'file changed since it was read', 'old_string was not found',
  'old_string matched', 'old_string and new_string must differ', 'file no longer exists', 'offset',
]
const attributable = calls.filter(c => c.failed === true && !SELF_EXPLAINING.some(m => String(c.error ?? '').includes(m)))
console.log(`可归因失败：${attributable.length}`)

let withCandidate = 0
let withCandidateAnchored = 0
const rows = []
for (const call of attributable) {
  const facts = callFacts(String(call.name ?? ''), call.arguments)
  const text = JSON.stringify(call.arguments ?? '')
  const terms = new Set(tokenize(text))
  // Records sharing at least two content terms with the failed call: a lead, not a verdict.
  const hits = []
  for (const record of records) {
    let shared = 0
    for (const term of terms) {
      if (term.length >= 3 && record.terms.has(term)) shared += 1
      if (shared >= 2) break
    }
    if (shared >= 2) hits.push(record)
  }
  if (hits.length > 0) withCandidate += 1
  const anchored = hits.filter(h => h.anchors.anchors.length > 0)
  if (anchored.length > 0) withCandidateAnchored += 1
  rows.push({ call, hits: hits.length, anchored: anchored.length, names: hits.slice(0, 3).map(h => h.title.slice(0, 46)), files: [...new Set(facts.paths.map(p => p.split(/[\\/]/).pop()))].slice(0, 3) })
}

console.log(`  有记录与它共享 ≥2 个实词（=库里有相关经验）：${withCandidate}（${(withCandidate / attributable.length * 100).toFixed(1)}%）`)
console.log(`  其中那条相关记录**已经有锚点**的：${withCandidateAnchored}（${(withCandidateAnchored / attributable.length * 100).toFixed(1)}%）`)
console.log('')
console.log('明细（前 N 条，看"相关记录有没有锚点"这一栏）：')
for (const row of rows.slice(0, top)) {
  const err = String(row.call.error ?? '').replace(/\s+/g, ' ').slice(0, 74)
  console.log(`  [${row.call.name}] ${err}`)
  console.log(`      调用里的文件：${row.files.join(', ') || '(无)'}　相关记录 ${row.hits} 条，其中有锚点的 ${row.anchored} 条`)
  for (const name of row.names) console.log(`        · ${name}`)
}
