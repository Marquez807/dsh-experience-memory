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
 *   node tools/provenance-audit.mjs --cwd <workspace root> [--out <md>]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { resolveWorkspace } from '../lib/domain.js'
import { CODE_SUFFIXES } from '../lib/anchors.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const dbPath = flag('db') ?? defaultDbPath()
const cwd = flag('cwd') ?? process.cwd()
const outPath = flag('out')

const workspace = resolveWorkspace(cwd, '')
const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db.prepare(
  `SELECT id, title, source_ref, trigger, lesson, body
     FROM record WHERE status = 'confirmed' AND superseded_by IS NULL`,
).all()
db.close()

const suffixOf = path => {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

const counts = { missing: 0, report: 0, code: 0, none: 0, outside: 0 }
const examples = { missing: [], report: [] }
for (const row of rows) {
  const ref = String(row.source_ref ?? '').trim()
  if (ref === '' || /^call_/i.test(ref)) { counts.none += 1; continue }
  if (isAbsolute(ref)) { counts.outside += 1; continue }
  const path = ref.replace(/:\d+(?::\d+)?$/, '').replace(/\\/g, '/')
  const target = join(workspace.root, path)
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
say(`- 工作区：\`${workspace.root}\``)
say(`- 确认记录：**${total}** 条`)
say('')
say('| 出处的形状 | 条数 | 占比 | 含义 |')
say('|---|---|---|---|')
say(`| 文件在磁盘上不存在 | ${counts.missing} | ${pct(counts.missing)} | 第十七节实测：模型会因此把整条记录判为不可信并丢弃 |`)
say(`| 文件是报告/日志（.md/.jsonl/.log） | ${counts.report} | ${pct(counts.report)} | 出处是"当时查出来的东西"，不是"能读出这条规则的原文" |`)
say(`| 文件是代码/配置 | ${counts.code} | ${pct(counts.code)} | 规则可能直接写在里面，是最好的一档 |`)
say(`| 没有出处或出处是 call id | ${counts.none} | ${pct(counts.none)} | 证据靠工具输出，本来就不指文件 |`)
say(`| 绝对路径（在库外） | ${counts.outside} | ${pct(counts.outside)} | 没法在工作区里核对 |`)
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
