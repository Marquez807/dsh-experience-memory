/**
 * Legacy-store audit.
 *
 * The migration module answers "what can be imported". This answers the question
 * that has to come first: *is any of it true?* Correctness cannot be settled for
 * every claim automatically, so the audit separates what can be checked
 * mechanically from what needs a human:
 *
 *   mechanically checkable
 *     - a path or command the record tells you to use, checked against this
 *       machine right now. A record naming an executable that is not installed
 *       is not a matter of opinion.
 *     - exact and near duplicates: the same lesson stored many times, which is
 *       how a store grows without gaining knowledge.
 *     - records that contradict each other on the same subject, including the
 *       common case of opposite polarity (要/不要) over overlapping content.
 *     - whether a record it recommends would actually be injected, measured with
 *       this framework's own `importance` and `eligibleForResident`.
 *
 *   needs a human
 *     - whether a claim about the world is true. The audit groups and ranks the
 *       candidates and writes every record out for review; it does not decide.
 *
 * The logic lives here, in the shipped library, rather than in a script, for
 * three reasons: it is covered by the test suite, it can be reached from the
 * plugin's own surfaces, and it runs from an installed package (a script that
 * imports `src/*.ts` cannot, because Node refuses to strip types under
 * `node_modules`).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mapStore, scanForStores,                                      } from './import.js'
import { eligibleForResident, importance } from './rank.js'
import { tokenize } from './tokenize.js'
                                              

// ── Types ───────────────────────────────────────────────────────────────────

/** One mappable record together with the store it came from. */
                           
                      
                    
 

                             
                                                      
              
             
                                                                                
                                        
                                                                                
                                           
 

                              
              
                                          
                   
                                                                             
                            
 

                              
              
             
                
                    
                
                          
                      
                                 
                                 
                  
               
                                                               
                          
                                                                     
                         
   
                                                      
               
                                                                    
                     
                                                     
   
                   
                                                         
                                                     
   
            
                      
                         
                             
                      
                      
   
                                                 
           
               
                     
                       
                              
                        
                       
   
                       
                  
                 
                   
                                                                          
                          
                  
                   
   
            
                 
                       
               
                     
   
 

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Stops at whitespace *and* at CJK sentence punctuation, so a path followed by
 * prose does not swallow the prose into the path.
 */
