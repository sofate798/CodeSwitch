import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { store } from './store'
import { log } from './logger'
import { IDE_REGISTRY, resolvePath } from '../adapters/registry'
import type { BackupEntry, OpResult } from '../shared/types'

const MAX_PER_IDE = 10

/**
 * 备份目录结构（Sam-L1，对齐 PRD）：
 *   backups/{ideId}/{timestamp}-{rand}.bak        主文件
 *   backups/{ideId}/{timestamp}-{rand}.extra-N.bak 附属文件（-wal/-shm 等）
 *   backups/{ideId}/meta.json                      该 IDE 的备份清单（时间/来源/reason/size）
 * 兼容：旧版扁平命名 backups/{ideId}-{timestamp}-{rand}.bak 仍由 store 记录其绝对路径，
 *       可正常列出与恢复；reconcile() 会把磁盘 meta 与 store 记录合并。
 */
function backupDir(): string {
  const dir = path.join(app.getPath('userData'), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function ideBackupDir(ideId: string): string {
  const dir = path.join(backupDir(), ideId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function metaPath(ideId: string): string {
  return path.join(ideBackupDir(ideId), 'meta.json')
}

function readMeta(ideId: string): BackupEntry[] {
  try {
    const f = metaPath(ideId)
    if (!fs.existsSync(f)) return []
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    return Array.isArray(j?.entries) ? (j.entries as BackupEntry[]) : []
  } catch {
    return []
  }
}

/** 原子写入某 IDE 的 meta.json（记录其保留的备份条目） */
function writeMeta(ideId: string, entries: BackupEntry[]): void {
  const file = metaPath(ideId)
  const payload = JSON.stringify({ ideId, updatedAt: Date.now(), entries }, null, 2)
  writeRawAtomic(file, payload)
}

/** 合并 store 记录与磁盘 meta，得到去重后的完整备份列表（兜底 store 丢失/历史扁平备份） */
function reconcile(): BackupEntry[] {
  const byId = new Map<string, BackupEntry>()
  for (const b of store.get('backups')) byId.set(b.id, b)
  try {
    const root = backupDir()
    for (const name of fs.readdirSync(root)) {
      const sub = path.join(root, name)
      let isDir = false
      try {
        isDir = fs.statSync(sub).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue // 旧版扁平 .bak 文件已在 store 中
      for (const e of readMeta(name)) if (e && e.id && !byId.has(e.id)) byId.set(e.id, e)
    }
  } catch {
    // 扫描失败时退回 store 记录
  }
  return [...byId.values()]
}

/** 原子复制文件：先复制到 .tmp 再 rename 替换（Sam-H3，二进制分支同样原子）；失败时 finally 清理残留 tmp */
function copyFileAtomic(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.copyFileSync(src, tmp)
    fs.renameSync(tmp, dest)
  } finally {
    removeTmp(tmp)
  }
}

/** 备份指定配置文件；若文件不存在则不备份，返回 null。
 * extraPaths：伴随主文件一起备份的附属文件（如 state.vscdb 的 -wal/-shm），存在才拷。 */
export function backupFile(ideId: string, configPath: string, reason: string, extraPaths: string[] = []): BackupEntry | null {
  if (!configPath || !fs.existsSync(configPath)) return null
  const ts = Date.now()
  // 同一毫秒内可能为同一 IDE 备份多个文件（如 Codex 的 config.toml + auth.json），加随机后缀避免同名覆盖
  const uid = `${ts}-${Math.random().toString(36).slice(2, 6)}`
  const dir = ideBackupDir(ideId)
  const file = path.join(dir, `${uid}.bak`)
  copyFileAtomic(configPath, file)
  const extraFiles: Array<{ source: string; backup: string }> = []
  extraPaths.forEach((p, i) => {
    if (p && fs.existsSync(p)) {
      const bf = path.join(dir, `${uid}.extra-${i}.bak`)
      copyFileAtomic(p, bf)
      extraFiles.push({ source: p, backup: bf })
    }
  })
  const entry: BackupEntry = {
    id: `${ideId}-${uid}`,
    ideId,
    timestamp: ts,
    file,
    /** 备份时配置文件的原路径，恢复时写回该位置 */
    sourcePath: configPath,
    extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
    reason,
    size: fs.statSync(file).size
  }
  const list = store.get('backups')
  list.push(entry)
  // 每 IDE 保留最近 N 个（含历史扁平备份，统一按时间裁剪）
  const others = list.filter((b) => b.ideId !== ideId)
  const sameIde = list.filter((b) => b.ideId === ideId).sort((a, b) => b.timestamp - a.timestamp)
  for (const old of sameIde.slice(MAX_PER_IDE)) {
    deleteBackupFiles(old)
  }
  const keptSame = sameIde.slice(0, MAX_PER_IDE)
  store.set('backups', [...others, ...keptSame])
  writeMeta(ideId, keptSame)
  log('info', 'backup', `${ideId} <- ${configPath} (${reason})`)
  return entry
}

/** 删除一个备份条目对应的全部磁盘文件（主文件 + 附属文件） */
function deleteBackupFiles(entry: BackupEntry): void {
  fs.rmSync(entry.file, { force: true })
  for (const ex of entry.extraFiles ?? []) fs.rmSync(ex.backup, { force: true })
}

export function listBackups(ideId?: string): BackupEntry[] {
  const all = reconcile()
  return (ideId ? all.filter((b) => b.ideId === ideId) : all).sort((a, b) => b.timestamp - a.timestamp)
}

/** 删除遗留的临时文件（rename 成功后 tmp 已不存在，existsSync 为假即空操作） */
function removeTmp(tmp: string): void {
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
  } catch {
    // 清理失败不影响主流程
  }
}

/** 原子写入原始文本：先写 .tmp 再 rename 替换；失败时 finally 清理残留 tmp */
function writeRawAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, file)
  } finally {
    removeTmp(tmp)
  }
}

