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
 * **Each record is resolved against its own workspace root** (`./lib/provenance.mjs`), not the one
 * passed in: one store holds many workspaces, so joining every record's relative path to a single
 * root reports files as missing that are sitting in the workspace that owns them. Measured
 * 2026-10-15, before this was fixed: 138 missing, of which 74 were exactly that — and the check
 * that fed the same conclusion wrote it into the store (109 of 161 notes). A record whose root
 * this walk cannot find is reported as `orphan`, never as missing.
 *
 *   node tools/provenance-audit.mjs --cwd <workspace root> [--out <md>] [--depth 2]
 */
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { resolveWorkspace } from '../lib/domain.js'
import { auditProvenance } from './lib/provenance.mjs'
import { rootsById } from './lib/workspace-roots.mjs'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const dbPath = flag('db') ?? defaultDbPath()
const cwd = flag('cwd') ?? process.cwd()
const outPath = flag('out')
const depth = Number(flag('depth') ?? 2)

const workspace = resolveWorkspace(cwd, '')
const roots = rootsById(workspace.root, depth)

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db.prepare(
  `SELECT id, title, source_ref, workspace_id
     FROM record WHERE status = 'confirmed' AND superseded_by IS NULL`,
).all()
db.close()

const { counts, examples } = auditProvenance(rows, roots)
const mine = rows.filter(row => String(row.workspace_id) === workspace.id).length

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
