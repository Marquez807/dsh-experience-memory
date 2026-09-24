#!/usr/bin/env node
/**
 * Copy one record by title from a source store into a target store, unchanged except for the
 * workspace it is scoped to.
 *
 *   node t2-seed.mjs --from <store> --to <store> --title "<exact title>" [--workspace <root>]
 *
 * `--workspace` matters more than it looks. A `scope: workspace` record is only visible inside the
 * workspace it was learned in, and the workspace id is a hash of the path — so copying a record
 * into a store without retargeting it makes it invisible to `memory_recall`, which then answers
 * "no matching experience" and the whole arm silently measures nothing. (This exact mistake was
 * made once before in this workspace; it was made again here.)
 *
 * Everything else travels with the record unchanged: the grade, the anchors and `recall_for`, so
 * the arm sees the record as it actually is in the live store and not a re-graded imitation.
 *
 * The destination is opened with `openDb`, not a bare `DatabaseSync`: the copy of the live store is
 * at whatever schema the *desktop* last migrated it to, and `upsert` writes every column the current
 * build knows about. A raw handle therefore throws "table record has no column named effect" the day
 * a column is added — which is exactly what happened (exit 1, every rel arm reported seed-failed).
 * `openDb` runs the migration first, so a new column cannot silently break seeding.
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

// 从**本文件**解析 lib，不用 process.cwd()：调用方可能在任何目录，而"按当前目录找自己的库"
// 正是 wipe.mjs 出过事故的那种脆弱（2026-09-23 实测：从工作区根调用就直接 ERR_MODULE_NOT_FOUND）。
const here = fileURLToPath(new URL('.', import.meta.url))
const lib = name => pathToFileURL(join(here, '..', 'lib', name)).href
const { openDb, upsert, toRecord } = await import(lib('db.js'))
const { resolveWorkspace } = await import(lib('domain.js'))

const argv = process.argv.slice(2)
const flag = n => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1] }
const from = flag('from'), to = flag('to'), wsRoot = flag('workspace')
// 标题优先从文件读：PowerShell 把参数交给原生程序时会重写引号，标题里只要有英文双引号
// 就会被吃掉（2026-09-23 实测：ctrl2 那条含 "适用哪次调用"，exit 2 查不到记录）。
// 从命令行传标题只在没有双引号时可靠；文件是唯一稳的过法。
//
// **一个文件可以装多条标题**（一行一条，空行忽略）：T4 要比较"3 条分开喂 vs 1 条合并喂"，
// 分开那一臂就得一次播多条。仍然走文件，理由同上。
const titleFile = flag('title-file')
const titles = titleFile !== undefined
  ? readFileSync(titleFile, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  : [flag('title')].filter(t => t !== undefined)
if (titles.length === 0) {
  console.error('没有标题可播种：给 --title <标题> 或 --title-file <每行一条的文件>')
  process.exit(2)
}

const src = new DatabaseSync(from, { readOnly: true })
const dst = openDb(to)
let failed = 0
for (const title of titles) {
  const rows = src.prepare('SELECT * FROM record WHERE title = ?').all(title)
  if (rows.length === 0) {
    console.error(`没有标题完全等于「${title}」的记录`)
    failed += 1
    continue
  }
  // 先挑 confirmed，再挑最新。为什么不直接取最新：库里同一个标题可能**同时**有一条 retired 和一条
  // confirmed（实测「清库脚本必须先核对目标路径」两条相差 6 秒，取最新的那次是靠运气不是靠规则）。
  // 播进去一条 retired 记录，那条记忆根本不会被送出，而产物上与"库里没有记忆"一模一样 ——
  // 又是一次静默退化，和 §23.2 那个"播种失败静默退化成 none 臂"是同一类病。
  const rank = r => (r.status === 'confirmed' ? 1 : 0)
  const row = rows.sort((a, b) => rank(b) - rank(a) || Number(b.created_at) - Number(a.created_at))[0]
  if (row.status !== 'confirmed') {
    console.error(`标题「${title}」在库里只有 ${row.status} 状态的记录（${row.id}）：播进去等于没有记忆，拒绝播种`)
    failed += 1
    continue
  }

  const record = toRecord(row)
  if (wsRoot !== undefined && record.scope === 'workspace') {
    const ws = resolveWorkspace(wsRoot, '')
    record.workspaceId = ws.id
    record.domain = ws.domain
  }

  upsert(dst, record)
  console.log(`已播种：${record.id} [${record.status}/${record.evidence}] ws=${record.workspaceId} ${record.title.slice(0, 40)}`)
}
src.close()
dst.close()
// 整批的成败：任何一条没播进去就算失败。调用方（t2-run.ps1）只看退出码，而"少播了一条"
// 与"库里本来就没有记忆"在产物上一模一样——所以这里绝不能返回 0。
if (failed > 0) {
  console.error(`有 ${failed} 条没播进去（共 ${titles.length} 条）`)
  process.exit(1)
}
console.log(`共播种 ${titles.length} 条`)
