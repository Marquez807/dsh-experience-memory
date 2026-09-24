/**
 * 对外讲的硬话，必须和凭证对得上。
 *
 * 为什么有这一条（2026-09-25）：把 12 个开源记忆项目逐个读源码之后，第三条横向结论是
 * **数字与凭证普遍对不上**：
 *
 *   - OpenViking 的 LoCoMo 对比数字全仓只活在 3 个 README 的图片 `alt` 文本里，
 *     而 `benchmark/.gitignore:1` 就是 `results/`——数字挂着，结果目录不进版本库；
 *   - MemOS 的 88.83 / 89.20 只在两个 README，出处指向仓库外的评测框架；
 *   - dsh-engram 的数字是**真的**，但只报通过的 6 项：同一次运行末行是 `BENCH LOOK`、exit 1，
 *     PersonaMem 32.1% 对笨基线 71.0% 只字未提——**选择性引用比编数字更难发现**；
 *   - dsh-meow-memory 的"228 项测试"在本环境跑不起来（`test.mjs` 从不在仓库里的 `lib/` 导入）。
 *
 * 反面的两个榜样：`EverOS` 有完整评测 harness 但一个分都不挂；`dsh-akn-plugin` 把没做的事
 * 写进机器可读字段（`docs/capabilities/aen-mvp-0.1.json:41` = `"realLive2x2x2Result": "not-run"`）。
 * 这个文件抄的是后者的做法：**"没跑"要写出来，而且要写成机器能读的形式。**
 *
 * 规矩（`docs/CLAIMS.json` 里每条声称一行）：
 *   - `measured`  ⇒ 必须给出仓库里能跑的检查或产物，且**逐条确认文件真的在**；
 *   - `not-run` / `readme-only` ⇒ **一条凭证都不许带**（带了就意味着在拿没跑的东西当跑过）；
 *   - `design`    ⇒ 凭证是写这份设计的文档，不能空着。
 *
 * 并且这条检查**自带正反对照**：合成的坏样本必须被逐条报出来，合成的好样本必须一条都不报。
 * 理由同 `tests/hygiene.test.ts` 与预检门 ③b：一条永远为真的检查比没有检查更坏——
 * 它会让人以为"这件事有人看着"。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, eq } from './assert.ts'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')

/** 允许出现的状态。闭集合：自造档位一律报错，不静默放过。 */
export const CLAIM_STATUSES = ['measured', 'not-run', 'readme-only', 'design'] as const

export interface Claim {
  id?: unknown
  claim?: unknown
  status?: unknown
  evidence?: unknown
  how?: unknown
  note?: unknown
}

/**
 * 逐条核对一份声称清单，返回问题列表（空数组 = 全过）。
 *
 * `exists` 是注入进来的"这个文件在不在"，所以这个函数是纯的、可以拿合成数据喂它——
 * 阳性对照就是喂它一份**故意写坏**的清单。
 */
export function auditClaims(claims: readonly Claim[], exists: (path: string) => boolean): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  claims.forEach((item, index) => {
    const at = `第 ${index + 1} 条`
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (id === '') problems.push(`${at}：id 不能为空`)
    else if (seen.has(id)) problems.push(`${at}：id 重复（${id}）——一条声称只能登记一次`)
    else seen.add(id)
    if (typeof item.claim !== 'string' || item.claim.trim() === '') problems.push(`${at}：claim 不能为空`)

    const status = typeof item.status === 'string' ? item.status : ''
    if (!(CLAIM_STATUSES as readonly string[]).includes(status)) {
      problems.push(`${at}：status 只能是 ${CLAIM_STATUSES.join(' / ')}，实际是「${status || '空'}」`)
      return
    }
    const evidence = Array.isArray(item.evidence) ? item.evidence.map(String).filter(text => text.trim() !== '') : []
    if (!Array.isArray(item.evidence)) problems.push(`${at}：evidence 必须是数组（没有就写 []）`)

    if (status === 'measured' || status === 'design') {
      const label = status === 'measured' ? 'measured 必须指向真实存在的检查或产物' : 'design 必须指向写这份设计的文档'
      if (evidence.length === 0) problems.push(`${at}（${status}）：${label}，现在一条凭证都没有`)
      for (const path of evidence) {
        if (!exists(path)) problems.push(`${at}（${status}）：凭证「${path}」在仓库里不存在`)
      }
    } else {
      // not-run / readme-only：带了凭证就等于把没跑过的东西说成跑过了。
      if (evidence.length > 0) {
        problems.push(`${at}（${status}）：这一类不许带凭证（带了就是拿没跑的当跑过的），但写了「${evidence.join('、')}」`)
      }
      if (typeof item.how !== 'string' || item.how.trim() === '') {
        problems.push(`${at}（${status}）：要写清「打算怎么跑」（how 字段），否则下一个人不知道从哪接手`)
      }
    }
  })
  return problems
}

