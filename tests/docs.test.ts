/**
 * Documented facts, checked against the code.
 *
 * Two defects of the same class prompted this suite, and neither was a lie told on
 * purpose — both were claims that nobody was watching:
 *
 *   - the README said the two digest sections "together cap at five records". The
 *     record ceiling is applied *per section* (the `.slice()` sits inside the
 *     section loop), so with the shipped configuration the real ceiling is
 *     2 + 5 = 7. The suite only ever asserted the byte ceiling the two sections
 *     share, and never filled two sections at once, so nothing contradicted the
 *     prose. A claim no test pins is a claim that drifts.
 *   - four source comments declared the model's tool surface to be four, in files
 *     that register five tools. The tests said five throughout; only the prose
 *     said four, so nothing failed.
 *
 * So this suite watches the claims that can be checked mechanically, and only
 * those: configuration defaults, the surface name lists, the digest's real
 * per-section ceilings, and the set of files an audit writes.
 *
 * Prose is deliberately not parsed. A test that scraped Markdown would break on
 * every rewording while still missing a claim phrased differently. Instead each
 * checked number is mirrored here exactly once, and each message names the
 * promise in the README that says the same thing — so changing either side fails
 * loudly and quotes the other.
 *
 * Two files carry the claims: `README.md` (Chinese, the document the plugin is
 * used from) and `README.en.md` (the English mirror). They share the same heading
 * text on purpose, so one set of anchors locates a promise in either, and the
 * name lists are read off both — a mirror that quietly loses a tool is the same
 * defect as a table that never had it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { assert, eq } from './assert.ts'
import { AUDIT_FILES } from '../src/audit.ts'
import { COMMAND_NAMES, commandDefinitions } from '../src/commands.ts'
import { resolveConfig } from '../src/config.ts'
import { defaultDbPath, openDb, upsert } from '../src/db.ts'
import { CORE_LABEL, MATCHED_LABEL, RECORD_HINT, RECORD_HINT_MAX_BYTES, buildDigest } from '../src/digest.ts'
import { byteLength, renderDigest } from '../src/inject.ts'
import * as experienceMemory from '../src/index.ts'
import type { MemoryRecord, RankedRecord } from '../src/types.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** A fixed clock, so nothing here depends on when it runs. */
const NOW = 1_800_000_000_000

/**
 * The surfaces, read off the README's own tables.
 *
 * These were hand-written mirrors, and the assertion below then compared the code against the
 * mirror — so adding a command failed only if whoever added it also forgot the mirror, while a
 * command that was never documented anywhere passed as soon as both sides were edited. That is
 * the same defect the config keys had (see `configKeys` below), in the same file, caught the
 * same way: by the check having to be edited to stay green rather than by it catching anything.
 */
function tableNames(readme: string, row: RegExp): string[] {
  const names: string[] = []
  for (const line of readme.split('\n')) {
    const match = row.exec(line.trim())
    if (match?.[1] !== undefined) names.push(match[1])
  }
  return names
}

/** Tool rows read `| \`memory_recall\` | … |`; command rows `| \`/memory-status\` | … |`. */
const toolNames = (readme: string): string[] => tableNames(readme, /^\|\s*`(memory_[a-z_]+)`\s*\|/)
const commandList = (readme: string): string[] => tableNames(readme, /^\|\s*`\/(memory-[a-z-]+)`\s*\|/)


/**
 * Every key `Config` accepts, read from the code rather than listed here.
 *
 * This was a hand-written mirror of `src/config.ts`, and the assertion below computed
 * `resolveConfig({})` only to compare it against the mirror. Adding a config key without
 * documenting it therefore passed in silence — which is the one thing the assertion claims to
 * catch. Reading the keys off the resolver is the difference between a check and a habit.
 */
const configKeys = (): string[] => Object.keys(resolveConfig({}))

const readmeZh = readFileSync(join(ROOT, 'README.md'), 'utf8')
const readmeEn = readFileSync(join(ROOT, 'README.en.md'), 'utf8')
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')

/**
 * The headings this suite reads a claim out of, written once.
 *
 * `sectionOf` matches a heading by exact line equality, so renaming one in the
 * README without touching this map turns five assertions into "no such section"
 * failures. That is the intended behaviour — a check that cannot find its anchor
 * must fail rather than pass on an empty string — but the strings live here so a
 * rename is one edit, not five. The map is also what pins the two language files
 * to the same structure.
 */
const SECTION_ANCHORS = {
  config: '## 配置',
  experience: '## 模型的体验（Model Experience）',
  surfaces: '### 它挂了四个表面',
  tokenEffect: '#### Token effect',
  limitations: '## Known Limitations and Deferred Work',
} as const

