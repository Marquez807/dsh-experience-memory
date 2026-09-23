#!/usr/bin/env node
/**
 * Statistics for the second `verified-user` scenario: a file PLACEMENT convention.
 *
 * Two-sided Fisher's exact test computed from the hypergeometric distribution — no
 * approximation, because the sample is small and the point is not to overstate it.
 *   node tools/verified-user-ab/stats.mjs
 */
function logFactorial(n) {
  let s = 0
  for (let i = 2; i <= n; i += 1) s += Math.log(i)
  return s
}
function fisherTwoSided(a, b, c, d) {
  const n = a + b + c + d
  const C = (n_, k) => Math.exp(logFactorial(n_) - logFactorial(k) - logFactorial(n_ - k))
  const p = x => C(a + b, x) * C(c + d, (a + c) - x) / C(n, a + c)
  const lo = Math.max(0, (a + c) - (c + d))
  const hi = Math.min(a + b, a + c)
  const obs = p(a)
  let total = 0
  for (let x = lo; x <= hi; x += 1) if (p(x) <= obs + 1e-12) total += p(x)
  return Math.min(1, total)
}
function wilson(k, n) {
  const z = 1.96
  const p = k / n
  const d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d
  const h = (z * Math.sqrt(p * (1 - p) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, c - h), Math.min(1, c + h)]
}
const show = (label, k, n) => {
  const [lo, hi] = wilson(k, n)
  console.log(`${label.padEnd(30)} ${String(k).padStart(2)}/${n} = ${(k / n * 100).toFixed(1)}%   95% Wilson ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%`)
}

console.log('场景二：约定是「示例配置放 conf/samples/」，仓库任何文件都没写这件事')
show('  无记忆', 0, 6)
show('  有记忆（跨会话）', 6, 6)
console.log(`  Fisher p = ${fisherTwoSided(0, 6, 6, 0).toFixed(4)}`)
console.log('')
show('  有记忆（含冒烟那次）', 7, 7)
console.log(`  Fisher p = ${fisherTwoSided(0, 6, 7, 0).toFixed(4)}`)
console.log('')
console.log('无记忆那 6 次：模型每次都写了文件，写进 config/（它自己的默认猜测）。')
console.log('有记忆那 7 次：每次都写进 conf/samples/（用户那句话指定的）。')
console.log('')
console.log('—— 两场景合并（各按每臂 6 回合的整数计，不含冒烟）——')
show('  无记忆（场景一+二）', 0, 24)
show('  有记忆（场景一+二）', 20, 24)
console.log(`  Fisher p = ${fisherTwoSided(0, 24, 20, 4).toFixed(6)}`)
