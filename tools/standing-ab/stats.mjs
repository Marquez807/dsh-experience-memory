// 汇总 A/B 结果 + Fisher 精确检验（双侧）
import { readFileSync } from 'node:fs'

const rows = readFileSync('F:\\dsh主工作区\\scratch\\standing-ab\\results.jsonl', 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l))
// 只统计"智能体真的起来了、没超时"的格子
const valid = rows.filter(r => r.started === true && r.timeout !== true && r.marked !== undefined)
const byArm = new Map()
for (const r of valid) {
  const cur = byArm.get(r.arm) ?? { n: 0, hit: 0 }
  cur.n += 1
  if (r.marked) cur.hit += 1
  byArm.set(r.arm, cur)
}
console.log('有效格子:', valid.length, '| 被排除:', rows.length - valid.length)
for (const [arm, v] of byArm) console.log(`  ${arm.padEnd(9)} ${v.hit}/${v.n} 带标记`)

function logFact(n) { let s = 0; for (let i = 2; i <= n; i += 1) s += Math.log(i); return s }
function hyper(a, b, c, d) {
  const n = a + b + c + d
  return Math.exp(logFact(a + b) + logFact(c + d) + logFact(a + c) + logFact(b + d) - logFact(n) - logFact(a) - logFact(b) - logFact(c) - logFact(d))
}
function fisherTwoSided(a, b, c, d) {
  const p0 = hyper(a, b, c, d)
  let p = 0
  const r1 = a + b, r2 = c + d, c1 = a + c
  for (let x = 0; x <= Math.min(r1, c1); x += 1) {
    const y = r1 - x, z = c1 - x, w = r2 - z
    if (w < 0) continue
    const px = hyper(x, y, z, w)
    if (px <= p0 + 1e-12) p += px
  }
  return p
}

const standing = byArm.get('standing') ?? { n: 0, hit: 0 }
const others = [...byArm].filter(([a]) => a !== 'standing').reduce((acc, [, v]) => ({ n: acc.n + v.n, hit: acc.hit + v.hit }), { n: 0, hit: 0 })
console.log(`\n常驻 ${standing.hit}/${standing.n}  vs  其余各臂合计 ${others.hit}/${others.n}`)
console.log('Fisher 双侧 p =', fisherTwoSided(standing.hit, standing.n - standing.hit, others.hit, others.n - others.hit).toFixed(6))
const ctrl = byArm.get('control')
if (ctrl) console.log(`control 单独：${ctrl.hit}/${ctrl.n}`)

// 与第一批（results 文件被覆盖前的那一轮：control 2/4、standing 4/4、sham 0/4）合并
const pooledStanding = { hit: standing.hit + 4, n: standing.n + 4 }
const pooledOther = { hit: others.hit + 2 + 0, n: others.n + 4 + 4 }
console.log(`\n两批合并：常驻 ${pooledStanding.hit}/${pooledStanding.n}  vs  其余 ${pooledOther.hit}/${pooledOther.n}`)
console.log('Fisher 双侧 p =', fisherTwoSided(pooledStanding.hit, pooledStanding.n - pooledStanding.hit, pooledOther.hit, pooledOther.n - pooledOther.hit).toFixed(8))