function record(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'r1',
    workspaceId: 'wsA',
    domain: 'python/testing',
    scope: 'workspace',
    kind: 'fact',
    status: 'confirmed',
    evidence: 'verified-tool',
    title: '标题',
    body: '正文',
    trigger: '',
    failureMode: '',
    lesson: '教训',
    sourceRef: '',
    reuseCount: 0,
    successCount: 0,
    failureCount: 0,
    failStreak: 0,
    distinctWorkspaces: 1,
    createdAt: NOW,
    occurredAt: NOW,
    updatedAt: NOW,
    lastUsedAt: NOW,
    reviewAfter: null,
    expiresAt: null,
    contentFingerprint: 'fp',
    supersededBy: null,
    needsReview: null,
    ...over,
  }
}

function ranked(id: string, over: Partial<MemoryRecord> = {}): RankedRecord {
  return { record: record({ id, ...over }), importance: 9, bm25: 0, identifierMatches: 0, why: '' }
}

/**
 * How many record lines one labeled section of a digest emitted.
 *
 * The digest is label line + `- [...]` lines per section, so counting the lines
 * after each label is how the ceiling becomes observable rather than asserted.
 */
function sectionLines(digest: string, label: string): number {
  const lines = digest.split('\n')
  const at = lines.indexOf(label)
  if (at < 0) return 0
  let count = 0
  // A record line starts with `- [`; the next section opens with a bare label.
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('- [')) break
    count += 1
  }
  return count
}

/**
 * The default column of the README's `## 配置` table, read rather than trusted.
 *
 * The table has a fixed shape — ``| `key` | `value` | meaning |`` — so parsing it
 * is structure, not prose scraping. Free-form sentences are still not checked;
 * this watches the documented defaults, which is the reference a reader acts on.
 */
function readmeConfigDefaults(text: string, heading: string = SECTION_ANCHORS.config): Record<string, string> {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === heading)
  assert(start >= 0, `the README still has a ${heading} section to check`)
  const found: Record<string, string> = {}
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map(cell => cell.trim())
    const key = /^`([^`]+)`$/.exec(cells[1] ?? '')?.[1]
    const value = /^`(.*)`$/.exec(cells[2] ?? '')?.[1]
    if (key !== undefined && value !== undefined) found[key] = value
  }
  return found
}

/**
 * One section of the README, so a claim is checked where it is made.
 *
 * Presence anywhere in the file is too weak: this assertion first failed to catch a
 * reinstated error precisely because the same token appeared in an unrelated table
 * row. A section ends at the next heading of the same or a higher level, so
 * requesting `#### Token effect` yields that subsection alone rather than everything
 * up to the next top-level heading.
 */
