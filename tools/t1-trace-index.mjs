#!/usr/bin/env node
/**
 * T1 — Does the writing turn's trace actually carry the index?
 *
 * The claim under test is the one the CBR survey makes and `docs/GROWTH.md` G1 adopts: "the trace
 * of problem-solving behavior provides ready-made information for indexing". If true, `recall_for`
 * can be proposed automatically at write time instead of being hand-written, and the 152 silent
 * records are not a dead account.
 *
 * The test is deliberately narrow and lexical-free. For every `verified-file` record we ask one
 * question: **was the file this record cites named anywhere in the tool calls around the turn that
 * wrote it?** "Around" is the 8 calls either side of the `memory_remember` call. The record's own
 * `source_ref` is used as the ground truth for "the right index" because a human or the verifier
 * chose it — it is the file the lesson is actually written in.
 *
 * Negative control: for the same records, pick a random workspace file and ask the same question.
 * If the random file is named as often as the cited one, the trace carries nothing and any pass is
 * an artefact of the workspace being small.
 *
 *   node tools/t1-trace-index.mjs --cwd <workspace> [--window 8] [--json out.json]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const argv = process.argv.slice(2)
const flag = n => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1] }
const cwd = flag('cwd') ?? process.cwd()
const WINDOW = Number(flag('window') ?? 8)

// ── the store: records whose citation is a real workspace file ──────────────
const store = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'dsh-desktop', 'harness', 'experience-memory', 'memory.db')
if (!existsSync(store)) { console.error('no store at', store); process.exit(1) }
const db = new DatabaseSync(store, { readOnly: true })
const rows = db.prepare(
  `SELECT id, title, trigger, source_ref, body, lesson, failure_mode FROM record
    WHERE status = 'confirmed' AND superseded_by IS NULL AND evidence = 'verified-file'`,
).all()
db.close()

const stripLine = s => String(s ?? '').trim().replace(/:\d+(?::\d+)?$/, '')
const wanted = []
for (const r of rows) {
  const p = stripLine(r.source_ref)
  if (p === '' || /^call_/i.test(p) || /^[a-z]:[\\/]/i.test(p)) continue
  const abs = join(cwd, p.split('/').join(sep))
  if (!existsSync(abs)) continue
  wanted.push({ id: r.id, title: String(r.title), rel: p.toLowerCase(), abs })
}
console.log(`记录（verified-file、出处是工作区真实文件）：${wanted.length}`)

// ── the writing turns, mined from the session logs ──────────────────────────
// The plugin's own `memory_remember` calls carry the record title, which is how a call is tied
// back to the record it wrote.
const sessionsDir = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'dsh-desktop', 'harness', 'sessions')
function walk(dir, out = []) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.isFile() && e.name.endsWith('.jsonl.zstd')) out.push(full)
  }
  return out
}
const logs = walk(sessionsDir)
console.log(`会话日志：${logs.length} 个`)

// Decoding is delegated to the same helper the repo's own tooling uses.
const decoder = logPath => {
  try {
    return execFileSync('python', ['-c',
      'import sys,io,zstandard;print(zstandard.ZstdDecompressor().stream_reader(open(sys.argv[1],"rb")).read().decode("utf-8","replace"))',
      logPath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch { return '' }
}

const CALL = /"type"\s*:\s*"tool\/call"/
// Only a real tool call whose registered name is memory_remember counts. The naive
// `includes('memory_remember')` matched 5,328 lines because the plugin's own per-turn hint names
// that tool in every injected message — the record-hint text is in the log too, and counting it
// produced a corpus of "writes" that were not writes at all (0 records ever matched their title).
const REMEMBER_CALL = /"name"\s*:\s*"memory_remember"/
const PATHISH = /[\w\u4e00-\u9fff.\-]+\.[A-Za-z0-9]{1,6}/g
const hits = new Map()   // record title -> Set of file-ish tokens near the write
let scanned = 0
for (const log of logs) {
  const text = decoder(log)
  if (text === '') continue
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!CALL.test(line) || !REMEMBER_CALL.test(line)) continue
    scanned += 1
    // `data.arguments` is a JSON-*encoded string*, not an inline object — it has to be parsed
    // twice. A regex over the raw line never matches `\"title\"` and silently yields no titles.
    let title = null
    try {
      const ev = JSON.parse(line)
      const argStr = ev?.data?.arguments
      if (typeof argStr === 'string') {
        try { title = JSON.parse(argStr)?.title } catch { /* malformed args */ }
      } else if (argStr && typeof argStr === 'object') {
        title = argStr.title
      }
    } catch { /* not a JSON line */ }
    if (typeof title !== 'string' || title.trim() === '') continue
    const lo = Math.max(0, i - WINDOW), hi = Math.min(lines.length, i + WINDOW)
    // What counts as "the work around the write" is deliberately narrow: **other tool calls**.
    // Excluded are the write itself (its arguments carry `source_ref` — a tautology), and any
    // `memory_*` traffic at all, because a later `memory_recall` echoes the record back verbatim
    // and would re-introduce its own citation through the back door. The first two runs of this
    // test read 159/159 — perfect because it kept measuring the record quoting itself.
    const ctxText = lines.slice(lo, hi)
      .filter(l => /"type"\s*:\s*"tool\/call"/.test(l))
      .filter(l => !/"name"\s*:\s*"memory_/.test(l))
      .join('\n')
    const toks = new Set((ctxText.match(PATHISH) ?? []).map(s => s.toLowerCase()))
    if (!hits.has(title)) hits.set(title, new Set())
    for (const t of toks) hits.get(title).add(t)
  }
}
console.log(`找到 memory_remember 调用：${scanned} 次，其中带标题的 ${hits.size} 个不同标题`)