const PATH_RE = /[A-Za-z]:\\[^\s"'`,;)\]}:：；，。、！？（）【】《》]+/g
const BACKTICK_RE = /`([^`\n]{1,80})`/g

/**
 * The command check is deliberately narrow. Inline code in these records is
 * mostly identifiers (`RUNTIME_REQUIRED`, `WandererProfile`, `Version.xml`), so
 * treating every backticked token as a command produced 21 "findings" of which
 * essentially none were real. Only names of actual command-line tools are
 * checked, which keeps the section worth reading.
 */
const KNOWN_TOOLS                      = new Set([
  'node', 'npm', 'pnpm', 'yarn', 'npx', 'python', 'python3', 'py', 'pip', 'pip3', 'uv', 'poetry', 'conda',
  'git', 'gh', 'curl', 'wget', 'tar', 'zip', 'unzip', '7z', 'robocopy', 'xcopy',
  'rg', 'grep', 'findstr', 'find', 'sed', 'awk', 'jq', 'yq', 'diff', 'sort',
  'docker', 'kubectl', 'cargo', 'rustc', 'go', 'dotnet', 'java', 'javac', 'mvn', 'gradle',
  'make', 'cmake', 'gcc', 'g++', 'clang', 'msbuild',
  'pwsh', 'powershell', 'cmd', 'bash', 'sh', 'wsl', 'code', 'codex',
  'sqlite3', 'psql', 'mysql', 'redis-cli', 'ffmpeg', 'winget', 'choco', 'scoop',
  'where', 'tasklist', 'taskkill', 'netstat', 'ipconfig', 'systeminfo',
  'pytest', 'tsc', 'vite', 'eslint', 'prettier', 'vitest', 'jest',
])

/** Two records are a contradiction candidate when one negates what the other asserts. */
const NEGATION_RE = /(?:不要|不得|不能|禁止|避免|切勿|勿|别|绝不|永远不|不应该|never|don't|do not|avoid)/i

const PLACEHOLDER_RE = /(?:待补充|待确认|TODO|FIXME|xxx|示例文本|placeholder|tbd)/i
const SELF_RE = /(?:记忆库|记忆系统|entries\.jsonl|memory\.sqlite3|admission|fingerprint|指纹|摘要字段|这条记录|本条记录)/i
const QUESTION_RE = /[?？]\s*$/

/** Labels the old runtime prefixed onto generated titles. */
const TITLE_LABELS = /^(?:用户声明|文件记载|工具观察|待验证|已审核|已核验静态|已核验|静态|经验)[：:]\s*/

/** Near-duplicate and contradiction thresholds, named so the report can state them. */
export const NEAR_DUPLICATE_JACCARD = 0.8
export const POLARITY_JACCARD = 0.5
/** Minimum body length for a record to count as substantive. */
export const SUBSTANTIVE_MIN_CHARS = 40

const PATH_EXTS = ['', '.exe', '.cmd', '.bat', '.ps1', '.com']

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Count values, most frequent first. */
export function tally(values                   )                         {
  const counts                         = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]))
}

/** Resolve a bare command name against PATH without spawning anything. */
export function makeCommandExists(pathEnv                    )                            {
  const dirs = (pathEnv ?? '').split(';').filter(Boolean)
  return name => {
    for (const dir of dirs) {
      for (const ext of PATH_EXTS) {
        try {
          if (existsSync(join(dir, name + ext))) return true
        } catch { /* an unreadable PATH entry is not a match */ }
      }
    }
    return false
  }
}

/**
 * Decide what a path reference actually claims.
 *
 * Records are prose, so a path is often glued to the sentence that follows it
 * ("...\\长效记忆项目是当前记忆运行时实现；..."). Testing the raw candidate would
 * report a missing path that is really a present path plus prose. The longest
 * existing prefix separates the two cases without guessing:
 *
 *   prefix ends at a separator  -> the final segment genuinely is not there
 *   prefix ends inside a segment -> the path exists; the rest was prose
 */
export function classifyPath(
  candidate        ,
  pathExists                            = existsSync,
)                                                                                                                             {
  const safeExists = (path        )          => {
    try { return pathExists(path) } catch { return false }
  }
  if (safeExists(candidate)) return { kind: 'present' }
  for (let end = candidate.length - 1; end > 2; end -= 1) {
    const prefix = candidate.slice(0, end)
    if (!safeExists(prefix)) continue
    const rest = candidate.slice(end)
    const endsAtSeparator = /[\\/]$/.test(prefix) || /^[\\/]/.test(rest)
    return endsAtSeparator
      ? { kind: 'missing-segment', prefix }
      : { kind: 'prose-suffixed', prefix }
  }
  return { kind: 'missing-segment', prefix: undefined }
}

/** Jaccard similarity of two token sets. */
function jaccard(a                     , b                     )         {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

/** The topic a legacy title belongs to: the part before its subject colon. */
export function topicOf(title        )         {
  const stripped = title.replace(TITLE_LABELS, '').trim()
  const withoutDates = stripped.replace(/[（(][^）)]{0,40}[）)]/g, ' ').replace(/\s+/g, ' ').trim()
  const colon = withoutDates.search(/[：:]/)
  if (colon > 0) return withoutDates.slice(0, colon).trim().toLowerCase()
  // No subject label: fall back to a short prefix so these still group together
  // rather than each becoming its own category.
  return `${withoutDates.slice(0, 10).trim().toLowerCase()}…`
}

// ── The audit ───────────────────────────────────────────────────────────────

/**
 * Audit every live store under `root`.
 *
 * Returns structured findings plus the four rendered reports, so a caller can
 * print a summary, write the files, or assert on the numbers in a test.
 */
export function auditLegacy(input            )              {
  const now = input.now
  const pathExists = input.pathExists ?? existsSync
  const commandExists = input.commandExists ?? makeCommandExists(process.env['PATH'])

  const scan = scanForStores(input.root)
  const rows             = []
  const skipped                         = {}
  let globalDowngraded = 0
  for (const store of scan.stores) {
    const mapped = mapStore(store, now)
    globalDowngraded += mapped.globalDowngraded
    for (const [reason, count] of Object.entries(mapped.skipped)) {
      skipped[reason] = (skipped[reason] ?? 0) + count
    }
    for (const record of mapped.records) rows.push({ record, store })
  }

  // ── 1. External validity: paths and commands the record tells you to use ──
  const pathRefs = new Map                  ()
  const cmdRefs = new Map                  ()
  for (const [index, { record }] of rows.entries()) {
    const text = [record.title, record.body, record.lesson, record.failureMode, record.trigger, record.sourceRef]
      .filter(Boolean).join('\n')
    for (const match of text.matchAll(PATH_RE)) {
      const path = match[0].replace(/[.,;:）】]+$/, '')
      pathRefs.set(path, [...(pathRefs.get(path) ?? []), index])
    }
    for (const match of text.matchAll(BACKTICK_RE)) {
      const first = match[1].trim().split(/\s+/)[0]
      if (first === undefined) continue
      const name = first.toLowerCase()
      if (KNOWN_TOOLS.has(name)) cmdRefs.set(name, [...(cmdRefs.get(name) ?? []), index])
    }
  }

  let proseSuffixed = 0
  const missing                = []
  for (const [path, records] of pathRefs.entries()) {
    const verdict = classifyPath(path, pathExists)
    if (verdict.kind === 'prose-suffixed') proseSuffixed += 1
    else if (verdict.kind === 'missing-segment') missing.push({ path, records, prefix: verdict.prefix })
  }
  missing.sort((a, b) => b.records.length - a.records.length)

  const commandIssues = [...cmdRefs.entries()]
    .filter(([name]) => !commandExists(name))
    .map(([name, records]) => ({ name, records }))
    .sort((a, b) => b.records.length - a.records.length)

  // ── 2. Duplicates ─────────────────────────────────────────────────────────
  const byFingerprint = new Map                  ()
  for (const [index, { record }] of rows.entries()) {
    const key = record.contentFingerprint
    byFingerprint.set(key, [...(byFingerprint.get(key) ?? []), index])
  }
  const exact = [...byFingerprint.values()].filter(group => group.length > 1)
    .sort((a, b) => b.length - a.length)

  const tokenSets = rows.map(({ record }) =>
    new Set(tokenize([record.title, record.body, record.lesson].filter(Boolean).join('\n'))))

  const near                                              = []
  for (let i = 0; i < rows.length; i += 1) {
    // A pair inside an exact-duplicate group is already reported as a group.
    if (byFingerprint.get(rows[i] .record.contentFingerprint) .length !== 1) continue
    for (let j = i + 1; j < rows.length; j += 1) {
      const score = jaccard(tokenSets[i] , tokenSets[j] )
      if (score >= NEAR_DUPLICATE_JACCARD) near.push({ i, j, jaccard: score })
    }
  }
  near.sort((a, b) => b.jaccard - a.jaccard)

  // ── 3. Internal contradiction ─────────────────────────────────────────────
  const polarity                                              = []
  for (let i = 0; i < rows.length; i += 1) {
    const a = rows[i] .record
    const aText = [a.title, a.body, a.lesson].filter(Boolean).join('\n')
    for (let j = i + 1; j < rows.length; j += 1) {
      const b = rows[j] .record
      if (a.contentFingerprint === b.contentFingerprint) continue
      const score = jaccard(tokenSets[i] , tokenSets[j] )
      if (score < POLARITY_JACCARD) continue
      const bText = [b.title, b.body, b.lesson].filter(Boolean).join('\n')
      if (NEGATION_RE.test(aText) !== NEGATION_RE.test(bText)) polarity.push({ i, j, jaccard: score })
    }
  }
  polarity.sort((a, b) => b.jaccard - a.jaccard)

  // Same legacy `subject`, different body: the same topic settled two ways.
  const bySubject = new Map                  ()
  for (const [index, { record }] of rows.entries()) {
    const subject = record.trigger.trim().toLowerCase()
    if (subject === '') continue
    bySubject.set(subject, [...(bySubject.get(subject) ?? []), index])
  }
  const subject = [...bySubject.entries()]
    .filter(([, group]) => new Set(group.map(i => rows[i] .record.contentFingerprint)).size > 1)
    .map(([name, records]) => ({ subject: name, records }))
    .sort((a, b) => b.records.length - a.records.length)

  // ── 4. Quality signals ────────────────────────────────────────────────────
  const quality = {
    question: []            ,
    placeholder: []            ,
    selfReferential: []            ,
    tooShort: []            ,
    noLesson: []            ,
  }
  for (const [index, { record }] of rows.entries()) {
    const text = [record.title, record.body].filter(Boolean).join('\n')
    if (QUESTION_RE.test(record.body.trim())) quality.question.push(index)
    if (PLACEHOLDER_RE.test(text)) quality.placeholder.push(index)
    if (SELF_RE.test(text)) quality.selfReferential.push(index)
    if (record.body.trim().length < 20) quality.tooShort.push(index)
    if (record.lesson.trim() === '' && record.failureMode.trim() === '') quality.noLesson.push(index)
  }

  // ── 5. Recommended import subset ──────────────────────────────────────────
  // A funnel, so the cost of each restriction is visible and each one can be
  // argued with separately.
  const selfSet = new Set(quality.selfReferential)
  const indexes = rows.map((_, index) => index)
  const confirmed = indexes.filter(index => rows[index] .record.status === 'confirmed')
  const proofBacked = confirmed.filter(index => rows[index] .record.evidence !== 'inferred')
  const notSelf = proofBacked.filter(index => !selfSet.has(index))
  const deduped = new Map                ()
  for (const index of notSelf) {
    const { record } = rows[index] 
    deduped.set(`${record.contentFingerprint}\u0000${record.workspaceId}`, index)
  }
  const recommended = [...deduped.values()]
    .filter(index => rows[index] .record.body.trim().length >= SUBSTANTIVE_MIN_CHARS)
  const funnel = {
    all: rows.length,
    confirmed: confirmed.length,
    proofBacked: proofBacked.length,
    notSelfReferential: notSelf.length,
    deduplicated: deduped.size,
    substantive: recommended.length,
  }

  // ── 6. Would importing them actually reach the model? ─────────────────────
  // "Worth importing" and "will be injected" are different questions, and the
  // answer is decided by the framework's own ranking function rather than by
  // opinion. A `verified-file` record carries a base of exactly 3.0 x 2.0 = 6.0
  // against a resident bar of 6.0, so age alone can push it under.
  let ready = 0
  let blocked = 0
  let withIdentifier = 0
  const scores           = []
  for (const index of recommended) {
    const { record } = rows[index] 
    const score = importance({ ...record, now, identifierMatches: 0 })
    if (eligibleForResident(record, score, now)) ready += 1
    else {
      blocked += 1
      scores.push(score)
    }
    // One exact identifier hit is worth 1.0, so it is the difference between
    // "searchable" and "in the digest this turn". Measured, not assumed.
    if (eligibleForResident(record, importance({ ...record, now, identifierMatches: 1 }), now)) {
      withIdentifier += 1
    }
  }
  const injectability = {
    ready,
    blocked,
    withIdentifier,
    lowest: scores.length === 0 ? 0 : Math.min(...scores),
    highest: scores.length === 0 ? 0 : Math.max(...scores),
  }

  const result              = {
    root: input.root,
    now,
    stores: scan.stores.length,
    rawRecords: scan.stores.reduce((sum, store) => sum + store.records.length + store.duplicates, 0),
    mapped: rows.length,
    globalDowngraded,
    readErrors: scan.errors,
    excludedStores: scan.excluded,
    skipped,
    rows,
    pathIssues: { missing, proseSuffixed },
    commandIssues,
    duplicates: { exact, near },
    contradictions: { polarity, subject },
    quality,
    funnel,
    recommended,
    injectability,
    reports: { audit: '', recommended: '', tsv: '', selection: '' },
  }

  result.reports = {
    audit: renderAuditReport(result),
    recommended: renderCatalogue(result),
    tsv: renderTsv(result),
    selection: renderSelection(result),
  }
  return result
}

// ── Report rendering ────────────────────────────────────────────────────────

/** One-line identification of a record, for report tables. */
function short(result             , index        )         {
  const { record } = result.rows[index] 
  const oneLine = record.body.replace(/\s+/g, ' ').slice(0, 96)
  return `${record.title.slice(0, 40)} | ${oneLine}`
}

const cell = (text        )         => text.replace(/\|/g, '\\|')

function renderAuditReport(result             )         {
  const lines           = []
  const p = (text        )       => { lines.push(text) }
  const { funnel, injectability, duplicates, contradictions, quality, pathIssues, commandIssues } = result

  p('# 旧记忆库正确性审计')
  p('')
  p(`扫描根：\`${result.root}\``)
  p('')
  p(`这份报告回答一个问题：**这 ${result.mapped} 条可映射记录能不能信。**`)
  p('')
  p('能机械验证的部分已经验证（引用的路径/命令是否还存在、记录之间是否互相矛盾、');
  p('导进去会不会真的被注入）；不能机械验证的（对世界的断言是否属实）只做分组和排序，');
  p('逐条列在 TSV 里交由人判断。')
  p('')
  p('## 一、概览')
  p('')
  p(`- 活库：${result.stores} 个`)
  p(`- 原始记录（含同库重复）：${result.rawRecords} 条`)
  p(`- 可映射：${result.mapped} 条`)
  p(`- 降级为工作区级的旧 \`global\` 记录：${result.globalDowngraded} 条`)
  p(`- 读取错误：${result.readErrors.length} 处`)
  p('')
  p('跳过分类：')
  p('')
  p('| 原因 | 条数 |')
  p('|---|---|')
  for (const [reason, count] of Object.entries(result.skipped).sort((a, b) => b[1] - a[1])) {
    p(`| ${reason} | ${count} |`)
  }
  p('')
  p(`### 被排除的副本库：${result.excludedStores.length} 个`)
  p('')
  p('这些 `.memory` 目录装的是另一个库的副本，不是活库。把它们一起导入，一条经验会按快照数量翻倍，')
  p('所以扫描阶段就排除了，并且在这里列出来让决定保持可见。')
  p('')
  if (result.excludedStores.length === 0) {
    p('无。')
  } else {
    p('| 库 | 原因 |')
    p('|---|---|')
    for (const item of result.excludedStores) p(`| \`${item.path}\` | ${item.reason} |`)
  }
  p('')

  p('## 二、来源与构成')
  p('')
  p('### 每个库的记录数')
  p('')
  p('| 库 | 记录 |')
  p('|---|---|')
  for (const store of [...new Set(result.rows.map(row => row.store))]
    .sort((a, b) => b.records.length - a.records.length)) {
    p(`| \`${store.projectRoot}\` | ${store.records.length} |`)
  }
  p('')
  for (const [label, values] of [
    ['证据等级', result.rows.map(r => r.record.evidence)],
    ['状态', result.rows.map(r => r.record.status)],
    ['类型', result.rows.map(r => r.record.kind)],
  ]         ) {
    p(`### ${label}分布`)
    p('')
    p('| 值 | 条数 |')
    p('|---|---|')
    for (const [value, count] of Object.entries(tally([...values]))) p(`| \`${value}\` | ${count} |`)
    p('')
  }

  if (result.rows.length > 0) {
    const ages = result.rows.map(r => Math.round((result.now - r.record.createdAt) / 86_400_000)).sort((a, b) => a - b)
    const median = ages[Math.floor(ages.length / 2)] 
    p('### 时间')
    p('')
    p(`- 最早：${new Date(Math.min(...result.rows.map(r => r.record.createdAt))).toISOString().slice(0, 10)}`)
    p(`- 最新：${new Date(Math.max(...result.rows.map(r => r.record.createdAt))).toISOString().slice(0, 10)}`)
    p(`- 年龄中位数：${median} 天`)
    p('')
  }

  p('## 三、能机械验证的：引用的路径是否还存在')
  p('')
  p('记录是散文，路径常和后面的句子粘在一起，所以直接拿正则抓到的串去查存在性会误判。')
  p('这里用「最长存在前缀」区分两种情况：前缀停在分隔符上，说明最后一段真的不在；前缀停在段中间，')
  p('说明路径本身存在，后面粘的是散文。')
  p('')
  p(`- 散文粘连（路径其实存在）：${pathIssues.proseSuffixed} 条`)
  p(`- 真的不存在：${pathIssues.missing.length} 条`)
  p('')
  if (pathIssues.missing.length === 0) {
    p('没有记录在教一件做不到的事。')
  } else {
    p(`发现 **${pathIssues.missing.length}** 个被引用但本机不存在的路径，`
      + `共出现在 ${new Set(pathIssues.missing.flatMap(item => item.records)).size} 条记录里。`)
    p('每条这样的记录都在教一件做不到的事。')
    p('')
    p('| 路径 | 被引用 | 最长存在前缀 | 示例记录 |')
    p('|---|---|---|---|')
    for (const finding of pathIssues.missing.slice(0, 40)) {
      const prefix = finding.prefix === undefined ? '（连盘符前缀都不存在）' : `\`${finding.prefix}\``
      p(`| \`${finding.path}\` | ${finding.records.length} 次 | ${prefix} | ${cell(short(result, finding.records[0] ))} |`)
    }
  }
  p('')

  p('## 四、能机械验证的：引用的命令是否还装在本机')
  p('')
  p('这里只检查真实命令行工具的名字（`node`、`git`、`pwsh` 这类），不检查行内代码里的标识符——')
  p('旧记录里 `RUNTIME_REQUIRED`、`WandererProfile` 这种名字占绝大多数，把它们当命令只会制造误判。')
  p('')
  if (commandIssues.length === 0) {
    p('记录引用到的命令行工具在本机都能解析。')
  } else {
    p(`发现 **${commandIssues.length}** 个被引用但本机无法解析的工具：`)
    p('')
    p('| 命令 | 被引用 | 示例记录 |')
    p('|---|---|---|')
    for (const finding of commandIssues.slice(0, 40)) {
      p(`| \`${finding.name}\` | ${finding.records.length} 次 | ${cell(short(result, finding.records[0] ))} |`)
    }
  }
  p('')

  p('## 五、能机械验证的：记录之间是否互相矛盾')
  p('')
  p(`### 精确重复：${duplicates.exact.length} 组`)
  p('')
  if (duplicates.exact.length === 0) p('无。')
  for (const group of duplicates.exact.slice(0, 15)) {
    p(`- ${group.length} 条同一内容：${cell(short(result, group[0] ))}`)
    p(`  - 来自：${group.map(i => result.rows[i] .store.projectRoot).join('、')}`)
  }
  p('')
  p(`### 近重复（词元 Jaccard ≥ ${NEAR_DUPLICATE_JACCARD}）：${duplicates.near.length} 对`)
  p('')
  for (const pair of duplicates.near.slice(0, 15)) {
    p(`- ${pair.jaccard.toFixed(2)}：${cell(short(result, pair.i))}`)
    p(`  - 对比：${cell(short(result, pair.j))}`)
  }
  p('')
  p(`### 同一主题、相反极性（要/不要）：${contradictions.polarity.length} 对`)
  p('')
  p('这是最需要人看的一类：两条记录讲同一件事，但一条说要做、一条说别做，最多只有一条对。')
  p('')
  for (const pair of contradictions.polarity.slice(0, 25)) {
    p(`- ${pair.jaccard.toFixed(2)}：${cell(short(result, pair.i))}`)
    p(`  - 对比：${cell(short(result, pair.j))}`)
  }
  p('')
  p(`### 同一 subject 字段、内容不同：${contradictions.subject.length} 组`)
  p('')
  for (const group of contradictions.subject.slice(0, 15)) {
    p(`- \`${group.subject}\`（${group.records.length} 条不同内容）`)
  }
  p('')

  p('## 六、质量信号（需要人判断，不是自动判决）')
  p('')
  p('| 信号 | 条数 | 含义 |')
  p('|---|---|---|')
  p(`| 正文是疑问句 | ${quality.question.length} | 记录的是问题不是结论 |`)
  p(`| 含占位符 | ${quality.placeholder.length} | 当时没写完 |`)
  p(`| 自指（讲记忆机制本身） | ${quality.selfReferential.length} | 多半是退化模型的自我描述，不是经验 |`)
  p(`| 正文短于 20 字 | ${quality.tooShort.length} | 信息量不足 |`)
  p(`| 既无 lesson 也无 failure_mode | ${quality.noLesson.length} | 没有可执行教训 |`)
  p('')
  p('关于最后一行：**旧运行时根本没有 `lesson` 和 `failure_mode` 两个字段，所以每一条导入记录这两个字段都是空的。**')
  p('这不是数据损坏，但要说清后果：新框架的常驻行是「标题 — 教训」，教训为空时回退渲染正文，')
  p('所以导入的记录在提示词里以正文形式出现，可执行教训这一层是缺的。')
  p('补它需要人读一遍——这正是审计只给候选、不给结论的原因。')
  p('')
  for (const [label, list] of [
    ['正文是疑问句', quality.question],
    ['含占位符', quality.placeholder],
    ['自指（讲记忆机制本身）', quality.selfReferential],
  ]         ) {
    if (list.length === 0) continue
    p(`### ${label}（前 20 条）`)
    p('')
    for (const index of list.slice(0, 20)) p(`- ${cell(short(result, index))}`)
    p('')
  }

  p('## 七、建议导入子集')
  p('')
  p('审计的结论不是「全导」也不是「全不导」，而是这条漏斗。每一步都写明代价：')
  p('')
  p('| 步骤 | 剩余 | 丢掉了什么 |')
  p('|---|---|---|')
  p(`| 可映射合计 | ${funnel.all} | — |`)
  p(`| 只留 confirmed | ${funnel.confirmed} | ${funnel.all - funnel.confirmed} 条旧状态已是 retired/candidate，当时就被判定为不该用 |`)
  p(`| 只留有过证据的 | ${funnel.proofBacked} | ${funnel.confirmed - funnel.proofBacked} 条是 \`inferred\`，从来没有任何东西验证过它们 |`)
  p(`| 去掉讲记忆机制自身的 | ${funnel.notSelfReferential} | ${funnel.proofBacked - funnel.notSelfReferential} 条是旧运行时在描述自己，对新框架是过时事实 |`)
  p(`| 同一工作区内去重 | ${funnel.deduplicated} | ${funnel.notSelfReferential - funnel.deduplicated} 条同工作区重复 |`)
  p(`| 正文至少 ${SUBSTANTIVE_MIN_CHARS} 字 | ${funnel.substantive} | ${funnel.deduplicated - funnel.substantive} 条信息量不足以构成一条经验 |`)
  p('')
  p(`**建议导入 ${funnel.substantive} 条。**其余的不是「错」就是「空」，留在旧库里比进新库更有价值——`)
  p('进新库会让它们在检索里和真经验竞争注意力。')
  p('')
  p('### 导进去之后，它们真的会出现在每轮提示词里吗')
  p('')
  p('「值得导入」和「会被注入」是两个问题。后者不该靠判断，所以这里直接调用框架自己的')
  p('`importance` 与 `eligibleForResident` 来量：')
  p('')
  p('- `verified-file` 的基础分是 `3.0 × 2.0 = 6.0`，而常驻资格线也正好是 `6.0`')
  p('- 陈旧度按默认 180 天复核周期计算，所以记录一出生就开始被扣分')
  p('')
  p('| 结果 | 条数 | 含义 |')
  p('|---|---|---|')
  p(`| 立即满足常驻资格线 | ${injectability.ready} | 查询命中即可进入每轮摘要 |`)
  p(`| 差一点，进不去 | ${injectability.blocked} | 平时只在 \`memory_recall\` 里可按需检索；`
    + '查询里出现**标识符精确命中**（路径、类名、文件名）时才补上那 1.0 分而进入摘要 |')
  p('')
  p(`其中 **${injectability.withIdentifier} / ${injectability.blocked}** 条只要查询命中一个标识符就能过线。`)
  p('')
  if (injectability.blocked > 0) {
    p(`这 ${injectability.blocked} 条的分数落在 ${injectability.lowest.toFixed(3)} – ${injectability.highest.toFixed(3)} 之间，`)
    p('差的就是年龄扣掉的那一点。所以它们的真实角色是**可按需检索的项目知识库**，不是每轮自动浮现的经验。')
    p('这不是缺陷，是阈值在按设计工作：证据较弱的事实要靠「与本轮相关」或「已被复用」换取常驻位置。')
    p('')
  }
  p(`这 ${funnel.substantive} 条**具体是什么**，见 \`legacy-memory-recommended.md\`（按项目分组、组内按主题、逐条列出）。`)
  p('')

  p('## 八、逐条清单')
  p('')
  p(`完整 ${funnel.all} 条见 \`legacy-memory-records.tsv\`（含正文全文），供逐条复核。`)
  p('建议子集的分组阅读版见 `legacy-memory-recommended.md`。')
  p('')
  return lines.join('\n')
}

