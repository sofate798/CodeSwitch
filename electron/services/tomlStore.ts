import fs from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'smol-toml'

/**
 * TOML 配置读写（如 Codex ~/.codex/config.toml）。
 * parse -> 修改 -> stringify -> 原子写回。
 * 注意：round-trip 会丢失注释/原始排版，因此写入前必定先自动备份。
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
  fs.writeFileSync(tmp, stringify(data), 'utf8')
  fs.renameSync(tmp, file)
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
