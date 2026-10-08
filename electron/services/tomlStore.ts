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

/**
 * 删除嵌套表段（恢复默认时用）；删空后自下而上清理空的父表。
 *
 * 关键约束：路径不存在时**绝不创建**。旧实现借用 ensureTable 定位父表，
 * 而 ensureTable 会逐级补建缺失的中间表——对「从未被本应用写入过」的 IDE 执行恢复时，
 * 会把形如 `model_providers = {}` 的空表段凭空写进用户的 config.toml，污染用户配置。
 * 父表在本层删除后若变空才回收，因此不会误删用户原本就存在的非空表段。
 *
 * @returns 是否真的删除了东西（供调用方判断“无事可做”而不必重写文件）
 */
export function removeTable(root: Record<string, any>, tablePath: string[]): boolean {
  if (tablePath.length === 0) return false
  // 自顶向下只读定位：任一中间节点缺失或不是对象，说明目标表段本就不存在
  const ancestors: Array<Record<string, any>> = []
  let cur = root
  for (let i = 0; i < tablePath.length - 1; i++) {
    const next = cur[tablePath[i]]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return false
    ancestors.push(cur)
    cur = next
  }
  const leaf = tablePath[tablePath.length - 1]
  if (!(leaf in cur)) return false
  delete cur[leaf]
  // 自下而上回收因本次删除而变空的父表（root 自身不参与）
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (Object.keys(ancestors[i][tablePath[i]]).length !== 0) break
    delete ancestors[i][tablePath[i]]
  }
  return true
}
