#!/usr/bin/env node
/**
 * Run one controlled deletion test: the same task with a record and without it, then say what changed.
 *
 * `docs/GROWTH.md` §四 asks for exactly this and calls it the ground the rest of the growth route
 * stands on: "don't judge from the text, run it — replay the turn, take the record away, and see
 * whether the result changes". `tools/verified-user-ab/` was one scenario's A/B; this is the same
 * runner pointed at one record on one task, with the arithmetic in `src/effect.ts` rather than in
 * prose.
 *
 * It shells out to `tools/t2-run.ps1`, which owns the isolation (a temporary DSH home, a guarded
 * wipe, an exit-code-checked seed) and the judging (artifacts only, never what the model said). This
 * tool adds the two arms and the reading:
 *
 *   node tools/deletion-test.mjs --scenario bom --runs 3
 *   node tools/deletion-test.mjs --scenario bom --runs 3 --json      # machine-readable only
 *
 * **Do not run this while `tools/t2-sweep.ps1` is running.** Both drive the same isolated DSH home
 * (`%TEMP%\dsh-t2\home`) and the same store inside it; two concurrent cells would share one memory
 * database and quietly measure each other's seeds. That is the failure the harness already hit once
 * (three or four cells alive at the same time after a cap that never fired).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = name => pathToFileURL(join(here, '..', 'lib', name)).href
const { measureEffect, measurable, describeEffect, MIN_EFFECT_RUNS } = await import(lib('effect.js'))

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const asJson = args.includes('--json')
const scenarioId = flag('scenario')
const runs = Number(flag('runs') ?? 3)

if (scenarioId === undefined) {
  console.error('需要 --scenario <id>（可选 --runs N，默认 3）')
  process.exit(2)
}
if (!Number.isSafeInteger(runs) || runs < 1) {
  console.error(`--runs 必须是 >=1 的整数，收到 ${String(flag('runs'))}`)
  process.exit(2)
}
const spec = JSON.parse(readFileSync(join(here, 't2-scenarios.json'), 'utf8'))
const scenario = spec.scenarios.find(s => s.id === scenarioId)
if (scenario === undefined) {
  console.error(`场景表里没有「${scenarioId}」。现有：${spec.scenarios.map(s => s.id).join(' / ')}`)
  process.exit(2)
}

/** Run one cell and return its result object, or a placeholder explaining why there is none. */
function cell(arm, run) {
  const script = join(here, 't2-run.ps1')
  let raw = ''
  try {
    raw = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Scenario', scenarioId, '-Arm', arm, '-Run', String(run)], { encoding: 'utf8' })
  } catch (error) {
    // A non-zero exit from t2-run.ps1 is a *harness* outcome (wipe refused, seed failed, launch
    // failed) and it prints its own JSON line before exiting. Keep whatever it said.
    raw = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const line = raw.split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).pop()
  if (line === undefined) return { arm, run, ran: false, why: '这一格没有输出（没跑起来）' }
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return { arm, run, ran: false, why: `这一格的输出不是 JSON：${line.slice(0, 80)}` }
  }
  return { arm, run, ran: true, pass: parsed.pass === true, note: String(parsed.note ?? ''), row: parsed }
}

if (!asJson) {
  console.log(`场景 : ${scenarioId} —— ${scenario.why}`)
  console.log(`判据 : ${scenario.judge}`)
  console.log(`记录 : ${scenario.relevantRecordTitle}`)
  console.log(`臂   : none（不给记录） × ${runs}   vs   rel（给这条记录） × ${runs}`)
  console.log('')
}

const tally = { without: { pass: 0, ran: 0 }, withRecord: { pass: 0, ran: 0 } }
const cells = []
for (const [arm, key] of [['none', 'without'], ['rel', 'withRecord']]) {
  for (let run = 1; run <= runs; run++) {
    const result = cell(arm, run)
    cells.push(result)
    if (result.ran) {
      tally[key].ran += 1
      if (result.pass) tally[key].pass += 1
    }
    if (!asJson) {
      const mark = result.ran ? (result.pass ? '✓' : '✗') : '·'
      console.log(`  ${arm}/run${String(run)}  ${mark}  ${result.ran ? result.note : result.why}`)
    }
  }
}

const measurement = measureEffect(tally)
const writable = measurable(measurement)

if (asJson) {
  console.log(JSON.stringify({ scenario: scenarioId, ...measurement, writable, cells, tally }, null, 2))
} else {
  console.log('')
  console.log(`读数 : ${describeEffect(measurement)}`)
  console.log(`可否写进记录: ${writable ? '可以 —— 这次测量有判别力、次数也够' : '不可以 —— 见上面的理由；写 0 会把"测不出来"记成"测出来没用"'}`)
  if (writable) {
    console.log('')
    console.log(`下一步（把 effect 写进那条记录，dry run 先看）：`)
    console.log(`  node tools/effect-write.mjs --results tools/t2-results.jsonl`)
    console.log(`这条命令按标题找记录、按场景配对两臂；要真写就加 --apply。`)
  }
  const skipped = cells.filter(c => !c.ran).length
  if (skipped > 0) console.log(`\n注意：有 ${String(skipped)} 格没跑完（上面标 · 的），它们不计入分母。`)
}
process.exit(writable ? 0 : 1)