interface ClaimsFile {
  claims?: Claim[]
}

export function run(): void {
  // ── 阳性对照：故意写坏的清单，必须被逐条抓出来 ───────────────────────────
  const broken: Claim[] = [
    { id: '', claim: '没有 id', status: 'measured', evidence: ['tests/docs.test.ts'] },
    { id: 'a', claim: 'measured 但没凭证', status: 'measured', evidence: [] },
    { id: 'b', claim: 'measured 但凭证不存在', status: 'measured', evidence: ['tests/does-not-exist.ts'] },
    { id: 'c', claim: '没跑却带着凭证', status: 'not-run', evidence: ['tests/docs.test.ts'], how: '随便跑跑' },
    { id: 'd', claim: 'readme-only 却带着凭证', status: 'readme-only', evidence: ['README.md'] },
    { id: 'e', claim: '自造状态档位', status: 'looks-fine', evidence: [] },
    { id: 'a', claim: 'id 重复', status: 'measured', evidence: ['tests/docs.test.ts'] },
    { id: 'f', claim: '没跑又不说怎么跑', status: 'not-run', evidence: [] },
  ]
  const found = auditClaims(broken, path => path === 'tests/docs.test.ts')
  const want = [
    'id 不能为空',
    'id 重复',
    '一条凭证都没有',
    '在仓库里不存在',
    '这一类不许带凭证',
    'status 只能是',
    '打算怎么跑',
  ]
  for (const needle of want) {
    assert(found.some(text => text.includes(needle)), `阳性对照：写坏的清单必须报出「${needle}」，实际报了：${found.join(' | ') || '（一条都没有）'}`)
  }

  // ── 阴性对照：一份合法清单必须一条都不报 ─────────────────────────────────
  const good: Claim[] = [
    { id: 'ok.measured', claim: '有凭证的声称', status: 'measured', evidence: ['tests/docs.test.ts'] },
    { id: 'ok.notrun', claim: '没跑的声称', status: 'not-run', evidence: [], how: '怎么跑' },
    { id: 'ok.readme', claim: '只有正文的声称', status: 'readme-only', evidence: [], how: '怎么重跑' },
    { id: 'ok.design', claim: '设计决定', status: 'design', evidence: ['tests/docs.test.ts'] },
  ]
  eq(auditClaims(good, path => path === 'tests/docs.test.ts'), [], '阴性对照：合法清单必须一条问题都不报')

  // ── 真清单：结构必须合法，凭证必须逐个存在 ───────────────────────────────
  const raw = readFileSync(join(ROOT, 'docs', 'CLAIMS.json'), 'utf8')
  const parsed = JSON.parse(raw) as ClaimsFile
  assert(Array.isArray(parsed.claims), 'docs/CLAIMS.json 必须有 claims 数组')
  const claims = parsed.claims ?? []
  assert(claims.length >= 8, `声称清单至少要有 8 条（现在 ${claims.length} 条）——太短说明没把话登记全`)
  const problems = auditClaims(claims, path => existsSync(join(ROOT, path)))
  assert(problems.length === 0, `声称与凭证对不上：${problems.join('；') || '无'}`)

  // 每个状态档位都得有人用，否则这些档位是死的、没人知道它长什么样。
  const used = new Set(claims.map(item => String(item.status)))
  for (const status of CLAIM_STATUSES) {
    assert(used.has(status), `状态档位「${status}」一条都没用到——要么补上该类声称，要么把它从闭集合里删掉`)
  }

  const measured = claims.filter(item => item.status === 'measured').length
  console.log(`             (${String(claims.length)} 条声称：measured ${String(measured)}、`
    + `readme-only ${String(claims.filter(i => i.status === 'readme-only').length)}、`
    + `not-run ${String(claims.filter(i => i.status === 'not-run').length)}、`
    + `design ${String(claims.filter(i => i.status === 'design').length)})`)
}
