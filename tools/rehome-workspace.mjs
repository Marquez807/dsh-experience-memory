#!/usr/bin/env node
/**
 * Move a store's records to a different workspace identity — for a new machine, a new
 * drive letter, or a renamed directory.
 *
 * Why this exists and why nothing else covers it: see the module comment in
 * `src/rehome.ts`. In short — a workspace is identified by the hash of its **path**
 * (`domain.ts:27-29`), the store lives outside every repository, and `/memory-import`
 * only understands the archived runtime's `.memory` directories, keyed to the *old*
 * store's own root. So copying `memory.db` to another machine produces a store whose
 * 233 records are all invisible.
 *
 *   node tools/rehome-workspace.mjs --list
 *   node tools/rehome-workspace.mjs --census --path "F:\dsh主工作区"
 *   node tools/rehome-workspace.mjs --from-path "F:\dsh主工作区" [--to-path <新根>] [--apply]
 *
 * `--to-path` defaults to the current directory. Dry run unless `--apply`. The store path
 * and both identities are printed before anything is resolved, and the target is re-planned
 * afterwards so the result is read back rather than asserted.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = name => pathToFileURL(join(here, '..', 'lib', name)).href
const { defaultDbPath, openDb } = await import(lib('db.js'))
const { resolveWorkspace, workspaceId } = await import(lib('domain.js'))
const { applyRehome, censusWorkspaces, planRehome } = await import(lib('rehome.js'))

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const has = name => args.includes(`--${name}`)

const storePath = flag('db') ?? defaultDbPath()
const here_ = resolve(process.cwd())
const fromId = flag('from')
const toId = flag('to')
const fromPath = flag('from-path')
const toPath = flag('to-path')
const apply = has('apply')

if (fromId !== undefined && fromPath !== undefined) {
  console.error('--from 与 --from-path 只能给一个（id 是路径哈希，两者等价）')
  process.exit(2)
}

const db = openDb(storePath)
const now = Date.now()

// Habit 1 from the 271-record incident: announce the store before resolving anything else.
console.log(`store : ${storePath}`)
console.log(`mode  : ${apply ? 'APPLY（会写库）' : 'dry run（不写库）'}`)

if (has('list') || (fromId === undefined && fromPath === undefined)) {
  const rows = censusWorkspaces(db, now)
  console.log(`\n库里一共有 ${rows.length} 个工作区身份（身份 = 该工作区根目录路径的哈希）：\n`)
  for (const row of rows) {
    console.log(`- ${row.id}  记录 ${row.records}（已确认 ${row.confirmed}、现在可见 ${row.visible}）`)
  }
  console.log('\n要搬哪一个，用 --from-path <那个工作区的根目录> 或 --from <上面的 id> 指定；')
  console.log('目标默认是当前目录（--to-path 可覆盖）。')
  if (fromId === undefined && fromPath === undefined) {
    db.close()
    process.exit(0)
  }
}

const from = fromId ?? workspaceId(resolve(fromPath))
const target = resolve(toPath ?? here_)
const to = toId ?? workspaceId(target)
console.log(`from  : ${from}${fromPath === undefined ? '' : `  (${resolve(fromPath)})`}`)
console.log(`to    : ${to}${toId === undefined ? `  (${target})` : ''}`)

const plan = planRehome(db, from, to)
if (plan.same) {
  db.close()
  console.log('\n两边是同一个工作区身份——什么都不用做。')
  process.exit(0)
}
if (plan.records === 0 && plan.corroborations === 0) {
  db.close()
  console.error(`\n源身份 ${from} 在库里没有任何记录，也没有印证行——检查 --from-path 是不是当初那个目录。`)
  process.exit(3)
}

const workspace = resolveWorkspace(target)
console.log(`\n计划：`)
console.log(`- 记录：${plan.records} 条会改归属`)
console.log(`- 印证行：${plan.corroborations} 行会跟着改（其中 ${plan.mergedCorroborations} 行目标已有同样内容，按同一件事合并）`)
console.log(`- 内容已存在于目标工作区的记录：${plan.collisions} 条（只报不改——合并两条记录的证据是判断，不是搬运）`)
if (workspace.domain !== '') {
  console.log(`\n注意：目标目录解析出的领域是「${workspace.domain}」，记录搬过去后领域字段不变；`)
  console.log('     搬完后若想让它们参与跨项目印证，要另外重新确认一次。')
} else {
  console.log(`\n注意：目标目录 ${target} 解析不出领域（没有 .dsh/memory.yml、package.json 或 git remote）——`)
  console.log('     记录照样可用，但只在这个目录里可见。')
}
if (plan.sample.length > 0) {
  console.log('\n最近写的几条（抽查，确认搬对了）：')
  for (const row of plan.sample) console.log(`- ${row.id}  ${row.title}`)
}
if (!apply) {
  db.close()
  console.log('\n（dry run。加 --apply 才写库；写之前建议先 `node tools/snapshot.mjs`。）')
  process.exit(0)
}

const result = applyRehome(db, from, to, now)
const after = planRehome(db, from, to)
const left = Number((db.prepare(
  "SELECT COUNT(*) AS n FROM record WHERE scope = 'workspace' AND workspace_id = ?",
).get(from) ?? { n: -1 }).n)
const arrived = Number((db.prepare(
  "SELECT COUNT(*) AS n FROM record WHERE scope = 'workspace' AND workspace_id = ?",
).get(to) ?? { n: -1 }).n)
const orphan = Number((db.prepare(
  'SELECT COUNT(*) AS n FROM corroboration WHERE workspace_id = ?',
).get(from) ?? { n: -1 }).n)
db.close()

console.log(`\n搬完：记录 ${result.records} 条、印证行 ${result.corroborations} 行（合并 ${result.mergedCorroborations} 行）`)
console.log(`回读：源身份还剩 ${left} 条记录、${orphan} 行印证；目标身份现有 ${arrived} 条记录`)
const ok = left === 0 && orphan === 0 && after.records === 0 && arrived >= result.records
console.log(ok ? '✅ 源身份已清空，目标身份已接手' : '❌ 回读与预期不符——请检查')
console.log('\n下一步：在那个新目录里跑 `/memory-status`，确认它看到的是同一个库、同一个身份。')
process.exit(ok ? 0 : 5)