// ── the question, and its negative control ──────────────────────────────────
// Files the workspace actually has, to draw the random control from. Drawn shallow-first so the
// control has the same rough shape as a real citation.
function indexFiles(root, limit = 4000) {
  const out = []
  const skip = new Set(['node_modules', '.git', '.bigfat', 'dist', 'out', '.cache', 'snapshots', 'papers'])
  const walkDir = dir => {
    if (out.length >= limit) return
    let es = []
    try { es = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      if (out.length >= limit) return
      const full = join(dir, e.name)
      if (e.isDirectory()) { if (!skip.has(e.name)) walkDir(full) }
      else if (e.isFile()) out.push(relative(root, full).replace(/\\/g, '/').toLowerCase())
    }
  }
  walkDir(root)
  return out
}
const allFiles = indexFiles(cwd)
console.log(`工作区文件（对照抽样用）：${allFiles.length}`)

let n = 0, traceHas = 0, ctrlHas = 0, matched2 = 0
const rowsOut = []
for (const w of wanted) {
  const toks = hits.get(w.title)
  if (toks === undefined) continue            // no writing turn found — reported separately
  matched2 += 1
  const base = (w.rel.split('/').pop() ?? w.rel)
  const yes = toks.has(w.rel) || toks.has(base)
  // control: a file that exists but is not the cited one
  let ctrl = null
  for (let k = 0; k < 40 && ctrl === null; k += 1) {
    const cand = allFiles[Math.floor(Math.random() * allFiles.length)]
    if (cand && cand !== w.rel) ctrl = cand
  }
  const ctrlYes = ctrl !== null && (toks.has(ctrl) || toks.has(ctrl.split('/').pop()))
  n += 1
  if (yes) traceHas += 1
  if (ctrlYes) ctrlHas += 1
  rowsOut.push({ id: w.id, rel: w.rel, traceNamesIt: yes, control: ctrl, controlNamed: ctrlYes, title: w.title.slice(0, 60) })
}

console.log('')
console.log(`=== T1 结果 ===`)
console.log(`能对上写入回合的记录：${matched2}（其余 ${wanted.length - matched2} 条找不到写入回合）`)
console.log(`写入轨迹里点名了出处文件：${traceHas}/${n} = ${(traceHas / n * 100).toFixed(1)}%   ← 阳性`)
console.log(`写入轨迹里点名了随机文件：${ctrlHas}/${n} = ${(ctrlHas / n * 100).toFixed(1)}%   ← 阴性对照`)
console.log('')
console.log('判据（先声明）：阳性 ≥70% 且 阴性 ≤10% ⇒ 轨迹确实携带索引信息。')
const pass = n > 0 && (traceHas / n) >= 0.7 && (ctrlHas / n) <= 0.10
console.log(pass ? '结论：**通过** —— 索引可以从写入轨迹自动归纳。'
  : (n > 0 && (traceHas / n) > (ctrlHas / n) * 2 && (traceHas / n) >= 0.4
    ? '结论：**部分通过** —— 轨迹有信号但不够强，可以做"提议+人确认"，不能自动写死。'
    : '结论：**不通过** —— 轨迹不携带索引信息（或与随机无异），"从轨迹归纳"在本语料上不成立。'))

const outPath = flag('json') ?? 'tools/t1-trace-index.result.json'
writeFileSync(outPath, JSON.stringify({ window: WINDOW, records: wanted.length, withWriteTurn: matched2, traceNamesIt: traceHas, controlNamed: ctrlHas, rows: rowsOut }, null, 1), 'utf8')
console.log(`\n明细：${outPath}`)
