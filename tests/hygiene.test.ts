/**
 * 卫生检查：**不许静默吞错**。
 *
 * 为什么有这一条（2026-09-25）：把 12 个开源记忆项目逐个读了源码之后，最有规律的一条发现是——
 * 它们的"机制空转"几乎都不是算法差，而是**失败被悄悄吃掉**：
 *
 *   - MemOS 主检索里向量失败只打一条 warn 就继续用纯关键词，返回值里没有任何"我降级了"的字段，
 *     调用方在拿关键词冒充混合检索；
 *   - kovey/dsh-memory 的语义召回失败只写 `debug` 级日志，永不 stdout，且没有熔断；
 *   - dsh-engram 写 `resolved` 那行是 `void ...catch?.(() => null)`，失败完全无声；
 *   - dsh-negative-ledger 的"该撤的提醒"依赖的文件观察缓存被 `.catch(() => {})` 吞掉，
 *     于是该撤的撤不掉，也不报错。
 *
 * 共同后果一模一样：**看起来在跑、结果看起来正常、没有任何报错**。
 * 所以这里把"不许有空 catch"变成一条会红的检查，而不是靠自觉。
 *
 * 规矩：**空的 catch 必须写明为什么安全**（同行 `/* 原因 *\/`，或块内注释）。
 * 有正文的 catch（`return 默认值` 之类）不在此列——那是处理，不是吞掉。
 *
 * 并且这条检查**自带阴性对照**：它必须能在一个合成样本上真的报出违规。
 * 理由和预检门 ③b 一样（见 `tools/t2-preflight.ps1`）：一条**永远为真的检查**比没有检查更坏，
 * 因为它会让人以为"这件事有人看着"。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, eq } from './assert.ts'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src')

/**
 * 找出"空的、且没写原因的" catch，返回 `文件:行号`。
 *
 * 逐字符跟踪花括号深度，所以嵌套块、字符串里的括号都不会骗过它（那是这一行最爱犯的判据错）。
 * 换成别的源码也能用——阴性对照就是喂它一段合成的坏样本。
 */
export function emptyCatchesWithoutReason(source: string, label = 'src'): string[] {
  const lines = source.split('\n')
  const offenders: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const at = lines[i].indexOf('catch')
    if (at === -1 || !/\}\s*catch\s*(\{|\()/.test(lines[i])) continue
    const braceAt = lines[i].indexOf('{', at)
    if (braceAt === -1) continue
    let depth = 0
    let closed = false
    const body: string[] = []
    for (let j = i; j < lines.length && !closed; j += 1) {
      const text = j === i ? lines[j].slice(braceAt) : lines[j]
      let carve = 0
      for (const ch of text) {
        if (ch === '{') depth += 1
        else if (ch === '}') {
          depth -= 1
          if (depth === 0) { closed = true; break }
        }
        carve += 1
      }
      const inner = text.slice(1, closed ? carve : undefined)
      if (inner !== '') body.push(inner)
    }
    const raw = body.join('\n')
    const hasComment = /\/\*[\s\S]*?\*\//.test(raw) || /\/\/[^\n]*/.test(raw)
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim()
    if (code === '' && !hasComment) offenders.push(`${label}:${i + 1}`)
  }
  return offenders
}

export function run(): void {
  // ── 阴性对照：这条检查必须**真的会红** ────────────────────────────────────
  // 合成样本里第一个 catch 是空且无注释（必须被抓到），第二个空但有注释（必须放过）。
  const synthetic = [
    'try { risky() } catch {',
    '}',
    'try { ok() } catch { /* 读不到就算不命中，语义本身就是"否" */ }',
  ].join('\n')
  eq(emptyCatchesWithoutReason(synthetic, 'synthetic'), ['synthetic:1'], '阴性对照：空且无注释的 catch 必须被抓到，有注释的必须放过')

  // ── 真源码：当前必须一个都不违规 ─────────────────────────────────────────
  const offenders: string[] = []
  for (const file of readdirSync(SRC).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(join(SRC, file), 'utf8')
    offenders.push(...emptyCatchesWithoutReason(source, `src/${file}`))
  }
  assert(
    offenders.length === 0,
    `空 catch 必须写明为什么安全（不许静默吞错）——实测这一类是"机制空转且无报错"的主因。违规：${offenders.join('、') || '无'}`,
  )
}
