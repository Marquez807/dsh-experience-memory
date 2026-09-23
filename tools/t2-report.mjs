#!/usr/bin/env node
/**
 * Read `tools/t2-results.jsonl` and print the 4×5 matrix. Read-only; no judgement beyond numbers.
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
 *   node tools/t2-report.mjs            # the matrix, as markdown
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ARMS = ['none', 'rel', 'ctrl1', 'ctrl2', 'ctrl3']
const RUNS = [1, 2, 3]

const spec = JSON.parse(readFileSync(join(here, 't2-scenarios.json'), 'utf8'))
const scenarios = spec.scenarios.map(s => s.id)

const rows = readFileSync(join(here, 't2-results.jsonl'), 'utf8')
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

say('## T2 结果（读 tools/t2-results.jsonl；每格取最后一条有效行）')
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
  const direction = relRate > (none.ran === 0 ? 0 : none.pass / none.ran)
  // Compare **rates**, never counts: three controls give nine trials against rel's three, and
  // 3/9 is not "as good as" 3/3. Comparing counts here would void a scenario that passed.
  const controlsFlat = ctrlRan > 0 && ctrlRate >= relRate
  const verdict = !complete
    ? '未跑完，不下结论'
    : controlsFlat
      ? `❌ 对照 ${rateText(ctrlRate)} 不低于 rel ${rateText(relRate)} ⇒ 按冻结表最后一行，整体作废`
      : direction
        ? `✅ rel ${rateText(relRate)} 优于 none ${rateText(none.ran === 0 ? 0 : none.pass / none.ran)}，对照 ${rateText(ctrlRate)} 更低`
        : `✗ rel ${rateText(relRate)} 未优于 none`
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