/**
 * Sam-M4：恢复 sqlite 目标前检测残留 -wal 预写日志。
 * 存在非空 -wal 时返回告警文案，提示用户先正常启停 IDE 触发 checkpoint，
 * 否则 -wal 中未落盘的改动可能与恢复内容不一致。（不越权修改 sqliteStore）
 */
function detectResidualWal(target: string): string | null {
  try {
    if (!/\.(vscdb|db|sqlite)$/i.test(target)) return null
    const wal = `${target}-wal`
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
      return '检测到 SQLite 残留的 -wal 预写日志：建议先正常启动并关闭目标 IDE 触发 checkpoint 后再恢复，否则恢复结果可能不完整'
    }
  } catch {
    // 检测失败不阻断恢复
  }
  return null
}

interface RestoreSnapshot {
  orig: string
  tmp: string
  existed: boolean
}

/** 恢复前对当前目标（含附属文件）做临时快照，供失败回滚 */
function snapshotTargets(paths: string[]): RestoreSnapshot[] {
  const snaps: RestoreSnapshot[] = []
  const stamp = `${process.pid}-${Date.now()}`
  for (const src of paths) {
    if (!src) continue
    if (fs.existsSync(src)) {
      const tmp = `${src}.cs-restore-${stamp}`
      try {
        fs.copyFileSync(src, tmp)
        snaps.push({ orig: src, tmp, existed: true })
      } catch {
        snaps.push({ orig: src, tmp: '', existed: true })
      }
    } else {
      // 原本不存在：回滚时应删除恢复过程中新建的文件
      snaps.push({ orig: src, tmp: '', existed: false })
    }
  }
  return snaps
}

function rollbackTargets(snaps: RestoreSnapshot[]): void {
  for (const s of snaps) {
    try {
      if (s.existed) {
        if (s.tmp && fs.existsSync(s.tmp)) fs.renameSync(s.tmp, s.orig)
      } else if (fs.existsSync(s.orig)) {
        fs.rmSync(s.orig, { force: true })
      }
    } catch {
      // 尽力回滚
    }
  }
}

