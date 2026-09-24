#!/usr/bin/env node
/**
 * 判据实现：G5 的"一景多测"——一个任务里两个**互不报错**的坑，各记一项。
 *
 *   node tools/judge-multiskill.mjs <工作区目录>
 *
 * 为什么单独一个文件、而不是写在 PowerShell 里：判据要比较含中文与英文双引号的字符串，
 * 而从 PowerShell 往 `node -e` 传中文会被重写（本工作区实测过多次），判据一旦被编码问题弄坏，
 * 会安静地把"对"判成"错"。文件里读、文件里比，就没有这一层。
 *
 * 两项各自对应的记录（见 tools/t2-scenarios.json 的 probeArms）：
 *   json_valid    —— 往 JSON 的 note 里写中文散文时用了英文双引号 ⇒ 整份解析失败
 *   config_exact  —— 用命令行改文本文件时被 shell 吃掉/展开了引号与 $ ⇒ 写进去的不是要求的那行
 *
 * 两项都是"不报错的错"：产物写出来了、命令也没报错，只有回读才能发现不对。
 * 这正是 failure_shape 表看不见的那一类（那张表只收得到工具报的错）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (dir === undefined) {
  console.error('用法: node tools/judge-multiskill.mjs <工作区目录>')
  process.exit(2)
}

/** 逐字比较用的目标行（任务里原样给出）。 */
const WANTED_CONFIG_LINE = 'note="报价 $100（含税）"'

const result = {
  json_valid: false,
  config_exact: false,
  json_detail: '',
  config_detail: '',
}

// ── ① registry.json：能不能解析 + 新条目在不在 ──────────────────────────────
try {
  const raw = readFileSync(join(dir, 'registry.json'), 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    result.json_detail = `解析失败：${error instanceof Error ? error.message : String(error)}`
    parsed = undefined
  }
  if (parsed !== undefined) {
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    const added = entries.find(e => String(e?.id ?? '') === '0002')
    const noteOk = added !== undefined && String(added.note ?? '').includes('这批货迟了')
    result.json_valid = added !== undefined && noteOk
    result.json_detail = `条目数=${entries.length} 0002在=${added !== undefined} 备注含关键词=${noteOk}`
  }
} catch (error) {
  result.json_detail = `读不到 registry.json：${error instanceof Error ? error.message : String(error)}`
}

// ── ② config.txt：note= 那一行是不是逐字等于要求的那行 ─────────────────────
try {
  const text = readFileSync(join(dir, 'config.txt'), 'utf8')
  const lines = text.split(/\r?\n/)
  const noteLine = lines.find(line => line.startsWith('note='))
  result.config_exact = noteLine !== undefined && noteLine.trimEnd() === WANTED_CONFIG_LINE
  result.config_detail = noteLine === undefined ? '没有 note= 这一行' : `实际=[${noteLine.trimEnd()}]`
} catch (error) {
  result.config_detail = `读不到 config.txt：${error instanceof Error ? error.message : String(error)}`
}

// 一行 JSON 回去，交给 PowerShell 拆成 aspects。字段名与判据里的检查点一一对应。
console.log(JSON.stringify(result))