/**
 * Grouping is by project and then by topic. Project matters because most of these
 * are project-specific facts about a codebase, not general truths; topic is taken
 * from the part of the title before its colon, which the old runtime used as a
 * subject label.
 */
function renderCatalogue(result             )         {
  const byProject = new Map                               ()
  for (const index of result.recommended) {
    const { record, store } = result.rows[index] 
    const leaf = store.projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? store.projectRoot
    if (!byProject.has(leaf)) byProject.set(leaf, new Map())
    const topics = byProject.get(leaf) 
    const topic = topicOf(record.title)
    if (!topics.has(topic)) topics.set(topic, [])
    topics.get(topic) .push(index)
  }
  const size = (topics                       )         =>
    [...topics.values()].reduce((sum, list) => sum + list.length, 0)

  const out           = []
  out.push('# 值得信的经验：归类与全文')
  out.push('')
  out.push(`按项目分组，组内按主题。共 ${result.recommended.length} 条，全部来自活库，全部为 \`confirmed\` 且有过证据。`)
  out.push('')
  out.push('> 这些是**项目内的事实**，不是通用真理。多数描述某个代码库的结构、入口、状态或'
    + '「当时尚未核实」的边界。读它们时要带着「在哪个项目里成立」这个前提。')
  out.push('')
  out.push(`> 注入行为实测：${result.injectability.ready} 条立即满足常驻资格线，`
    + `${result.injectability.blocked} 条平时只在 \`memory_recall\` 里可按需检索，`
    + '查询命中标识符时才进入每轮摘要。')
  out.push('')
  for (const [project, topics] of [...byProject.entries()].sort((a, b) => size(b[1]) - size(a[1]))) {
    out.push(`## ${project}（${size(topics)} 条）`)
    out.push('')
    for (const [topic, list] of [...topics.entries()].sort((a, b) => b[1].length - a[1].length)) {
      out.push(`### ${topic === '' ? '(无主题)' : topic}（${list.length} 条）`)
      out.push('')
      for (const index of list) {
        const { record } = result.rows[index] 
        const body = record.body.replace(/\s+/g, ' ').trim()
        const excerpt = body.length > 260 ? `${body.slice(0, 260)}…` : body
        out.push(`- **${record.title}**`)
        out.push(`  - ${excerpt}`)
        out.push(`  - \`${record.evidence}\` · \`${record.kind}\` · ${new Date(record.createdAt).toISOString().slice(0, 10)}`)
      }
      out.push('')
    }
  }
  return out.join('\n')
}