function cleanupTargets(snaps: RestoreSnapshot[]): void {
  for (const s of snaps) {
    if (s.tmp) {
      try {
        fs.rmSync(s.tmp, { force: true })
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 用备份还原（Sam-H3）：写回备份时记录的原配置路径（不信任渲染端传入路径）。
 * - JSON 内容按 JSON 原子写回；非 JSON（如 .vscdb 二进制）走 tmp+rename 原子替换；
 * - 恢复前对当前目标做临时快照，任一步失败自动回滚到恢复前状态；
 * - 恢复 sqlite 目标前检测残留 -wal 并在结果中告警（Sam-M4）。
 * 成功 msg.backup.restoreOk，失败 msg.backup.restoreFailed。
 */
export function restoreBackup(backupId: string): OpResult {
  const b = reconcile().find((x) => x.id === backupId)
  if (!b) return { ok: false, code: 'msg.backup.restoreFailed', args: { reason: '备份不存在' } }
  if (!fs.existsSync(b.file)) return { ok: false, code: 'msg.backup.restoreFailed', args: { reason: '备份文件已丢失' } }
  const target = b.sourcePath ?? findTargetPath(b.ideId)
  if (!target) {
    return { ok: false, code: 'msg.backup.restoreFailed', args: { reason: '无法确定恢复目标路径，请先在 IDE 管理中手动指定配置路径' } }
  }
  const walWarning = detectResidualWal(target)
  const extraSources = (b.extraFiles ?? []).map((e) => e.source).filter(Boolean)
  const snaps = snapshotTargets([target, ...extraSources])
  try {
    // 主文件：JSON 内容按 JSON 原子写回，非 JSON（如 .vscdb 二进制）按字节原子替换
    const isJson = (() => {
      try {
        JSON.parse(fs.readFileSync(b.file, 'utf8'))
        return true
      } catch {
        return false
      }
    })()
    if (isJson) {
      writeJsonAtomic(target, JSON.parse(fs.readFileSync(b.file, 'utf8')))
    } else {
      copyFileAtomic(b.file, target)
    }
    // 附属文件（-wal/-shm 等）一并原子还原
    for (const ex of b.extraFiles ?? []) {
      if (fs.existsSync(ex.backup)) copyFileAtomic(ex.backup, ex.source)
    }
    cleanupTargets(snaps)
    log('info', 'restore', `${target} <- ${b.file}`)
    const args: Record<string, string | number> = { target }
    if (walWarning) args.warning = walWarning
    return { ok: true, code: 'msg.backup.restoreOk', args }
  } catch (e) {
    rollbackTargets(snaps)
    cleanupTargets(snaps)
    log('error', 'restore-failed', `${target}: ${(e as Error).message}`)
    const args: Record<string, string | number> = { reason: (e as Error).message }
    if (walWarning) args.warning = walWarning
    return { ok: false, code: 'msg.backup.restoreFailed', args }
  }
}

/** 删除指定备份（记录 + 文件），返回 msg.backup.removeOk */
export function removeBackup(backupId: string): OpResult {
  const list = store.get('backups')
  const b = list.find((x) => x.id === backupId)
  if (!b) return { ok: false, code: 'msg.backup.notFound' }
  deleteBackupFiles(b)
  store.set('backups', list.filter((x) => x.id !== backupId))
  // 同步刷新该 IDE 的 meta.json
  writeMeta(b.ideId, list.filter((x) => x.ideId === b.ideId && x.id !== backupId))
  log('info', 'backup-remove', backupId)
  return { ok: true, code: 'msg.backup.removeOk' }
}

/** 旧版备份条目缺 sourcePath 时的回退：从注册表/手动绑定推断配置路径 */
function findTargetPath(ideId: string): string | null {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  if (!ide) return null
  const manual = store.get('ideBindings')[ideId]?.configPath
  if (manual && fs.existsSync(manual)) return manual
  for (const tpl of ide.configPaths) {
    const p = resolvePath(tpl)
    if (p && fs.existsSync(p)) return p
  }
  return null
}

/** 原子写入 JSON：先写 .tmp 再 rename 替换；失败时 finally 清理残留 tmp */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } finally {
    removeTmp(tmp)
  }
}

export function readJsonSafe(file: string): { data: any | null; error: string | null } {
  if (!fs.existsSync(file)) return { data: null, error: 'not_found' }
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')), error: null }
  } catch (e) {
    return { data: null, error: (e as Error).message }
  }
}
