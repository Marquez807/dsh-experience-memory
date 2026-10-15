/**
 * 汇总 L1 对照实验的结果，并按**预注册的三条判据**逐条判。
 *
 *   node tools/l1-ab/stats.mjs [run-id]
 *
 * 判据（`docs/PREREGISTER-l1-thin-digest.md` 第三节，跑完照此判、不事后改）：
 *   1. B 臂（薄）的正确率 ≥ A 臂（厚）
 *   2. B 臂的取回次数 > 0 —— 否则说明薄摘要被直接忽略，记忆静默失效
 *   3. B 臂摘要覆盖的条数 ≥ A 臂
 *
 * 关于判据 3：本场景每格只播**一条**记录，所以"覆盖条数"只能体现在**行字节数**上——
 * 同样的每行上限（240 字节）下，薄行短得多，同预算能挂的条数更多。这一条如实标注为
 * "按行字节数折算"，不是实跑出来的条数。
 */
import { readFileSync } from 'node:fs'
import { byteLength, renderDigest } from '../../lib/inject.js'

const rows = readFileSync(new URL('./results.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))

const runId = process.argv[2] ?? rows[rows.length - 1]?.run
const cells = rows.filter(row => row.run === runId && row.arm !== undefined)
const arms = [...new Set(cells.map(row => row.arm))]

const logFact = n => { let s = 0; for (let i = 2; i <= n; i += 1) s += Math.log(i); return s }
const logChoose = (n, k) => logFact(n) - logFact(k) - logFact(n - k)
/** 双侧 Fisher 精确检验，2×2。样本小的时候唯一说得上话的那个。 */
function fisherTwoSided(a, b, c, d) {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2
  if (n === 0 || r1 === 0 || r2 === 0 || c1 === 0) return 1
  const p = x => Math.exp(logChoose(c1, x) + logChoose(n - c1, r1 - x) - logChoose(n, r1))
  const observed = p(a)
  let sum = 0
  for (let x = Math.max(0, r1 - (n - c1)); x <= Math.min(r1, c1); x += 1) {
    if (p(x) <= observed + 1e-12) sum += p(x)
  }
  return Math.min(1, sum)
}

const summary = {}
for (const arm of arms) {
  const all = cells.filter(row => row.arm === arm)
  // 智能体没起来 / 超时的格子不算数：那测的是环境，不是模型（standing-ab 的两条教训之一）。
  const valid = all.filter(row => row.timeout !== true && typeof row.marked === 'boolean')
  const marked = valid.filter(row => row.marked === true).length
  summary[arm] = {
    cells: all.length,
    valid: valid.length,
    marked,
    retrieve: valid.reduce((sum, row) => sum + (row.retrieve_count ?? 0), 0),
    seconds: valid.map(row => row.seconds ?? 0),
  }
}

console.log(`run ${runId}`)
for (const arm of arms) {
  const s = summary[arm]
  const avg = s.seconds.length === 0 ? 0 : Math.round((s.seconds.reduce((a, b) => a + b, 0) / s.seconds.length) * 10) / 10
  console.log(`  ${arm.padEnd(6)} 及格 ${s.marked}/${s.valid}（共 ${s.cells} 格）· 取回次数合计 ${s.retrieve} · 平均 ${avg} 秒`)
}

const A = summary.thick ?? { marked: 0, valid: 0, retrieve: 0 }
const B = summary.thin ?? { marked: 0, valid: 0, retrieve: 0 }

console.log('\n预注册判据：')
const p = fisherTwoSided(A.marked, A.valid - A.marked, B.marked, B.valid - B.marked).toFixed(6)
console.log(`  1. 正确率不降：薄 ${B.marked}/${B.valid} vs 厚 ${A.marked}/${A.valid} → ${B.valid === 0 || A.valid === 0 ? '样本不足，判不了' : (B.marked * A.valid >= A.marked * B.valid ? '成立' : '不成立')}（Fisher 双侧 p=${p}）`)
console.log(`  2. 薄臂确实去取：取回次数合计 ${B.retrieve} → ${B.retrieve > 0 ? '成立' : '不成立'}`)
// 判据 3：本场景每格只播一条记录，"覆盖条数"只能体现在**行字节**上。两臂各渲染一次真记录：
// 同样的每行上限（240 字节）下，薄行省下的字节就是"同预算能多挂几条"。
const seedRecord = {
  id: 'seed-l1',
  title: '本工作区新建文件必须带统一标记',
  lesson: '新建文件时，第一行写 `# owner-tag: zx9`',
  body: '用户定下的约定：本工作区里新建的每一个文件，第一行都必须是 `# owner-tag: zx9`。',
}
const one = { record: seedRecord }
const thickBytes = byteLength(renderDigest([{ label: '', ranked: [one] }], { maxRecords: 5, maxBytes: 1536 }))
const thinBytes = byteLength(renderDigest([{ label: '', ranked: [one] }], { maxRecords: 5, maxBytes: 1536, thin: true }))
const ratio = thinBytes === 0 ? 0 : Math.round((thickBytes / thinBytes) * 10) / 10
console.log(`  3. 覆盖条数不减：单记录场景只能按行字节折算——厚行 ${thickBytes} 字节、薄行 ${thinBytes} 字节，`
  + `同预算下薄行可挂约 ${ratio} 倍条数。如实标注为"按行字节折算"，不是实跑出来的条数。`)
