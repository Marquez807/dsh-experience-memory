/**
 * Guard hints: the machine's own facts, offered at write time.
 *
 * These cases exist because the failure they prevent was measured, not imagined
 * (`docs/DELIVERY-GAPS.md` §27): a safety record phrased with *example* markers was copied, by every
 * arm that had it, into a guard that could not protect the live store — one arm's marker list even
 * contained `dsh-`, which the live store's own path (`AppData\Roaming\dsh-desktop\harness\…`)
 * contains too. So the interesting assertions here are about *which* facts the hint names, and about
 * the hint staying a proposal: nothing in this module may touch the record.
 */
import { assert, eq } from './assert.ts'
import { distinctiveTokens, guardHintFor, looksDestructive } from '../src/guard-hints.ts'

const FACTS = {
  realStorePath: 'C:\\Users\\Admin\\AppData\\Roaming\\dsh-desktop\\harness\\experience-memory\\memory.db',
  disposableRoot: 'C:\\Users\\Admin\\AppData\\Local\\Temp',
}

export function run(): void {
  // ── What counts as a destructive record ───────────────────────────────────
  assert(looksDestructive('清空一个 SQLite 库里那张叫 record 的表').length > 0, '清空是破坏性动作')
  assert(looksDestructive('讲一下怎么排版').length === 0, '排版不是破坏性动作')
  assert(looksDestructive('DELETE FROM record WHERE 1=1').length > 0, '英文写法同样认得出来（大小写无关）')
  eq(looksDestructive('把 DROP TABLE 的后果写清楚'), ['drop table'], '命中的词要报出来，方便解释为什么提议')

  // ── Nothing to say ────────────────────────────────────────────────────────
  eq(guardHintFor({ text: '讲一下怎么排版', facts: FACTS }), undefined, '不是破坏性记录 ⇒ 不提议任何东西')

  // ── The hint names both environment facts ─────────────────────────────────
  const hint = guardHintFor({ text: '写清库脚本要小心：一次实验把用户真库清空了', facts: FACTS })
  assert(hint !== undefined, '破坏性记录 ⇒ 有提议')
  assert(hint.line.includes(FACTS.realStorePath), '提示必须点名真库路径（这才是"永不动这个文件"）')
  assert(hint.line.includes(FACTS.disposableRoot), '提示必须给出可动范围')
  assert(hint.line.includes('默认拒绝'), '提示要写成规则：默认拒绝')
  // 这一句是 §27 的核心，不能丢：关键词清单会被真库路径自己满足。
  assert(hint.line.includes('不等于'), `提示必须写明"路径含某个词不等于安全"，实际是：${hint.line}`)
  eq(hint.covered, false, '这条记录本身没写这些事实 ⇒ 需要提议')

  // ── Already covered ⇒ say so instead of nagging ───────────────────────────
  const namesStore = guardHintFor({ text: '清库前先看路径：dsh-desktop/harness 下的库永远不许动', facts: FACTS })
  eq(namesStore?.covered, true, '已经点名真库目录 ⇒ covered')
  const namesRoot = guardHintFor({ text: `清库只允许在 ${FACTS.disposableRoot} 下面做`, facts: FACTS })
  eq(namesRoot?.covered, true, '已经写出可动范围 ⇒ covered')

  // ── Which tokens count as "naming the store" ──────────────────────────────
  const tokens = distinctiveTokens(FACTS.realStorePath)
  assert(tokens.includes('dsh-desktop'), '真实目录名要算数（它是真库区别于别处的部分）')
  assert(tokens.includes('experience-memory'), '库目录名也要算数')
  assert(!tokens.includes('appdata'), 'AppData 这种到处都是的词不算"点名了真库"')
  assert(!tokens.includes('roaming') && !tokens.includes('users') && !tokens.includes('c:'),
    '通用路径段不算：说"别动 AppData 下的东西"并没有说清是哪个文件')
  eq(tokens[0], tokens.slice().sort((a, b) => b.length - a.length)[0], '最长的排最前（先匹配最特异的）')
}
