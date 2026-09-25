/**
 * 给一个隔离库播种**一条**记录，并打印它的工作区身份。
 * 用法：node seed.mjs <storePath> <workspaceRoot> <arm: standing|control|sham>
 */
import { DatabaseSync } from 'node:sqlite'
import { resolveWorkspace } from 'file:///F:/dsh%E4%B8%BB%E5%B7%A5%E4%BD%9C%E5%8C%BA/dsh-experience-memory/lib/domain.js'
import { openDb, upsert } from 'file:///F:/dsh%E4%B8%BB%E5%B7%A5%E4%BD%9C%E5%8C%BA/dsh-experience-memory/lib/db.js'

const [storePath, wsRoot, arm] = process.argv.slice(2)
const db = openDb(storePath)
const workspace = resolveWorkspace(wsRoot, '')

// 规矩本身**只有中文**（marker 是 ASCII）：任务提示是英文，两边没有共同词，
// 所以对照组不可能靠"话题相关"撞上它 —— 这正是要区分的那个变量。
const RULE = {
  title: '本工作区新建文件必须带统一标记行',
  body: '用户定下的约定：本工作区里新建的每一个文件，第一行都必须是 `# owner-tag: zx9`。'
    + '这条约定不写在任何文件里，只在用户口述里；查仓库查不到。',
  lesson: '新建文件时，第一行写 `# owner-tag: zx9`',
}
const SHAM = {
  title: '本工作区的日志统一放子目录',
  body: '用户定下的另一条约定：程序产生的日志一律写到 `var/log/` 子目录下，不要散落在根目录。',
  lesson: '日志写到 `var/log/` 子目录',
}

const chosen = arm === 'sham' ? SHAM : RULE

// `absent` 臂：库里**一条记录都不放**。用来回答"这个标记会不会本来就出现"——
// 环境本身若有这个习惯，absent 臂就会中；它不中，才说明标记是那条记录带来的。
if (arm !== 'absent') upsert(db, {
  id: `seed-${arm}`,
  workspaceId: workspace.id,
  domain: '',
  scope: 'workspace',
  kind: 'fact',
  status: 'confirmed',
  evidence: 'verified-user',
  title: chosen.title,
  body: chosen.body,
  trigger: '',
  failureMode: '',
  lesson: chosen.lesson,
  sourceRef: '',
  reuseCount: 0,
  successCount: 0,
  failureCount: 0,
  failStreak: 0,
  distinctWorkspaces: 1,
  createdAt: Date.now(),
  occurredAt: Date.now(),
  updatedAt: Date.now(),
  lastUsedAt: null,
  reviewAfter: null,
  expiresAt: null,
  contentFingerprint: `fp-${arm}`,
  supersededBy: null,
  needsReview: null,
  standing: arm === 'standing',
})
const row = db.prepare('select id, standing, status from record').all()
console.log(JSON.stringify({ workspace: workspace.id, records: row }))
db.close()
