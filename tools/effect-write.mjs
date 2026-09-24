#!/usr/bin/env node
/**
 * Turn a finished T2 round into `effect` values on the records that were tested.
 *
 * The deletion test answers "did this record change the outcome" for one record on one task, and
 * `tools/deletion-test.mjs` runs one of those. A full round runs every scenario against every arm,
 * so the same reading exists for each scenario in `tools/t2-results.jsonl` — and this tool is what
 * carries it from the results file into the store as `record.effect`, with the audit row that says
 * where the number came from.
 *
 * Four rules, and the first two are the ones that keep this honest:
 *
 *   1. **A ceiling or an unrun floor writes nothing.** Both arms passing, or neither arm managing
 *      to do the task at all, is a measurement that could not detect a difference; recording it as
 *      `effect = 0` ("measured as redundant") would be a lie with a number attached. But a floor
 *      where every arm *did* the task and nobody satisfied the judge is a genuine measured zero
 *      (the record was present and changed nothing) and it **is** written. Each case is printed
 *      with its reason, so nothing is silently skipped.
 *   2. **Placeholder rows do not count.** `seed-failed` / `no-result` / `watchdog-killed` rows say
 *      the cell did not happen; they leave the denominator alone rather than becoming a failure.
 *   3. **The record is found by the scenario's `relevantRecordTitle`,** exactly — the same match the
 *      seeder uses. If the title no longer exists in the store, it is reported and skipped.
 *   4. **Dry run unless `--apply`.** Writing `effect` is a data change to the user's live store, so
 *      it prints the store path first (the habit from the 271-record incident) and then, with
 *      `--apply`, writes one `noteCorrection` audit row per record saying which scenario and which
 *      two rates produced the number.
 *
 *   node tools/effect-write.mjs                          # dry run against tools/t2-results.jsonl
 *   node tools/effect-write.mjs --results tools/t2-results-r1.jsonl
 *   node tools/effect-write.mjs --apply
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = name => pathToFileURL(join(here, '..', 'lib', name)).href
const { defaultDbPath, getRecord, noteCorrection, openDb, upsert } = await import(lib('db.js'))
const { measureEffect, measurable, describeEffect } = await import(lib('effect.js'))

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const apply = args.includes('--apply')
const resultsPath = join(here, '..', flag('results') ?? 'tools/t2-results.jsonl')
const storePath = flag('db') ?? defaultDbPath()
const runsPerArm = Number(flag('runs') ?? 3)
// `--only <场景[,场景]>`：只给这些场景写。为什么要这个开关：一条记录只能存一个 effect，而同一场景
// 在不同模型上测出来的值不同（bom 在 mimo 上 +1.00、在 deepseek 上 +0.67）。没有这个开关，跑一次
// 新模型的结果就会**悄悄覆盖**旧模型的实测值；有了它，写哪一条是自己的决定，不是副作用。
const only = String(flag('only') ?? '').split(',').map(s => s.trim()).filter(s => s !== '')

// Habit from the 271-record incident: say which store is about to change before anything else.
console.log(`store  : ${storePath}`)
console.log(`results: ${resultsPath}`)
console.log(`mode   : ${apply ? 'APPLY（会写库）' : 'dry run（不写库）'}`)
if (!existsSync(resultsPath)) {
  console.error(`没有结果文件：${resultsPath}`)
  process.exit(2)
}
if (!existsSync(storePath)) {
  console.error(`没有库文件：${storePath}`)
  process.exit(2)
}

const spec = JSON.parse(readFileSync(join(here, 't2-scenarios.json'), 'utf8'))
const rows = readFileSync(resultsPath, 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => {
    try { return JSON.parse(line) } catch { return undefined }
  })
  .filter(row => row !== undefined)

/** Per (scenario, arm), count the runs that happened, how many passed, and whether the arm ever
 * actually completed the task (`task_done`). The last decides whether a 0/n is a floor (nobody
 * could do it — no information) or a measured zero (they did the job; the record changed nothing,
 * which is a real finding — tools/t2-plan.md §4.8.3). */
function tally(scenarioId, arm) {
  let pass = 0
  let ran = 0
  let placeholders = 0
  let timedOut = 0
  let taskDone = false
  const models = new Set()
  for (const row of rows) {
    if (String(row.scenario) !== scenarioId || String(row.arm) !== arm) continue
    const run = Number(row.run)
    if (!Number.isSafeInteger(run) || run < 1 || run > runsPerArm) continue
    if (/^(seed-failed|no-result|watchdog-killed)/.test(String(row.note ?? ''))) { placeholders += 1; continue }
    ran += 1
    if (row.pass === true) pass += 1
    if (row.timeout === true) timedOut += 1
    if (row.task_done === true) taskDone = true
    if (typeof row.model === 'string' && row.model !== '') models.add(row.model)
  }
  return { pass, ran, placeholders, timedOut, taskDone, models: [...models] }
}

