#!/usr/bin/env node
/**
 * 拦截账：把"这条经验到底挡住了错没有"从一句口号变成一张能重跑的账。
 *
 * 它回答的是这个具体问题：**本工作区反复犯的每一类错，库里有没有一条声称覆盖它的记录；
 * 如果有，那条记录写完之后，这类错还犯了几次。**
 *
 * 判据不在这个文件里，在 `src/failure.ts`。这里只做三件事：取数、排版、可选落盘。
 * 这样同一套判据既能在会话里通过 `/memory-gaps` 跑到，也能被测试钉住，不会出现
 * "脚本算一套、命令算另一套"。
 *
 *   node tools/prevention-ledger.mjs [--db <路径>] [--cwd <工作区根>] [--min-count N] [--out <md 路径>]
 *
 * 不传 `--db` 时读插件的默认库（$DSH_HOME/experience-memory/memory.db）。
 * 只读打开：跑多少遍都不会改库。
 *
 * 三个必须说明的读数口径（不然会读错这张账）：
 *
 *   - **`count` 是这类错在本工作区累计出现过多少次**，跨会话累计，不是某段时间的速率。
 *   - **"记录前 / 记录后"用的是表里保留的最近若干次时间点**（有上限），所以是
 *     "最近 M 次里有 N 次发生在记录之后"，不是全生命周期计数。
 *   - **`bestScore` 是关键词重合数，不是"已覆盖"**。错误原文是英文、记录多半是中文，
 *     真正有用的一条也可能得 0 分。满分（等于关键词个数）才叫"这条记录在讲这件事"，
 *     而 `lessonNotWorking` 还要满足"至少 3 次发生在记录之后"才敢说它没挡住。
 */
import { existsSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { gapReport, LESSON_GRACE_MS, LESSON_IGNORED_MIN } from '../lib/failure.js'
import { resolveWorkspace } from '../lib/domain.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const number = (name, fallback) => {
  const raw = flag(name)
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const dbPath = flag('db') ?? defaultDbPath()
const cwd = flag('cwd') ?? process.cwd()
const minCount = number('min-count', 2)
const outPath = flag('out')

if (!existsSync(dbPath)) {
  console.error(`没有这个库：${dbPath}`)
  process.exit(2)
}

const workspace = resolveWorkspace(cwd, '')
const now = Date.now()
const db = new DatabaseSync(dbPath, { readOnly: true })

let rows
try {
  rows = gapReport(db, {
    workspaceId: workspace.id,
    domain: workspace.domain,
    now,
    limit: 200,
    minCount,
  })
} finally {
  db.close()
}

const stamp = ms => ms === undefined || ms === null
  ? '—'
  : new Date(Number(ms)).toLocaleString('sv-SE').slice(0, 16)
const clip = (text, max) => {
  const clean = String(text).replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

const lines = []
const say = text => lines.push(text === undefined ? '' : text)

say('# 拦截账：反复犯的错 vs 声称能防它的记录')
say('')
say(`- 库：\`${dbPath}\``)
say(`- 工作区：\`${workspace.root}\`（标识 \`${workspace.id}\`）`)
say(`- 领域：${workspace.domain === '' ? '（未设置，记录只在本工作区可见）' : `\`${workspace.domain}\``}`)
say(`- 统计范围：本工作区出现过 ≥${minCount} 次的失败形状`)
say(`- 生成时间：${stamp(now)}`)
say('')

if (rows.length === 0) {
  say(`本工作区没有出现过 ≥${minCount} 次的失败形状——没有可记账的对象。`)
}

let withRecord = 0
let fullMatch = 0
let notWorking = 0

for (const row of rows) {
  const shape = row.shape
  const recentBefore = row.closest === undefined
    ? 0
    : shape.recentAt.filter(at => at <= row.closest.createdAt).length
  const recentAfter = row.closest === undefined ? shape.recentAt.length : row.sinceRecord
  // The two readings that are always available, unlike the bounded timestamp list (which
  // this table does not retain until the shape has been seen enough times):
  const recurredAfter = row.closest !== undefined && shape.lastSeen > row.closest.createdAt
  const seenOnlyBefore = row.closest !== undefined && shape.lastSeen <= row.closest.createdAt
  const occurrencesAfter = row.closest === undefined
    ? 0
    : Math.max(row.sinceRecord, recurredAfter ? 1 : 0)
  const verdict = row.closest === undefined
    ? '没有对应记录'
    : row.bestScore < row.keywords.length
      ? `只是部分相关（命中 ${row.bestScore}/${row.keywords.length} 个检索词）`
      : row.lessonNotWorking
        ? `**记录之后又犯 ${occurrencesAfter} 次**`
        : recurredAfter
          ? `记录之后又犯过（本表保留的时间点里 ${row.sinceRecord} 次，不足 ${LESSON_IGNORED_MIN} 次，不下结论）`
          : seenOnlyBefore
            ? '记录写下之后再没出现过'
            : '无法判定（缺时间点）'

  if (row.closest !== undefined) withRecord += 1
  if (row.bestScore >= row.keywords.length && row.keywords.length >= 2) fullMatch += 1
  if (row.lessonNotWorking) notWorking += 1

  say(`## ${shape.tool} · ${clip(shape.shape, 90)}`)
  say('')
  say(`- 累计出现 **${shape.count}** 次，跨 **${shape.sessionIds.length}** 个会话；首次 ${stamp(shape.firstSeen)}，最近 ${stamp(shape.lastSeen)}`)
  say(`- 检索词：${row.keywords.map(word => `\`${word}\``).join('、') || '（无）'}`)
  if (row.closest === undefined) {
    say(`- 库里相关记录：**没有**（最相近的也得 0 分）`)
  } else {
    say(`- 最相近的记录：\`${row.closest.id}\` ${clip(row.closest.title, 60)}`)
    say(`  - 该记录写于 ${stamp(row.closest.createdAt)}；重合检索词 ${row.bestScore}/${row.keywords.length}`)
    say(recentBefore + recentAfter > 0
      ? `  - 本表保留的时间点里：记录前 ${recentBefore} 次 / 记录后 ${recentAfter} 次`
      : '  - 这个形状在生成这张账时还没有保留逐次时间点，所以只有"首次/最近"两个时间可用')
  }
  say(`- 判定：${verdict}`)
  if (row.closest !== undefined && row.bestScore >= row.keywords.length && row.keywords.length >= 2
    && now - row.closest.createdAt < LESSON_GRACE_MS) {
    say(`  - （这条记录写下还不到 1 小时，${LESSON_GRACE_MS / 60000} 分钟内不下"没挡住"的结论）`)
  }
  say('')
}

say('## 汇总')
say('')
say(`- 反复出现的失败形状：**${rows.length}** 类`)
say(`- 库里有相关记录的：**${withRecord}** 类`)
say(`- 检索词全命中的（这条记录确实在讲这件事）：**${fullMatch}** 类`)
say(`- 记录之后仍复发的（判为"没挡住"）：**${notWorking}** 类`)
say('')
say('读这张账要注意三件事：')
say('')
say('1. **"没有对应记录"不等于"经验没用"**，只说明这类错没有被写成经验；工具用法手滑类的错误，')
say('   错误信息本身就把做法写清楚了，框架当初判定"重复是手滑不是不知道"，是刻意不记的。')
say('2. **"记录后未再出现"不等于"被挡住了"**，可能只是这段时间没再触发。')
say('3. **部分相关**只看关键词重合；错误原文是英文、记录多是中文，真正有用的一条也可能得低分，')
say('   所以这一栏只能用来找线索，不能当结论。')

const text = lines.join('\n')
console.log(text)
if (outPath !== undefined) {
  writeFileSync(outPath, `${text}\n`, 'utf8')
  console.log('')
  console.log(`已写入：${outPath}`)
}