function renderTsv(result             )         {
  const esc = (value         )         => String(value).replace(/\t/g, ' ').replace(/\r?\n/g, '\\n')
  const missingByRecord = new Map                  ()
  for (const finding of result.pathIssues.missing) {
    for (const index of finding.records) {
      missingByRecord.set(index, [...(missingByRecord.get(index) ?? []), finding.path])
    }
  }
  const commandByRecord = new Map                  ()
  for (const finding of result.commandIssues) {
    for (const index of finding.records) {
      commandByRecord.set(index, [...(commandByRecord.get(index) ?? []), finding.name])
    }
  }
  const rows = ['序号\t库\t类型\t证据\t状态\tscope\t创建时间\t标题\t正文\t教训\t失败模式\tsubject\t路径问题\t命令问题\t标记']
  for (const [index, { record, store }] of result.rows.entries()) {
    const marks           = []
    if (result.quality.question.includes(index)) marks.push('疑问句')
    if (result.quality.placeholder.includes(index)) marks.push('占位符')
    if (result.quality.selfReferential.includes(index)) marks.push('自指')
    if (result.quality.tooShort.includes(index)) marks.push('过短')
    if (result.quality.noLesson.includes(index)) marks.push('无教训')
    rows.push([
      index, store.projectRoot, record.kind, record.evidence, record.status, record.scope,
      new Date(record.createdAt).toISOString().slice(0, 10),
      record.title, record.body, record.lesson, record.failureMode, record.trigger,
      (missingByRecord.get(index) ?? []).join(' '),
      (commandByRecord.get(index) ?? []).join(' '),
      marks.join(' '),
    ].map(esc).join('\t'))
  }
  return rows.join('\n')
}