function sectionOf(text: string, heading: string): string {
  const level = /^#+/.exec(heading.trim())?.[0].length ?? 1
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === heading)
  assert(start >= 0, `the README still has a ${heading} section to check`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => {
    const found = /^(#+)\s/.exec(line.trim())
    return found !== null && found[1]!.length <= level
  })
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

export async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'expmem-docs-'))
  const ctx = new Context()

  try {
    // ── The README config table, value by value ─────────────────────────────
    // The table is the normative description of these keys, so it is compared
    // with the code in both directions: edit a default in `config.ts` and this
    // fails, edit the table alone and this fails too.
    const resolved = resolveConfig({})
    const documented = readmeConfigDefaults(readmeZh)
    eq(Object.keys(documented).sort(), configKeys().sort(),
      'the README config table documents exactly the keys the plugin accepts, and no others')
    assert((documented['dbPath'] ?? '').includes('experience-memory/memory.db'),
      `README: the default store lives at <DSH_HOME>/experience-memory/memory.db, table says ${String(documented['dbPath'])}`)
    eq(
      {
        enabled: documented['enabled'] === 'true',
        residentMaxRecords: Number(documented['residentMaxRecords']),
        residentMaxBytes: Number(documented['residentMaxBytes']),
        coreMaxRecords: Number(documented['coreMaxRecords']),
        recallMaxBytes: Number(documented['recallMaxBytes']),
        defaultDomain: documented['defaultDomain'] === "''" ? '' : String(documented['defaultDomain']),
        maintenanceBatchSize: Number(documented['maintenanceBatchSize']),
        failStreakLimit: Number(documented['failStreakLimit']),
      },
      {
        enabled: resolved.enabled,
        residentMaxRecords: resolved.residentMaxRecords,
        residentMaxBytes: resolved.residentMaxBytes,
        coreMaxRecords: resolved.coreMaxRecords,
        recallMaxBytes: resolved.recallMaxBytes,
        defaultDomain: resolved.defaultDomain,
        maintenanceBatchSize: resolved.maintenanceBatchSize,
        failStreakLimit: resolved.failStreakLimit,
      },
      'the README config table and resolveConfig({}) must agree — the table is what a reader configures against',
    )

    // And the code against the numbers this suite believes, so a change to
    // `config.ts` is caught even when the README is edited to match it.
    eq(
      {
        residentMaxRecords: resolved.residentMaxRecords,
        residentMaxBytes: resolved.residentMaxBytes,
        coreMaxRecords: resolved.coreMaxRecords,
        recallMaxBytes: resolved.recallMaxBytes,
        defaultDomain: resolved.defaultDomain,
        maintenanceBatchSize: resolved.maintenanceBatchSize,
        failStreakLimit: resolved.failStreakLimit,
      },
      {
        residentMaxRecords: 5,
        residentMaxBytes: 1536,
        coreMaxRecords: 2,
        recallMaxBytes: 16384,
        defaultDomain: '',
        maintenanceBatchSize: 32,
        failStreakLimit: 2,
      },
      'these are the defaults the README documents; changing one means changing both sides',
    )
    eq(resolved.enabled, true, 'README: enabled defaults to true')
    eq(resolved.dbPath, undefined, 'README: dbPath defaults to the store the plugin resolves itself')
    assert(defaultDbPath().replace(/\\/g, '/').endsWith('experience-memory/memory.db'),
      `README: the default store lives at <DSH_HOME>/experience-memory/memory.db, got ${defaultDbPath()}`)

    // ── Numbers the README states in prose ──────────────────────────────────
    // Not a prose checker: these are exact tokens derived from code, so a
    // rewording that keeps the numbers still passes. They are checked inside the
    // section that makes the promise, because a token found anywhere proves
    // nothing — the first version of this check missed a reinstated false claim
    // exactly that way.
    const ceiling = `${resolved.coreMaxRecords}+${resolved.residentMaxRecords}=${resolved.coreMaxRecords + resolved.residentMaxRecords}`
    const experience = sectionOf(readmeZh, SECTION_ANCHORS.experience)
    assert(experience.includes(ceiling),
      `the README's Model Experience section states the digest ceiling as ${ceiling} records,`
      + ' which is coreMaxRecords + residentMaxRecords')
    // The record ceiling is per section, so a *combined* record cap is always the
    // wrong shape regardless of the number in it. This is the specific claim that
    // was false, pinned as a forbidden phrasing rather than a remembered number.
    assert(!experience.includes('两段合计最多'),
      'the README does not claim a combined record ceiling for the two sections — only their byte budget is shared')
    const suitesOnDisk = readdirSync(join(ROOT, 'tests')).filter(name => name.endsWith('.test.ts')).length
    assert(readmeZh.includes(`${suitesOnDisk} 个套件`),
      `README states the suite count as ${suitesOnDisk}, which is how many *.test.ts files exist`)
    for (const file of Object.values(AUDIT_FILES)) {
      assert(readmeZh.includes(file), `README names the audit report ${file} that the audit actually writes`)
    }

    // ── Every key is restated in the bundle patch ───────────────────────────
    // `cordis.patch.yml` says of itself that a patch replaces the whole `config`
    // object, so a key left out is a key whose effective value is invisible from
    // that file. `failStreakLimit` was missing until this suite existed.
    // `dbPath` is the deliberate exception: omitting it is what selects the
    // default location asserted above.
    for (const key of configKeys()) {
      if (key === 'dbPath') continue
      assert(new RegExp(`^\\s*${key}:`, 'm').test(patch),
        `cordis.patch.yml restates ${key}, because a patch replaces the whole config object`)
    }

    // ── Only one limit may be zero ─────────────────────────────────────────
    eq(resolveConfig({ coreMaxRecords: 0 }).coreMaxRecords, 0,
      'README: coreMaxRecords is the one limit allowed to be 0, where 0 means "core layer off"')
    for (const key of ['residentMaxRecords', 'residentMaxBytes', 'recallMaxBytes', 'maintenanceBatchSize', 'failStreakLimit']) {
      let threw = false
      try {
        resolveConfig({ [key]: 0 })
      } catch {
        threw = true
      }
      assert(threw, `README: ${key} rejects 0, because a zero ceiling is indistinguishable from "off"`)
    }

    // ── The surface name lists ─────────────────────────────────────────────
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(Commands, {})
    await ctx.plugin(experienceMemory, { enabled: true, dbPath: join(dir, 'mount.db') })

    const registered = ctx.tools.schemas().map(schema => schema.name).sort()
    eq(registered, toolNames(readmeZh).sort(),
      'the registered tools are exactly the ones the README tool table lists — no more, no fewer')

    const agent = { id: 'docs-session', session: { header: { cwd: dir }, snapshotEvents: () => [], append: () => {} } }
    const listed = ctx.commands.list(agent).map(entry => entry.name).filter(name => name.startsWith('memory-')).sort()
    const inTable = commandList(readmeZh).sort()
    assert(inTable.length >= 6, `the README command table was actually parsed: ${inTable.join(', ')}`)
    eq(listed, inTable,
      'the registered commands are exactly the ones the README command table lists')
    eq([...COMMAND_NAMES].sort(), inTable, 'COMMAND_NAMES says the same ones')

    // Presence, not placement: enough to catch a rename landing on one side only.
    for (const name of [...toolNames(readmeZh), ...inTable]) {
      assert(readmeZh.includes(name), `${name} is named in the README, so the identifier and the docs agree`)
    }

    // ── The always-on hint is bounded, and its cost is documented ───────────
    // It is injected on every turn whether or not there is anything to remember,
    // which is the only way it can reach a store that is still empty — so its cost
    // is a decision that must not drift upward unnoticed. The README states both the
    // current size and the ceiling, so both are checked rather than remembered.
    assert(RECORD_HINT.trim() !== '', 'the standing record hint is not empty')
    assert(RECORD_HINT.includes('memory_remember'),
      'and it names the tool, so the model can act on it without guessing')
    assert(byteLength(RECORD_HINT) <= RECORD_HINT_MAX_BYTES,
      `the standing record hint costs at most ${RECORD_HINT_MAX_BYTES} bytes on every turn;`
      + ` it is now ${byteLength(RECORD_HINT)}`)
    // The README states this cost in three separate places, so each is checked where
    // it is written. Searching the whole file was the mistake made twice already: a
    // wrong number in one place passes as long as the right one survives elsewhere.
    const size = `${byteLength(RECORD_HINT)} 字节`
    const hintCeiling = `${RECORD_HINT_MAX_BYTES} 字节`
    const surfaces = sectionOf(readmeZh, SECTION_ANCHORS.surfaces)
    const tokenEffect = sectionOf(readmeZh, SECTION_ANCHORS.tokenEffect)
    const limitations = sectionOf(readmeZh, SECTION_ANCHORS.limitations)
    assert(surfaces.includes(size), `the surface table states the hint's cost as ${size}`)
    assert(tokenEffect.includes(size), `the token-effect section states the hint's cost as ${size}`)
    assert(tokenEffect.includes(hintCeiling), `the token-effect section states the ceiling as ${hintCeiling}`)
    assert(limitations.includes(size), `the limitations section states the hint's cost as ${size}`)
    assert(limitations.includes(hintCeiling), `the limitations section states the ceiling as ${hintCeiling}`)

    // ── The digest ceiling is per section, not in total ─────────────────────
    // The mechanism, stated as a mechanism: `maxRecords` is applied inside the
    // section loop, so two sections may each reach it.
    const ten = Array.from({ length: 10 }, (_, index) => ranked(`r${index}`))
    const perSection = renderDigest(
      [{ label: '甲：', ranked: ten }, { label: '乙：', ranked: ten }],
      { maxRecords: 3, maxBytes: 100_000 },
    )
    eq(sectionLines(perSection, '甲：'), 3, 'a per-section ceiling of 3 gives the first section 3 lines')
    eq(sectionLines(perSection, '乙：'), 3, 'and the second section its own 3, not 3 between them')
    eq(perSection.split('\n').filter(line => line.startsWith('- [')).length, 6,
      'so the ceiling is per section — the README once said the two sections "together cap at five records"')

    // The same ceiling through the real pipeline, where the two sections are
    // filled from a database rather than handed in.
    const db: DatabaseSync = openDb(join(dir, 'digest.db'))
    try {
      // Core candidates: corroborated, domain-level, and deliberately NOT
      // matching the query, because the core layer is not query-gated.
      for (let index = 0; index < 4; index += 1) {
        upsert(db, record({
          id: `c${index}`,
          scope: 'domain',
          domain: 'python/testing',
          distinctWorkspaces: 2,
          title: `核心${index}`,
          body: '与查询无关的正文',
          contentFingerprint: `fp-c${index}`,
        }))
      }
      // Query-matched candidates, more than the resident ceiling, so the ceiling
      // is what decides how many lines appear.
      for (let index = 0; index < 8; index += 1) {
        upsert(db, record({
          id: `m${index}`,
          title: `相关${index}`,
          body: '部署先写备份',
          contentFingerprint: `fp-m${index}`,
        }))
      }

      const config = resolveConfig({})
      const digest = buildDigest({
        db,
        config,
        workspace: { id: 'wsA', domain: 'python/testing' },
        query: '部署',
        now: NOW,
      })
      const core = sectionLines(digest, CORE_LABEL)
      const matched = sectionLines(digest, MATCHED_LABEL)
      eq(core, config.coreMaxRecords, 'the core section stops at coreMaxRecords')
      eq(matched, config.residentMaxRecords, 'the matched section stops at residentMaxRecords')
      eq(core + matched, config.coreMaxRecords + config.residentMaxRecords,
        'with the shipped config the digest emits at most 2 + 5 = 7 record lines, not 5 in total')
      assert(byteLength(digest) <= config.residentMaxBytes,
        `both sections together respect the one shared ${config.residentMaxBytes}-byte ceiling`)
    } finally {
      db.close()
    }

    // ── An audit writes four reports, and says four ────────────────────────
    // It used to write four and name two, so an operator could not find the
    // recommended catalogue or the full record dump — the two most useful when
    // deciding what to import.
    eq(Object.keys(AUDIT_FILES).sort(), ['audit', 'recommended', 'selection', 'tsv'],
      'README: the audit writes four reports')
    const reportDir = join(dir, 'reports')
    const auditDb = openDb(join(dir, 'audit.db'))
    try {
      const definitions = commandDefinitions({
        db: auditDb,
        config: resolveConfig({ dbPath: join(dir, 'audit.db') }),
        reportDir,
      })
      const definition = definitions.find(entry => entry.name === 'memory-audit')
      assert(definition !== undefined, 'the audit command is registered')
      const archive = join(dir, 'archive')
      mkdirSync(archive, { recursive: true })
      const result = await definition!.handler({ rawInput: archive })
      assert(result.kind === 'success', `an empty archive audits without failing: ${JSON.stringify(result)}`)
      const text = result.kind === 'success' ? result.text ?? '' : result.text
      for (const [kind, file] of Object.entries(AUDIT_FILES)) {
        assert(text.includes(file), `the audit output names ${file} (${kind}), the report it just wrote`)
        assert(existsSync(join(reportDir, file)), `${file} really is on disk after the audit`)
      }
    } finally {
      auditDb.close()
    }

    // ── The English mirror makes the same claims ────────────────────────────
    // `README.en.md` is not decoration: it is read by people who will install the
    // plugin and then wonder why a tool the other file lists is missing. Its
    // headings are translated, so this cannot compare the text — what it compares
    // is the *shape* (how many sections at each level, in order) plus the shared
    // anchors, and then it runs the same readers over both files for the names,
    // the config keys, the audit files and the two code-derived numbers.
    const headingLevels = (text: string): number[] =>
      text.split('\n').map(line => /^(#{2,3})\s/.exec(line.trim())?.[1].length ?? 0).filter(level => level > 0)
    eq(headingLevels(readmeEn), headingLevels(readmeZh),
      'README.en.md has as many sections, at the same levels and in the same order, as README.md')
    for (const anchor of Object.values(SECTION_ANCHORS)) {
      assert(readmeEn.includes(anchor), `README.en.md has the ${anchor} section, so its anchors resolve`)
    }
    eq(toolNames(readmeEn).sort(), toolNames(readmeZh).sort(),
      'both READMEs list the same model tools')
    eq(commandList(readmeEn).sort(), commandList(readmeZh).sort(),
      'both READMEs list the same slash commands')
    eq(Object.keys(readmeConfigDefaults(readmeEn, '## Configuration')).sort(), configKeys().sort(),
      'the English config table documents the same keys the plugin accepts')
    assert(readmeEn.includes(`${suitesOnDisk} 个套件`),
      `README.en.md states the suite count as ${suitesOnDisk} too, so neither side goes stale alone`)
    assert(readmeEn.includes(ceiling),
      `README.en.md states the digest ceiling as ${ceiling} as well`)
    for (const file of Object.values(AUDIT_FILES)) {
      assert(readmeEn.includes(file), `README.en.md names the audit report ${file}`)
    }

    console.log('  docs       ok')
    console.log(`             (README.md + README.en.md, ${String(suitesOnDisk)} suites pinned)`)
  } finally {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}
