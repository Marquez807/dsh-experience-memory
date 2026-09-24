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
// `fam` 只对声明了 familyRecordTitles 的场景（T4）有意义：其余场景上它没跑过，
// 所以"这一格该不该存在"按场景决定，不能一律算成缺格。
// G5 的"一景多测"（`compare: 'aspects'`）臂是「none + 场景声明的 probeArms + 一条无关对照」。
const ARMS = ['none', 'rel', 'fam', 'ctrl1', 'ctrl2', 'ctrl3']
const BASE_ARMS = ['none', 'rel', 'ctrl1', 'ctrl2', 'ctrl3']
const probeArmsOf = scenario => (scenario?.probeArms ?? []).map(p => String(p.arm))
const expectArms = scenario => {
  if (scenario?.compare === 'rel-vs-fam') return ARMS
  if (scenario?.compare === 'aspects') return ['none', ...probeArmsOf(scenario), 'ctrl1']
  return BASE_ARMS
}
const RUNS = [1, 2, 3]

/**
 * 底板指纹的一致性判定（`t2-plan.md` §4.17）。
 *
 * 一轮里的所有格子必须来自**同一份冻结底板**：删除测试的全部意义是"两臂只差那一条记录"，
 * 底板一变，差值就不再只归因于那条记录。指纹由 `t2-run.ps1` 写进每一行结果。
 *
 * 旧结果行没有这个字段，所以缺字段**如实计数**，不假装它一致；指纹多于一个取值才是硬拦
 * （跨格不可比），只有一个取值但有行缺字段则降级成"不可完整核对"的警告。
 *
 * @param {Array<object>} rows
 * @returns {{values: string[], blocking: boolean, reviewable: boolean, missing: number, text: string}}
 */
function fingerprintVerdict(rows) {
  const values = []
  let missing = 0
  for (const row of rows) {
    const value = row.base_sha256
    if (typeof value !== 'string' || value.trim() === '' || value.trim() === 'unknown') missing += 1
    else values.push(value.trim())
  }
  const distinct = [...new Set(values)]
  const blocking = distinct.length > 1
  const reviewable = !blocking && missing === 0 && distinct.length === 1
  const text = distinct.length === 0
    ? `无（${missing} 行没有指纹字段）`
    : `${distinct.join(' / ')}（${distinct.length} 个取值，${values.length} 行有指纹，${missing} 行无）`
  return { values: distinct, blocking, reviewable, missing, text }
}

/**
 * `--selfcheck`：零配额的验收。
 *
 * 只验**新增的那部分判定逻辑**（不是整张报告）：指纹一致时允许出结论，指纹不唯一时必须拦住。
 * 断言写在代码里而不是另建夹具文件，是因为这两条就是全部新增行为，单独跑它不需要模型、不需要库。
 */
function selfCheck() {
  const row = (base, extra = {}) => ({ scenario: 's', arm: 'rel', run: 1, pass: true, base_sha256: base, ...extra })
  const cases = [
    ['指纹一致 ⇒ 允许出结论', [row('aaaa11112222'), row('aaaa11112222'), row('aaaa11112222')], { blocking: false, reviewable: true }],
    ['指纹不唯一 ⇒ 必须拦住', [row('aaaa11112222'), row('bbbb33334444')], { blocking: true, reviewable: false }],
    ['完全没有指纹（旧结果）⇒ 不拦但不可复核', [row(undefined), row(undefined)], { blocking: false, reviewable: false }],
    ['一个指纹 + 缺字段 ⇒ 不拦但不可复核', [row('aaaa11112222'), row(undefined)], { blocking: false, reviewable: false }],
    ['unknown 记成缺字段，不是一种指纹', [row('aaaa11112222'), row('unknown')], { blocking: false, reviewable: false }],
  ]
  let failed = 0
  for (const [name, rows, expect] of cases) {
    const got = fingerprintVerdict(rows)
    const ok = got.blocking === expect.blocking && got.reviewable === expect.reviewable
    if (!ok) failed += 1
    console.log(`${ok ? '✓' : '✗'} ${name}  → blocking=${got.blocking} reviewable=${got.reviewable}`)
  }
  // 回归：参数解析。这三条锁住的是**真实发生过**的静默 bug（没有 `--results` 时第一个位置参数被吃掉），
  // 修好不锁住等于没修——下一个改这段的人会原样写回来。
  const argCases = [
    ['没有 --results 时，第一个位置参数不许被吃掉（--selfcheck 曾经因此被吞）', ['--selfcheck'], ['--selfcheck']],
    ['有 --results 时，只摘掉它和它的值', ['tplcomment', '--results', 'x.jsonl'], ['tplcomment']],
    ['--results 在中间也不许吃掉别的', ['--results', 'x.jsonl', 'a', 'b'], ['a', 'b']],
    ['多个位置参数全部保留', ['a', 'b', 'c'], ['a', 'b', 'c']],
  ]
  for (const [name, input, expect] of argCases) {
    const got = positionalArgs(input)
    const ok = got.length === expect.length && got.every((v, i) => v === expect[i])
    if (!ok) failed += 1
    console.log(`${ok ? '✓' : '✗'} 参数解析：${name}  → [${got.join(', ')}]`)
  }
  const total = cases.length + argCases.length
  console.log(failed === 0 ? `\nselfcheck 全过（${total} 条）` : `\nselfcheck 失败 ${failed} 条`)
  process.exit(failed === 0 ? 0 : 1)
}