// A dry run must not change *anything*, and that includes the schema: `openDb` migrates, so opening
// the live store through it would have added the `effect` column and bumped `user_version` merely to
// print a plan. Dry runs therefore go read-only, and only `--apply` opens the store writable.
const db = apply ? openDb(storePath) : new DatabaseSync(storePath, { readOnly: true })
const planned = []
console.log('')
console.log('| 场景 | 不给记录 | 给记录 | 读数 | 处置 |')
console.log('|---|---|---|---|---|')
for (const scenario of spec.scenarios) {
  const without = tally(scenario.id, 'none')
  const withRecord = tally(scenario.id, 'rel')
  const measurement = measureEffect({ without, withRecord })
  const node = db.prepare('SELECT id FROM record WHERE title = ? AND status = \'confirmed\' ORDER BY created_at DESC').get(scenario.relevantRecordTitle)
  const id = node === undefined ? undefined : String(node.id)
  // 这一轮跑的是哪个模型（结果行里有 `model` 字段）。它进审计行，因为同一个场景在不同模型上测出来的
  // 值不同，而记录里只能存一个数：事后必须能看出这个数是哪台模型测的。
  const models = [...new Set([...without.models, ...withRecord.models])]

  let action
  if (only.length > 0 && !only.includes(scenario.id)) {
    action = '不在 --only 名单里 ⇒ 不写（不动它已经有的实测值）'
  } else if (runsPerArm > 0 && (without.ran < runsPerArm || withRecord.ran < runsPerArm)) {
    action = `未跑完（${String(without.ran)}/${String(withRecord.ran)} 格）⇒ 不写`
  } else if (!measurable(measurement)) {
    action = `没判别力（${measurement.degenerateWhy || '次数不够'}）⇒ 不写`
  } else if (id === undefined) {
    action = '库里找不到这条记录（按标题精确匹配）⇒ 不写'
  } else {
    planned.push({ scenario, id, measurement, without, withRecord, models })
    action = `${apply ? '写入' : '将写入'} ${id}  effect = ${measurement.effect > 0 ? '+' : ''}${measurement.effect.toFixed(2)}`
  }
  console.log(`| ${scenario.id} | ${String(without.pass)}/${String(without.ran)} | ${String(withRecord.pass)}/${String(withRecord.ran)} | ${describeEffect(measurement)} | ${action} |`)
}

console.log('')
if (planned.length === 0) {
  console.log('没有任何场景的读数是可写的。这不是失败：地板/天花板本来就不该被记成 0。')
  db.close()
  process.exit(0)
}
for (const item of planned) {
  const record = getRecord(db, item.id)
  if (record === undefined) continue
  const reason = `deletion-test effect=${item.measurement.effect.toFixed(2)} `
    + `(with ${String(item.withRecord.pass)}/${String(item.withRecord.ran)} vs without ${String(item.without.pass)}/${String(item.without.ran)}, `
    + `scenario ${item.scenario.id}, judge ${item.scenario.judge}`
    + `${item.models.length > 0 ? `, model ${item.models.join('+')}` : ''}`
    // 这句话只在**真的测出 0**时才写。第一次写成"两侧都做完任务"就加，于是 effect=+1.00 的审计行
    // 末尾挂着"测出来的 0"——解释和数字打架，靠读的人自己分辨是错的。
    + `${item.without.taskDone && item.withRecord.taskDone && Math.abs(item.measurement.effect) < 1e-9 ? ', 两侧都做完了任务、只是判据要求的行为没出现（测出来的 0，不是分辨不出）' : ''})`
  if (apply) {
    upsert(db, { ...record, effect: item.measurement.effect, updatedAt: Date.now() })
    noteCorrection(db, item.id, 'deletion-test', reason, Date.now())
    const back = getRecord(db, item.id)
    const ok = back !== undefined && back.effect !== null && Math.abs(back.effect - item.measurement.effect) < 1e-9
    console.log(`${ok ? '✅' : '❌'} ${item.id}  effect=${String(back?.effect)}  （审计：${reason}）`)
  } else {
    console.log(`· ${item.id} 当前 effect=${String(record.effect)} → 将变为 ${item.measurement.effect.toFixed(2)}`)
    console.log(`  审计行会是：${reason}`)
  }
}
db.close()
if (!apply) console.log('\n（dry run。加 --apply 才写库；写前建议先跑一次 node tools/snapshot.mjs。）')