/**
 * The recommendation in the form the importer can obey, so the funnel is not
 * re-derived (and cannot drift) at import time. It is plain JSON on purpose: it
 * is meant to be reviewed, and entries can be deleted before importing.
 */
function renderSelection(result             )         {
  return `${JSON.stringify({
    generatedFrom: result.root,
    generatedAt: new Date(result.now).toISOString(),
    criteria: `confirmed, evidence-graded, not self-referential, unique per workspace, `
      + `body >= ${SUBSTANTIVE_MIN_CHARS} characters`,
    count: result.recommended.length,
    records: result.recommended.map(index => {
      const { record, store } = result.rows[index] 
      return {
        workspaceId: record.workspaceId,
        contentFingerprint: record.contentFingerprint,
        project: store.projectRoot,
        title: record.title,
        evidence: record.evidence,
        kind: record.kind,
      }
    }),
  }, null, 2)}\n`
}

/** File names the four reports are written under. */
export const AUDIT_FILES = {
  audit: 'legacy-memory-audit.md',
  recommended: 'legacy-memory-recommended.md',
  selection: 'legacy-memory-selection.json',
  tsv: 'legacy-memory-records.tsv',
}         

/** Write the four reports into `dir` and return their paths. */
export function writeAuditReports(result             , dir        )                                           {
  mkdirSync(dir, { recursive: true })
  const paths = {
    audit: join(dir, AUDIT_FILES.audit),
    recommended: join(dir, AUDIT_FILES.recommended),
    selection: join(dir, AUDIT_FILES.selection),
    tsv: join(dir, AUDIT_FILES.tsv),
  }
  writeFileSync(paths.audit, result.reports.audit, 'utf8')
  writeFileSync(paths.recommended, result.reports.recommended, 'utf8')
  writeFileSync(paths.selection, result.reports.selection, 'utf8')
  writeFileSync(paths.tsv, result.reports.tsv, 'utf8')
  return paths
}

/** A short human summary of an audit, for a console or a slash command. */
export function summarizeAudit(result             )         {
  const { funnel, injectability, duplicates, contradictions, pathIssues, commandIssues } = result
  return [
    `活动库 ${result.stores} 个，副本库 ${result.excludedStores.length} 个`,
    `原始记录 ${result.rawRecords} 条，可映射 ${result.mapped} 条`,
    `跳过：${Object.entries(result.skipped).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join('、') || '无'}`,
    `建议导入 ${funnel.substantive} 条（漏斗 ${funnel.all} → ${funnel.confirmed} → ${funnel.proofBacked} → ${funnel.substantive}）`,
    `注入实测：立即合格 ${injectability.ready} 条，命中标识符后合格 ${injectability.withIdentifier} 条`,
    `不可达路径 ${pathIssues.missing.length} 个，缺失命令 ${commandIssues.length} 个`,
    `精确重复 ${duplicates.exact.length} 组，近重复 ${duplicates.near.length} 对，极性矛盾 ${contradictions.polarity.length} 对`,
  ].join('\n')
}