/**
 * 从 argv 里挑出"位置参数"，同时把 `--results <文件>` 这一对摘掉。
 *
 * **抽成函数是为了能被 `--selfcheck` 断言**：这里曾经有一个静默 bug——
 * `index !== flagAt && index !== flagAt + 1`，而没有 `--results` 时 `flagAt` 是 `-1`，
 * 于是 `flagAt + 1 === 0`，**第一个位置参数被吃掉**。实测后果：`--selfcheck` 被吞、
 * 直接跑成了整张报告；换成场景 id 就会"跳过某个场景"无声失效。
 */
function positionalArgs(argv) {
  const flagAt = argv.indexOf('--results')
  return argv.filter((arg, index) => flagAt === -1 || (index !== flagAt && index !== flagAt + 1))
}

const argv = process.argv.slice(2)
const flagAt = argv.indexOf('--results')
const resultsArg = flagAt === -1 ? undefined : argv[flagAt + 1]
// 没有 `--results` 时**一个位置参数都不许丢**（见上面 positionalArgs 的注释：这里踩过）。
const positional = positionalArgs(argv)
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
if (positional.includes('--selfcheck')) selfCheck()
const resultsPath = resultsArg === undefined
  ? join(here, 't2-results.jsonl')
  : (isAbsolute(resultsArg) ? resultsArg : join(here, '..', resultsArg))
if (!existsSync(resultsPath)) {
  console.error(`没有这个结果文件：${resultsPath}`)
  process.exit(2)
}

