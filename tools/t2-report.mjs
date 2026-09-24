#!/usr/bin/env node
/**
 * Read `tools/t2-results.jsonl` and print the scenario × arm matrix. Read-only; no judgement beyond
 * numbers. The scenario list comes from `t2-scenarios.json`, so this file has no idea how many
 * scenarios a round has — 第一轮是 4 条场景，现在是 3 条（bom / jsonquote / wipeguard），报告跟着表走。
 *
 * 第一轮的 60 格留在 `tools/t2-results-r1.jsonl`（同一格式），不删：那一轮本身是有结论的
 * （见 `t2-plan.md` §一），只是场景数变了。本轮写的是 `t2-results.jsonl`，从空文件开始。
 *
 * What it enforces, because the raw file cannot:
 *
 *   - **one row per cell.** A cell is (scenario, arm, run). The last *valid* row wins, so a cell
 *     re-run after a fix replaces its earlier attempt instead of counting twice.
 *   - **placeholder rows never count.** `seed-failed` and `no-result` say the measurement did not
 *     happen. They are listed separately; a cell that only has one is reported as missing, not as
 *     a failure — an arm that never ran is not an arm that failed.
 *   - **timeouts are shown, not hidden.** `timeout: true` means the model did not finish inside
 *     the declared cap. The frozen reading counts that as "not done" (the judge looks at
 *     artefacts), but it is printed as ⏱ so it can never be read as a wrong answer.
 *
 *   node tools/t2-report.mjs [跳过的场景id ...]   # the matrix, as markdown
 *
 *   node tools/t2-report.mjs [跳过的场景id ...] [--results tools/t2-results.jsonl]   # markdown 表
 *
 * Scenario ids on the command line were **skipped on purpose** (the preflight gate judged them
 * incapable of telling the difference). Printing them as "未跑完，不下结论" reads as unfinished
 * work; printing them as 跳过 says what actually happened, and they drop out of the missing count.
 *
 * ⚠️ 参数只认"场景 id"，结果文件要用 `--results` 给。**踩过**：把 `tools/t2-results-r3.jsonl`
 * 直接当第二个位置参数传进来，它被当成"要跳过的场景名"，于是工具安静地读了**旧的结果文件**、
 * 打印出一张看起来正常的旧表（"读的哪个文件"当时也不在输出里）。所以现在：位置参数里只要出现
 * 像路径的东西（含 / 或 \ 或以 .jsonl 结尾）就直接报错退出，并且表头一定写清读的是哪个文件。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ARMS = ['none', 'rel', 'ctrl1', 'ctrl2', 'ctrl3']
const RUNS = [1, 2, 3]

const argv = process.argv.slice(2)
const flagAt = argv.indexOf('--results')
const resultsArg = flagAt === -1 ? undefined : argv[flagAt + 1]
const positional = argv.filter((arg, index) => index !== flagAt && index !== flagAt + 1)
if (resultsArg !== undefined && (resultsArg === undefined || resultsArg.trim() === '')) {
  console.error('--results 后面要给文件路径')
  process.exit(2)
}
const looksLikePath = arg => /[\\/]/.test(arg) || /\.jsonl$/i.test(arg)
const stray = positional.find(looksLikePath)
if (stray !== undefined) {
  console.error(`位置参数只放"要跳过的场景 id"，而「${stray}」看起来是文件路径。`)
  console.error('结果文件请用 --results 指定，例如：node tools/t2-report.mjs tplcomment --results tools/t2-results-r3.jsonl')
  process.exit(2)
}
const skipped = new Set(positional)
const resultsPath = resultsArg === undefined
  ? join(here, 't2-results.jsonl')
  : (isAbsolute(resultsArg) ? resultsArg : join(here, '..', resultsArg))
if (!existsSync(resultsPath)) {
  console.error(`没有这个结果文件：${resultsPath}`)
  process.exit(2)
}

const spec = JSON.parse(readFileSync(join(here, 't2-scenarios.json'), 'utf8'))
const scenarios = spec.scenarios.map(s => s.id).filter(id => !skipped.has(id))

const rows = readFileSync(resultsPath, 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  })
  .filter(row => row !== undefined)

const cells = new Map()
const placeholders = []
for (const row of rows) {
  const note = String(row.note ?? '')
  if (/^(seed-failed|no-result)/.test(note)) {
    placeholders.push(row)
    continue
  }
  cells.set(`${row.scenario}|${row.arm}|${row.run}`, row)
}

const mark = row => {
  if (row === undefined) return '·'
  if (row.pass === true) return '✓'
  return row.timeout === true ? '⏱' : '✗'
}
const rate = (scenario, arm) => {
  let pass = 0
  let ran = 0
  let timedOut = 0
  for (const run of RUNS) {
    const row = cells.get(`${scenario}|${arm}|${run}`)
    if (row === undefined) continue
    ran += 1
    if (row.pass === true) pass += 1
    if (row.timeout === true) timedOut += 1
  }
  return { pass, ran, timedOut, text: `${pass}/${ran}${timedOut > 0 ? ` (⏱${timedOut})` : ''}` }
}

const out = []
const say = line => {
  out.push(line)
  console.log(line)
}

say(`## T2 结果（读 ${relative(join(here, '..'), resultsPath).replace(/\\/g, '/')}；每格取最后一条有效行）`)
say('')
say('| 场景 | 组 | run1 | run2 | run3 | 通过 |')
say('|---|---|---|---|---|---|')
for (const scenario of scenarios) {
  for (const arm of ARMS) {
    const marks = RUNS.map(run => mark(cells.get(`${scenario}|${arm}|${run}`))).join(' | ')
    say(`| ${scenario} | ${arm} | ${marks} | ${rate(scenario, arm).text} |`)
  }
}
say('')
say('| 场景 | 不用经验 none | 对口经验 rel | 无关对照 ctrl1 | ctrl2 | ctrl3 | 对照合计 |')
say('|---|---|---|---|---|---|---|')
for (const scenario of scenarios) {
  const none = rate(scenario, 'none')
  const rel = rate(scenario, 'rel')
  const ctrls = ['ctrl1', 'ctrl2', 'ctrl3'].map(a => rate(scenario, a))
  const ctrlPass = ctrls.reduce((n, c) => n + c.pass, 0)
  const ctrlRan = ctrls.reduce((n, c) => n + c.ran, 0)
  say(`| ${scenario} | ${none.text} | ${rel.text} | ${ctrls[0].text} | ${ctrls[1].text} | ${ctrls[2].text} | ${ctrlPass}/${ctrlRan} |`)
}
say('')
say('### 照冻结读法逐条对（`tools/t2-plan.md` §一）')
say('')
for (const scenario of scenarios) {
  const none = rate(scenario, 'none')
  const rel = rate(scenario, 'rel')
  const ctrlRates = ['ctrl1', 'ctrl2', 'ctrl3'].map(a => rate(scenario, a))
  const ctrlPass = ctrlRates.reduce((n, c) => n + c.pass, 0)
  const ctrlRan = ctrlRates.reduce((n, c) => n + c.ran, 0)
  const complete = none.ran === 3 && rel.ran === 3 && ctrlRan === 9
  const relRate = rel.ran === 0 ? 0 : rel.pass / rel.ran
  const ctrlRate = ctrlRan === 0 ? 0 : ctrlPass / ctrlRan
  const rateText = n => `${(n * 100).toFixed(0)}%`
  const noneRate = none.ran === 0 ? 0 : none.pass / none.ran
  // `task_done` (when the judge reports it) separates "nobody could do the task at all" from
  // "everybody did the task but nobody did the thing the lesson prescribes". The second is a real
  // negative result — the record was in the store and changed nothing — and reading it as a floor
  // (no information) would throw away the one finding that directly answers "can a lesson stop
  // a mistake". See tools/t2-plan.md §4.8.
  let taskDone = false
  for (const arm of ARMS) {
    for (const run of RUNS) {
      const row = cells.get(`${scenario}|${arm}|${run}`)
      if (row !== undefined && row.task_done === true) taskDone = true
    }
  }
  // Compare **rates**, never counts: three controls give nine trials against rel's three, and
  // 3/9 is not "as good as" 3/3. Comparing counts would void a scenario that passed.
  //
  // Five outcomes, and the two "no signal" ones matter. A scenario where nobody passes (a floor)
  // or where nobody needs the lesson (a ceiling) says nothing about whether the lesson works:
  // reading a floor as "the lesson failed" and a ceiling as "the controls were as necessary as
  // the lesson" are both wrong, and the second would void the whole experiment.
  let verdict
  if (!complete) verdict = '未跑完，不下结论'
  else if (rel.pass === 0 && none.pass === 0 && taskDone) verdict = `❌ 负结果：四个臂都把任务做出来了（task_done=true），但**判据要求的行为一个都没出现**——记录就在库里、内容含判据需要的规则，却没有改变任何行为。这不是"没信号"，是"有了这条记录也没用"的直接证据`
  else if (rel.pass === 0 && none.pass === 0) verdict = '无信号 · 地板：四个臂都没做出来（多为超时）⇒ 这条场景测不出差别'
  else if (rel.pass === none.pass) verdict = `无信号 · 天花板：不用经验也拿到 ${rateText(noneRate)}（与 rel 打平）⇒ 这条场景测不出差别`
  else if (rel.pass > none.pass && ctrlRate >= relRate) verdict = `❌ 对照 ${rateText(ctrlRate)} 不低于 rel ${rateText(relRate)} ⇒ 按冻结表最后一行，整体作废`
  else if (rel.pass > none.pass) verdict = `✅ rel ${rateText(relRate)} 优于 none ${rateText(noneRate)}，对照 ${rateText(ctrlRate)} 更低`
  else verdict = `✗ rel ${rateText(relRate)} 低于 none ${rateText(noneRate)} ⇒ 不支持`
  say(`- **${scenario}**：rel ${rel.text} vs none ${none.text} vs 对照 ${ctrlPass}/${ctrlRan}（${rateText(ctrlRate)}）⇒ ${verdict}`)
}
say('')
say(`无效行（占位、不计入）：${placeholders.length} 条`)
for (const row of placeholders.slice(0, 10)) {
  say(`  - ${row.scenario}/${row.arm}/${row.run} — ${row.note}`)
}
if (placeholders.length > 10) say(`  - …另有 ${placeholders.length - 10} 条`)
const missing = []
for (const scenario of scenarios) {
  for (const arm of ARMS) {
    for (const run of RUNS) {
      if (cells.get(`${scenario}|${arm}|${run}`) === undefined) missing.push(`${scenario}/${arm}/${run}`)
    }
  }
}
say(`未测或无效的格子：${missing.length} / ${scenarios.length * ARMS.length * RUNS.length}`)
if (missing.length > 0 && missing.length <= 20) say(`  ${missing.join('、')}`)
if (skipped.size > 0) say(`跳过（预检门判定无判别力，未计入上表）：${[...skipped].join('、')}`)
