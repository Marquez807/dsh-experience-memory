#!/usr/bin/env node
/**
 * How many confirmed records have a `source_ref` that *exists* but does not support the claim?
 *
 * The evidence grader proves the quoted passage is in the cited file. It does not and cannot
 * prove the passage is *about* the claim — that is a semantic judgement, and the framework
 * deliberately makes no model calls. Section 17 of `docs/DELIVERY-GAPS.md` found real models
 * noticing the gap and discarding the record as a result, so the size of the gap is worth
 * knowing.
 *
 * This is a *mechanical* proxy, not the judgement itself. For every confirmed record it reports
 * which of three shapes the reference has, and it does so from the file content, so a reader can
 * check any row by hand:
 *
 *   - `missing`  — the cited file is not on disk (this is the shape the A/B found fatal);
 *   - `report`   — the cited file is a report/transcript (`.md`, `.jsonl`, `.log`), i.e. a record
 *                  of a finding rather than a rule the finding can be read off;
 *   - `code`     — the cited file is code or config, where a passage can state a rule directly.
 *
 * **Each record is resolved against its own workspace root, not the one passed in.** A record's
 * `workspace_id` is the hash of the root it was written under, and one store holds many
 * workspaces (six or more on this machine), so joining every record's relative path to a single
 * root reports files as missing that are sitting in the workspace that owns them. Measured
 * 2026-10-15, before this was fixed: 74 of the first 138 `missing` rows were exactly that, and
 * the flag it feeds (`src/lifecycle.ts`) wrote the same wrong conclusion into the store. Roots
 * cannot be looked up — the id is one-way — so they are enumerated by walking the tree and
 * recomputing each id; a record whose root is not in that tree is counted separately rather than
 * called missing.
 *
 *   node tools/provenance-audit.mjs --cwd <workspace root> [--out <md>] [--depth 2]
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { resolveWorkspace, workspaceId } from '../lib/domain.js'
import { CODE_SUFFIXES } from '../lib/anchors.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const dbPath = flag('db') ?? defaultDbPath()
const cwd = flag('cwd') ?? process.cwd()
const outPath = flag('out')
const depth = Number(flag('depth') ?? 2)

// Directories that cannot hold a workspace root and are expensive to walk.
const SKIP = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build',
  '.quant', '.bigfat', '_frozen', '.build-check', '.pnpm',
])
const SKIP_PREFIX = ['_升级前备份', 'data']

function candidateRoots(base, maxDepth) {
  const out = []
  const walk = (dir, level) => {
    if (level > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP.has(entry.name) || SKIP_PREFIX.some(p => entry.name.startsWith(p))) continue
      const child = join(dir, entry.name)
      out.push(child)
      walk(child, level + 1)
    }
  }
  walk(base, 1)
  return out
}

const workspace = resolveWorkspace(cwd, '')
const roots = new Map([[workspace.id, workspace.root]])
for (const dir of candidateRoots(workspace.root, depth)) roots.set(workspaceId(dir), dir)

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db.prepare(
  `SELECT id, title, source_ref, workspace_id
     FROM record WHERE status = 'confirmed' AND superseded_by IS NULL`,
).all()
db.close()

const suffixOf = path => {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

const counts = { missing: 0, report: 0, code: 0, none: 0, outside: 0, orphan: 0 }
const examples = { missing: [], report: [] }
let mine = 0
for (const row of rows) {
  const root = roots.get(String(row.workspace_id))
  if (root === workspace.root) mine += 1
  const ref = String(row.source_ref ?? '').trim()
  if (ref === '' || /^call_/i.test(ref)) { counts.none += 1; continue }
  if (isAbsolute(ref)) { counts.outside += 1; continue }
  const path = ref.replace(/:\d+(?::\d+)?$/, '').replace(/\\/g, '/')
  // A root this walk did not find: the relative path cannot be resolved, and calling it missing
  // would repeat the mistake this column exists to stop.
  if (root === undefined) { counts.orphan += 1; continue }
  const target = join(root, path)
  if (!existsSync(target)) {
    counts.missing += 1
    if (examples.missing.length < 12) examples.missing.push({ id: row.id, title: String(row.title).slice(0, 62), ref })
    continue
  }
  if (CODE_SUFFIXES.has(suffixOf(path))) { counts.code += 1; continue }
  counts.report += 1
  if (examples.report.length < 12) examples.report.push({ id: row.id, title: String(row.title).slice(0, 62), ref })
}

const total = rows.length
const pct = n => `${((n / total) * 100).toFixed(1)}%`
const lines = []
const say = text => lines.push(text === undefined ? '' : text)

say('# 出处体检：确认记录引用的文件，撑不撑得起它那句话')
say('')
say(`- 库：\`${dbPath}\``)
say(`- 写入者工作区：\`${workspace.root}\`（枚举到 ${roots.size} 个根，深度 ${depth}）`)
say(`- 确认记录：**${total}** 条，其中属于本工作区的 ${mine} 条，其余按各自的根解析`)
say('')
say('| 出处的形状 | 条数 | 占比 | 含义 |')
say('|---|---|---|---|')
say(`| 文件在磁盘上不存在 | ${counts.missing} | ${pct(counts.missing)} | 第十七节实测：模型会因此把整条记录判为不可信并丢弃 |`)
say(`| 文件是报告/日志（.md/.jsonl/.log） | ${counts.report} | ${pct(counts.report)} | 出处是"当时查出来的东西"，不是"能读出这条规则的原文" |`)
say(`| 文件是代码/配置 | ${counts.code} | ${pct(counts.code)} | 规则可能直接写在里面，是最好的一档 |`)
say(`| 没有出处或出处是 call id | ${counts.none} | ${pct(counts.none)} | 证据靠工具输出，本来就不指文件 |`)
say(`| 绝对路径（在库外） | ${counts.outside} | ${pct(counts.outside)} | 没法在工作区里核对 |`)
if (counts.orphan > 0) {
  say(`| 根未枚举到，无法判定 | ${counts.orphan} | ${pct(counts.orphan)} | 记录的工作区在这棵树之外；不当作缺失 |`)
}
say('')
if (examples.missing.length > 0) {
  say('## 出处文件不存在的（前 12 条）')
  say('')
  for (const row of examples.missing) say(`- \`${row.id}\` ${row.title} — 出处 \`${row.ref}\``)
  say('')
}
if (examples.report.length > 0) {
  say('## 出处是报告的（前 12 条）')
  say('')
  for (const row of examples.report) say(`- \`${row.id}\` ${row.title} — 出处 \`${row.ref}\``)
  say('')
}
say('**这张表只报形状，不判对错**：出处是报告不等于记录是错的，出处是代码也不等于引文支撑了主张。')
say('它给的是一个上界——**至少这么多条记录，其"已验证"只保证引文在文件里**。')

const text = lines.join('\n')
console.log(text)
if (outPath !== undefined) {
  writeFileSync(outPath, `${text}\n`, 'utf8')
  console.log(`\n已写入：${outPath}`)
}