const spec = JSON.parse(readFileSync(join(here, 't2-scenarios.json'), 'utf8'))
const scenarioById = new Map(spec.scenarios.map(s => [s.id, s]))
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
// 指纹算在**所有**参与这一轮的行走上（含占位行）：占位行同样是从某份底板起的，漏掉它就会
// 把"底板换过"这件事看漏。
const fingerprint = fingerprintVerdict([...cells.values(), ...placeholders])

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
say(`- **底板指纹**：${fingerprint.text}`)
if (fingerprint.blocking) {
  say('- ⛔ **底板不唯一 ⇒ 跨格不可比，本轮不出结论**（明细照打，供定位是哪几格换了底板）。修法见 `tools/t2-plan.md` §4.17。')
} else if (!fingerprint.reviewable) {
  say('- ⚠️ 底板不能完整核对（有结果行没有指纹）⇒ 下面的结论只能当"当时的读数"，**不是可复核读数**。')
} else {
  say('- ✅ 底板可复核：所有格子来自同一份冻结底板。')
}
say('')
say('| 场景 | 组 | run1 | run2 | run3 | 通过 |')
say('|---|---|---|---|---|---|')
for (const scenario of scenarios) {
  for (const arm of expectArms(scenarioById.get(scenario))) {
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
if (fingerprint.blocking) {
  say('### 照冻结读法逐条对：**已拦住**（底板不唯一，不出结论）')
  say('')
  say('底板指纹多于一个取值 ⇒ 这一轮里有的格子不是从同一份底板起的。删除测试的全部意义是')
  say('"两臂只差那一条记录"，底板一变差值就不再只归因于那条记录，所以这里**不出通过/不通过的结论**。')
  say('修法：按 `tools/t2-plan.md` §4.17 先冻结底板，再重跑受影响的格子。')
  say('')
} else {
  say('### 照冻结读法逐条对（`tools/t2-plan.md` §一）')
  say('')
}
if (!fingerprint.blocking) for (const scenario of scenarios) {
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
  // ── T4：合并版 vs 分开版（`compare: "rel-vs-fam"`）────────────────────────
  // 这一格的读法与上面不同：上面问"这条经验有没有用"，这里问"**把多条合成一条**值不值"。
  // 判据先写后跑（docs/GROWTH.md G4）：合并版**至少不差**才算过；明显更差就是负结论。
  // 每臂只有 3 次，所以差 1 次是噪声，不许当成胜负——只报数字 + 方向。
  if (scenarioById.get(scenario)?.compare === 'rel-vs-fam') {
    const fam = rate(scenario, 'fam')
    const done = none.ran === 3 && rel.ran === 3 && fam.ran === 3
    const relRate = rel.ran === 0 ? 0 : rel.pass / rel.ran
    const famRate = fam.ran === 0 ? 0 : fam.pass / fam.ran
    const noneRateT4 = none.ran === 0 ? 0 : none.pass / none.ran
    let v
    if (!done) v = '未跑完（none/rel/fam 各 3 次要齐），不下结论'
    else if (noneRateT4 >= relRate && noneRateT4 >= famRate) v = `无信号 · 天花板/地板：什么都不喂也拿到 ${rateText(noneRateT4)} ⇒ 这一格没有判别力，不下结论`
    else if (rel.pass >= 3 && fam.pass <= 1 && none.pass <= 1) v = '✅ 合并版**明显更好**：三臂分离'
    else if (fam.pass >= 3 && rel.pass <= 1) v = '❌ 合并版**明显更差** ⇒ 合并无收益，记为负结论'
    else if (Math.abs(rel.pass - fam.pass) <= 1) v = `打平/不可判（差 ≤1 次，n=3）⇒ 只能说"合并没有明显收益"，不能说更好`
    else if (rel.pass > fam.pass) v = `倾向合并版更好（+${rel.pass - fam.pass}/3，方向性，样本太小）`
    else v = `倾向分开版更好（+${fam.pass - rel.pass}/3，方向性，样本太小）`
    say(`- **${scenario}**（T4 合并 vs 分开）：合并版 rel ${rel.text} vs 分开版 fam ${fam.text} vs 不喂 none ${none.text} ⇒ ${v}`)
    continue
  }
  // ── G5 的"一景多测"：分项对照 + 每条记录的效果 ─────────────────────────────
  // 效果的定义就是删除测试的定义：**有它 减 没有它**，只不过单位是"臂自己那一项的通过率"。
  // 没有记录指向的项（ps1_exists / ps1_chinese）只当"有没有干活"看，不算效果。
  if (scenarioById.get(scenario)?.compare === 'aspects') {
    const s = scenarioById.get(scenario)
    const probes = s.probeArms ?? []
    const aspectNames = [...new Set(probes.map(p => String(p.aspect)))]
    const rateOf = (arm, aspect) => {
      const list = RUNS.map(r => cells.get(`${scenario}|${arm}|${r}`)).filter(row => row !== undefined)
      if (list.length === 0) return null
      return list.filter(row => row.aspects?.[aspect] === true).length / list.length
    }
    const show = v => (v === null ? '—' : `${(v * 100).toFixed(0)}%`)
    // 天花板告警：`none` 臂在所有分项上全对 ⇒ 这一族记录的效果在这一格**测不出来**。
    // 这不是"记录没用"，是"任务太容易，模型自己就会"。必须显式说出来，否则 effect=0 会被读成
    // "这些记录没价值"，而真相是这个场景没有判别力（T2 前几轮删过两个天花板场景，同一个病）。
    const noneAllPerfect = aspectNames.length > 0 && aspectNames.every(a => rateOf('none', a) === 1)
    say(`- **${scenario}**（G5 一景多测，${probes.length} 条记录各占一个臂）`)
    if (noneAllPerfect) {
      say(`  - ⚠️ **天花板：none 臂在所有分项上都 100%**（${aspectNames.join('、')}）⇒ 这一族记录的效果`)
      say('    在这一格**测不出来**（不是"没用"）。换任务，或者换一族模型自己不会的记录，否则跑多少格都是 0。')
    }
    say('')
    say('  | 检查点 | none | 一条无关对照 | 各臂（记录） |')
    say('  |---|---|---|---|')
    for (const aspect of aspectNames) {
      const owners = probes.filter(p => String(p.aspect) === aspect).map(p => `${String(p.arm)}=${show(rateOf(String(p.arm), aspect))}`)
      say(`  | ${aspect} | ${show(rateOf('none', aspect))} | ${show(rateOf('ctrl1', aspect))} | ${owners.join(' · ')} |`)
    }
    say('')
    for (const p of probes) {
      const aspect = String(p.aspect)
      const withIt = rateOf(String(p.arm), aspect)
      const without = rateOf('none', aspect)
      const ctrl = rateOf('ctrl1', aspect)
      if (withIt === null || without === null) { say(`  - \`${p.arm}\` ${aspect}：未跑完，不下结论`); continue }
      const effect = withIt - without
      const sign = effect > 0 ? '+' : ''
      const verdict = Math.abs(effect) < 1e-9
        ? '**effect = 0** ⇒ 这条记录在这一项上**没有任何可测效果**（不是"没用"，是"测不出来"）'
        : (effect > 0 ? `effect ${sign}${effect.toFixed(2)} ⇒ 有正效果` : `effect ${sign}${effect.toFixed(2)} ⇒ **负效果**（有它反而更差）`)
      const ctrlNote = ctrl === null ? '' : `；无关对照 ${show(ctrl)}`
      say(`  - \`${p.arm}\`（管 ${aspect}）：有它 ${show(withIt)} vs 没有 ${show(without)}${ctrlNote} ⇒ ${verdict}`)
    }
    say('')
    continue
  }
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
let expectedCells = 0
for (const scenario of scenarios) {
  for (const arm of expectArms(scenarioById.get(scenario))) {
    for (const run of RUNS) {
      expectedCells += 1
      if (cells.get(`${scenario}|${arm}|${run}`) === undefined) missing.push(`${scenario}/${arm}/${run}`)
    }
  }
}
say(`未测或无效的格子：${missing.length} / ${expectedCells}`)
if (missing.length > 0 && missing.length <= 20) say(`  ${missing.join('、')}`)
if (skipped.size > 0) say(`跳过（预检门判定无判别力，未计入上表）：${[...skipped].join('、')}`)
