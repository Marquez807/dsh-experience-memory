/**
 * L1 对照实验：摘要行该带**答案**，还是只带**答案的地址**？
 *
 *   node tools/l1-ab/run-l1.mjs [Trials] [Arms]
 *   node tools/l1-ab/run-l1.mjs 8 thick,thin
 *
 * 两臂只差一个配置键（`thinDigest`），每格跑之前写进隔离 profile 的 cordis.patch.yml；
 * 库、任务、模型、提示词全部相同。判定**只看产物**：agent 写的那个 .py 文件的第一行。
 * 另从隔离库读一个数：这条记录被取回了几次——那正是"薄摘要到底会不会被去取"的判据。
 *
 * 为什么用 Node 而不是 .ps1：本机执行策略会拦下未签名的脚本（实测 UnauthorizedAccess），
 * 而 Node 不受这条策略管。
 *
 * 为什么格子目录用哈希：**目录名会进检索查询，也会被模型看见**。第一版叫 `cell-thin-1`，
 * 等于在告诉模型它在哪一组——这是实验污染（standing-ab 的 4/4 假阳性就是路径共词造成的）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb, upsert } from '../../lib/db.js'
import { resolveWorkspace } from '../../lib/domain.js'

// 官方版（DeepSeek Harness）的 headless 入口在 `app.asar` **里面**，不能直接用 node 跑：asar 是归档，
// 要用 Electron 自己的 node 模式——设 `ELECTRON_RUN_AS_NODE=1`，把 exe 当解释器、把 asar 内的
// `dsh/lib/bin.js` 当脚本。同一条 exe + bin.js 配上 `--profile <名字> --dump-config` 就能**零副作用**
// 地验证配置合成（隔离实验里确认"那一臂的开关真的生效了"用的就是它）。
// 老壳（第三方 DSH Desktop）的程序目录已不存在，所以 `tools/standing-ab/` 那套脚本今天跑不起来。
const exe = 'F:\\DeepSeek Harness\\DeepSeek Harness.exe'
const asar = 'F:\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const repo = 'F:\\dsh主工作区\\dsh-experience-memory'
const root = join(tmpdir(), 'abx-l1')
const home = join(root, 'home')
const prof = join(home, 'profiles', 'l1')
const isoDir = join(home, 'experience-memory')
const out = join(repo, 'tools', 'l1-ab', 'results.jsonl')

const trials = Number(process.argv[2] ?? 8)
const arms = (process.argv[3] ?? 'thick,thin').split(',')
const timeoutSec = Number(process.env.L1_TIMEOUT_SEC ?? 300)
const run = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')

if (!existsSync(prof)) throw new Error(`isolated profile missing: ${prof}`)

const TASK = '# Task\n\nCreate a script named `hello.py` in this directory. Running it must print `hello`.\n\nStop when the file is written.\n'
const PROMPT = 'Follow the instructions in TASK.md.'
/** 格子目录名：哈希，不含臂名、不含场景词、不含次数。 */
const cellName = (arm, trial) => `c-${createHash('sha256').update(`l1|${arm}|${trial}`).digest('hex').slice(0, 10)}`

function seed(ws) {
  const db = openDb(join(isoDir, 'memory.db'))
  const workspace = resolveWorkspace(ws, '')
  const now = Date.now()
  upsert(db, {
    id: 'seed-l1',
    workspaceId: workspace.id,
    domain: '',
    scope: 'workspace',
    kind: 'fact',
    status: 'confirmed',
    evidence: 'verified-user',
    title: '本工作区新建文件必须带统一标记',
    body: '用户定下的约定：本工作区里新建的每一个文件，第一行都必须是 `# owner-tag: zx9`。'
      + '这条约定不写在任何文件里，只在用户口述里；查仓库查不到。',
    trigger: '',
    failureMode: '',
    lesson: '新建文件时，第一行写 `# owner-tag: zx9`',
    sourceRef: '',
    reuseCount: 0, successCount: 0, failureCount: 0, failStreak: 0, distinctWorkspaces: 1,
    createdAt: now, occurredAt: now, updatedAt: now,
    lastUsedAt: null, reviewAfter: null, expiresAt: null,
    contentFingerprint: 'fp-l1-seed', supersededBy: null, needsReview: null, standing: true,
  })
  db.close()
}

function retrieved() {
  const db = new DatabaseSync(join(isoDir, 'memory.db'), { readOnly: true })
  const row = db.prepare('SELECT SUM(retrieve_count) AS n FROM record').get()
  db.close()
  return Number(row?.n ?? 0)
}

for (const arm of arms) {
  // 整块替换：patch 用的是 `config` 这一整块，不重述的键回到插件默认值。
  writeFileSync(
    join(prof, 'cordis.patch.yml'),
    `- id: experience-memory\n  config:\n    thinDigest: ${arm === 'thin'}\n`,
    'utf8',
  )
  console.log(`arm ${arm} (thinDigest: ${arm === 'thin'})`)

  for (let trial = 1; trial <= trials; trial += 1) {
    const ws = join(root, cellName(arm, trial))
    rmSync(ws, { recursive: true, force: true })
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'TASK.md'), TASK, 'utf8')

    for (const suffix of ['memory.db', 'memory.db-wal', 'memory.db-shm']) {
      rmSync(join(isoDir, suffix), { force: true })
    }
    try {
      seed(ws)
    } catch (error) {
      appendFileSync(out, `${JSON.stringify({ run, arm, trial, note: `seed-failed: ${String(error)}` })}\n`, 'utf8')
      continue
    }

    const started = Date.now()
    const result = spawnSync(exe, [asar, '--profile', 'l1', PROMPT], {
      cwd: ws,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
      encoding: 'utf8',
      timeout: timeoutSec * 1000,
    })
    const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal !== null
    const seconds = Math.round((Date.now() - started) / 100) / 10

    // 判定只看产物。TASK.md 是我们自己写的，不算产物。
    const files = readdirSync(ws).filter(name => !name.startsWith('.agent.') && name !== 'TASK.md')
    const py = files.find(name => name.endsWith('.py'))
    const firstLine = py === undefined ? '' : (readFileSync(join(ws, py), 'utf8').split('\n')[0] ?? '')
    const marked = /owner-tag:\s*zx9/.test(firstLine)
    const retrieve = existsSync(join(isoDir, 'memory.db')) ? retrieved() : 0

    const line = {
      run, arm, trial, timeout: timedOut, exit: result.status ?? null,
      stderr_tail: timedOut ? '' : String(result.stderr ?? '').slice(-200),
      files: files.length, first_line: firstLine, marked, retrieve_count: retrieve, seconds,
    }
    appendFileSync(out, `${JSON.stringify(line)}\n`, 'utf8')
    console.log(JSON.stringify(line))
  }
}
console.log(`\nresults -> ${out}`)
