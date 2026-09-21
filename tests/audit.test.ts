/**
 * Legacy-audit regressions.
 *
 * The audit used to live in a script, which meant its analysis could only be
 * checked by running it by hand against whatever happened to be on disk. Moving
 * it into the library makes each rule assertable, and these cases pin the ones
 * that decide what a person is told: which paths are broken, which records are
 * duplicates, and what the recommendation funnel keeps.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, eq } from './assert.ts'
import {
  auditLegacy, classifyPath, SUBSTANTIVE_MIN_CHARS, summarizeAudit, tally, topicOf,
  writeAuditReports, AUDIT_FILES,
} from '../src/audit.ts'

const NOW = 1_800_000_000_000

export function run(): void {
  // ── Pure helpers ─────────────────────────────────────────────────────────
  eq(tally(['a', 'b', 'a']), { a: 2, b: 1 }, 'tally counts and sorts by frequency')

  // A path glued to prose must not read as a missing path. This is the rule that
  // turned a false "record teaches something impossible" into a present path.
  const onlyProse = (path: string): boolean => path === 'F:\\proj\\name'
  eq(classifyPath('F:\\proj\\name', onlyProse), { kind: 'present' }, 'an existing path is present')
  eq(classifyPath('F:\\proj\\name是当前实现；相邻目录是历史', onlyProse),
    { kind: 'prose-suffixed', prefix: 'F:\\proj\\name' },
    'a path with prose glued to it is not reported as missing')
  eq(classifyPath('F:\\proj\\name\\gone.txt', onlyProse),
    { kind: 'missing-segment', prefix: 'F:\\proj\\name' },
    'a genuinely absent final segment is reported, with the prefix that does exist')
  eq(classifyPath('Z:\\nothing', () => false).kind, 'missing-segment',
    'a path with no existing prefix at all is reported')

  // Two branches, both intentional: a surviving colon gives the subject label,
  // and otherwise the title is taken as its own prefix so such records still
  // group together instead of each becoming a category.
  eq(topicOf('交付漂移：子标题'), '交付漂移', 'a surviving colon yields the subject label')
  eq(topicOf('已核验静态：门禁风险（2026-09-14实施前）'), '门禁风险…',
    'when the label strip consumes the colon, the prefix branch marks the result')
  eq(topicOf('没有冒号的标题就在这里'), '没有冒号的标题就在这…', 'a title with no colon falls back to a short prefix')

  // ── A synthetic archive, so every rule has something to bite on ──────────
  const dir = mkdtempSync(join(tmpdir(), 'expmem-audit-'))
  try {
    const project = join(dir, 'live-project')
    const memory = join(project, '.memory')
    mkdirSync(memory, { recursive: true })
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: '@acme/live' }))

    const verified = { proof: { kind: 'file' } }
    const long = (text: string): string => `${text}${'说明'.repeat(30)}`
    // Real archived records carry a `created_at`, and the importer preserves it so
    // staleness measures how old the *knowledge* is. Without one every record would
    // look brand new and the injectability measurement below would be vacuous.
    // 30 days is inside the 180-day review period but old enough to cost enough
    // score to matter — which is exactly the band the real archive sat in.
    const created_at = new Date(NOW - 30 * 86_400_000).toISOString()
    const entries = [
      { type: 'fact', text: `引用不存在的路径 Z:\\nope\\missing.txt 的说明文字${'补充'.repeat(20)}`,
        summary: '路径缺失', status: 'confirmed', admission: verified },
      { type: 'fact', text: `引用存在的路径 F:\\proj\\name 的说明文字${'补充'.repeat(20)}`,
        summary: '路径存在', status: 'confirmed', admission: verified },
      { type: 'fact', text: `用 \`pwsh\` 跑脚本的说明文字${'补充'.repeat(20)}`,
        summary: '缺失命令', status: 'confirmed', admission: verified },
      // A backticked name that is not a command-line tool must not be reported;
      // treating every inline-code span as a command produced noise, not findings.
      { type: 'fact', text: `结论分为 \`RUNTIME_REQUIRED\` 等标签的说明文字${'补充'.repeat(20)}`,
        summary: '标识符不是命令', status: 'confirmed', admission: verified },
      { type: 'fact', text: long('重复断言'), summary: '标题甲', status: 'confirmed', admission: verified },
      { type: 'fact', text: long('重复断言'), summary: '标题乙', status: 'confirmed', admission: verified },
      // Written by the old runtime as `type: fact` with tool proof, so it carries
      // the strongest grade while asserting nothing.
      { type: 'fact', text: 'Tool call_00_abcdefghijklmnopqrst exited 1', summary: '工具事件',
        status: 'confirmed', admission: { proof: { kind: 'tool' } } },
      { type: 'fact', text: `候选记录不该被建议导入${'补充'.repeat(20)}`, summary: '候选', status: 'candidate' },
      { type: 'fact', text: `推断记录从没被验证过${'补充'.repeat(20)}`, summary: '推断', status: 'confirmed' },
      { type: 'fact', text: `这条在讲记忆库自己的指纹和布局${'补充'.repeat(20)}`,
        summary: '自指', status: 'confirmed', admission: verified },
      { type: 'fact', text: '太短', summary: '短', status: 'confirmed', admission: verified },
      { type: 'fact', text: long('值得保留的项目约束'), summary: '常设约束', status: 'confirmed', admission: verified },
    ].map(entry => ({ created_at, ...entry }))
    writeFileSync(join(memory, 'entries.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')

    // A copy of a live store. Auditing it would multiply one lesson by however
    // many snapshots exist.
    const backup = join(dir, 'backup', '.codex', 'project-memory-backups', 'stamp', '.memory')
    mkdirSync(backup, { recursive: true })
    writeFileSync(join(backup, 'entries.jsonl'),
      `${JSON.stringify({ type: 'fact', text: long('副本里的记录'), summary: '副本' })}\n`, 'utf8')

    const result = auditLegacy({
      root: dir,
      now: NOW,
      pathExists: path => path === 'F:\\proj\\name',
      commandExists: () => false,
    })

    // ── Scanning and skipping ─────────────────────────────────────────────
    eq(result.stores, 1, 'only the live store is audited')
    eq(result.excludedStores.length, 1, 'the backup copy is excluded and reported')
    eq(result.skipped['tool-outcome event, not durable knowledge'], 1,
      'a tool-outcome event written as a fact is skipped')
    eq(result.mapped, entries.length - 1, 'the skipped event is not mappable')

    // ── External validity ─────────────────────────────────────────────────
    eq(result.pathIssues.missing.length, 1, 'the genuinely missing path is reported')
    eq(result.pathIssues.missing[0]?.path, 'Z:\\nope\\missing.txt', 'and it is the right one')
    eq(result.pathIssues.proseSuffixed, 0, 'the present path is not reported as prose-suffixed here')
    eq(result.commandIssues.length, 1, 'the missing command-line tool is reported')
    eq(result.commandIssues[0]?.name, 'pwsh', 'and it is the real tool name')
    eq(result.commandIssues.some(item => item.name === 'runtime_required'), false,
      'a backticked identifier is not treated as a command')

    // ── Duplicates ────────────────────────────────────────────────────────
    eq(result.duplicates.exact.length, 1, 'one exact-duplicate group is found')
    eq(result.duplicates.exact[0]?.length, 2, 'and it holds both copies')

    // ── Quality signals ───────────────────────────────────────────────────
    assert(result.quality.selfReferential.length >= 1, 'self-referential text is flagged')
    assert(result.quality.tooShort.length >= 1, 'a very short body is flagged')
    eq(result.quality.question.length, 0, 'no record here is a question')

    // ── The funnel ────────────────────────────────────────────────────────
    const { funnel } = result
    eq(funnel.all, result.mapped, 'the funnel starts at every mappable record')
    assert(funnel.confirmed < funnel.all, 'candidates are dropped first')
    assert(funnel.proofBacked < funnel.confirmed, 'inferred records are dropped next')
    assert(funnel.notSelfReferential < funnel.proofBacked, 'self-referential records are dropped')
    assert(funnel.substantive <= funnel.notSelfReferential, 'short bodies are dropped last')
    assert(funnel.substantive >= 2, 'the substantive records survive')
    assert(result.recommended.every(index =>
      result.rows[index]!.record.body.trim().length >= SUBSTANTIVE_MIN_CHARS),
    'every recommended record clears the length floor')

    // ── Injectability is measured with the framework's own ranking ────────
    eq(result.injectability.ready + result.injectability.blocked, funnel.substantive,
      'every recommended record is classified as ready or blocked')
    // Deliberately not a fixed count: a file-verified record sits 0.5 above the bar, which
    // is about two months of age, so how many are ready depends on how old the fixture is.
    // What must hold is that the gate is not shut to the grade — it was, while the bar sat
    // exactly on that grade's base score and every such record fell under it.
    assert(result.injectability.ready > 0,
      `a verified-file record clears the bar on age alone, so some are ready: ${result.injectability.ready}`)
    assert(result.injectability.withIdentifier >= result.injectability.ready,
      'and an identifier hit can only add to that, never take away')

    // ── Reports ───────────────────────────────────────────────────────────
    assert(result.reports.audit.includes(`${result.mapped} 条可映射记录`),
      'the report states the mappable count it actually found')
    assert(!result.reports.audit.includes('366'), 'and no stale count from an earlier run')
    assert(result.reports.recommended.includes('值得信的经验'), 'the catalogue is rendered')
    assert(result.reports.selection.includes('"records"'), 'the selection document is rendered')
    const summary = summarizeAudit(result)
    assert(summary.includes('建议导入'), 'the summary names the recommendation')

    const selection = JSON.parse(result.reports.selection) as { count: number; records: unknown[] }
    eq(selection.count, funnel.substantive, 'the selection count matches the funnel')
    eq(selection.records.length, funnel.substantive, 'and so does the entry list')
    eq(result.reports.tsv.split('\n').length, result.mapped + 1, 'the TSV has a header plus one row per record')

    const paths = writeAuditReports(result, join(dir, 'out'))
    for (const key of Object.keys(AUDIT_FILES) as (keyof typeof AUDIT_FILES)[]) {
      assert(paths[key].endsWith(AUDIT_FILES[key]), `${key} is written under its documented name`)
    }

    // ── An empty tree is a valid answer, not a crash ──────────────────────
    const empty = auditLegacy({ root: join(dir, 'no-such-dir'), now: NOW })
    eq(empty.mapped, 0, 'a missing root yields no records')
    eq(empty.funnel.substantive, 0, 'and recommends nothing')
    eq(empty.injectability.ready, 0, 'with no injectability to report')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  audit      ok')
}
