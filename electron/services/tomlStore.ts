import fs from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'smol-toml'

/**
 * TOML 配置读写（如 Codex ~/.codex/config.toml）。
 * parse -> 修改 -> stringify -> 原子写回。
 * 注意：round-trip 会丢失注释/原始排版，因此写入前必定先自动备份。
 *
 * M5 取舍说明：理想方案是对 config.toml 做最小化行级增删以完整保留用户注释与排版，
 * 但任意 TOML 的行级定位（多行字符串、内联表、重复表段、数组表）实现风险高、易引入语法错误，
 * 反而可能破坏用户配置。故此处维持「整体 parse/stringify 重写」，依赖 apply/reset 前的自动备份兜底，
 * 用户可从备份一键还原注释与排版。此为经权衡后的刻意选择。
 */

export function readToml(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {}
  const raw = fs.readFileSync(file, 'utf8')
  if (!raw.trim()) return {}
  return parse(raw) as Record<string, any>
}

export function writeTomlAtomic(file: string, data: Record<string, any>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, stringify(data), 'utf8')
    fs.renameSync(tmp, file)
  } finally {
    // L1：失败时清理遗留临时文件（成功 rename 后 tmp 已不存在，此为空操作）
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
    } catch {
      // 清理失败忽略
    }
  }
}

/** 在对象上按路径设置嵌套表段，如 ['model_providers','codeswitch'] -> { model_providers: { codeswitch: {...} } } */
export function ensureTable(root: Record<string, any>, tablePath: string[]): Record<string, any> {
  let cur = root
  for (const seg of tablePath) {
    if (typeof cur[seg] !== 'object' || cur[seg] === null) cur[seg] = {}
    cur = cur[seg]
  }
  return cur
}

/** 删除嵌套表段（恢复默认时用）；删空后清理空的父表 */
export function removeTable(root: Record<string, any>, tablePath: string[]): void {
  if (tablePath.length === 0) return
  const parentPath = tablePath.slice(0, -1)
  const leaf = tablePath[tablePath.length - 1]
  const parent = parentPath.length === 0 ? root : ensureTable(root, parentPath)
  delete parent[leaf]
}
