import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { store } from './store'
import { log } from './logger'
import { IDE_REGISTRY, resolvePath } from '../adapters/registry'
import type { BackupEntry } from '../shared/types'

const MAX_PER_IDE = 10

function backupDir(): string {
  const dir = path.join(app.getPath('userData'), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 备份指定配置文件；若文件不存在则不备份，返回 null。
 * extraPaths：伴随主文件一起备份的附属文件（如 state.vscdb 的 -wal/-shm），存在才拷。 */
export function backupFile(ideId: string, configPath: string, reason: string, extraPaths: string[] = []): BackupEntry | null {
  if (!configPath || !fs.existsSync(configPath)) return null
  const ts = Date.now()
  // 同一毫秒内可能为同一 IDE 备份多个文件（如 Codex 的 config.toml + auth.json），加随机后缀避免同名覆盖
  const uid = `${ts}-${Math.random().toString(36).slice(2, 6)}`
  const file = path.join(backupDir(), `${ideId}-${uid}.bak`)
  fs.copyFileSync(configPath, file)
  const extraFiles: Array<{ source: string; backup: string }> = []
  extraPaths.forEach((p, i) => {
    if (p && fs.existsSync(p)) {
      const bf = path.join(backupDir(), `${ideId}-${uid}.extra-${i}.bak`)
      fs.copyFileSync(p, bf)
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
  // 每 IDE 保留最近 N 个
  const kept = list.filter((b) => b.ideId !== ideId)
  const sameIde = list.filter((b) => b.ideId === ideId).sort((a, b) => b.timestamp - a.timestamp)
  for (const old of sameIde.slice(MAX_PER_IDE)) {
    deleteBackupFiles(old)
  }
  kept.push(...sameIde.slice(0, MAX_PER_IDE))
  store.set('backups', kept)
  log('info', 'backup', `${ideId} <- ${configPath} (${reason})`)
  return entry
}

/** 删除一个备份条目对应的全部磁盘文件（主文件 + 附属文件） */
function deleteBackupFiles(entry: BackupEntry): void {
  fs.rmSync(entry.file, { force: true })
  for (const ex of entry.extraFiles ?? []) fs.rmSync(ex.backup, { force: true })
}

export function listBackups(ideId?: string): BackupEntry[] {
  const all = store.get('backups')
  return (ideId ? all.filter((b) => b.ideId === ideId) : all).sort((a, b) => b.timestamp - a.timestamp)
}

/** 原子写入原始文本：先写 .tmp 再 rename 替换 */
function writeRawAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 用备份还原：写回备份时记录的原配置路径（不再信任渲染端传入的路径）。
 * 备份内容优先按 JSON 原子写回；非 JSON 内容按原始文本写回。
 */
export function restoreBackup(backupId: string): { ok: boolean; message: string } {
  const b = store.get('backups').find((x) => x.id === backupId)
  if (!b) return { ok: false, message: '备份不存在' }
  if (!fs.existsSync(b.file)) return { ok: false, message: '备份文件已丢失' }
  const target = b.sourcePath ?? findTargetPath(b.ideId)
  if (!target) return { ok: false, message: '无法确定恢复目标路径，请先在 IDE 管理中手动指定配置路径' }
  try {
    // 主文件：JSON 内容按 JSON 原子写回，非 JSON（如 .vscdb 二进制）按原始字节写回
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
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(b.file, target)
    }
    // 附属文件（-wal/-shm 等）一并还原
    for (const ex of b.extraFiles ?? []) {
      if (fs.existsSync(ex.backup)) {
        fs.mkdirSync(path.dirname(ex.source), { recursive: true })
        fs.copyFileSync(ex.backup, ex.source)
      }
    }
    log('info', 'restore', `${target} <- ${b.file}`)
    return { ok: true, message: `已恢复到 ${target}` }
  } catch (e) {
    return { ok: false, message: `恢复失败: ${(e as Error).message}` }
  }
}

/** 删除指定备份（记录 + 文件） */
export function removeBackup(backupId: string): void {
  const list = store.get('backups')
  const b = list.find((x) => x.id === backupId)
  if (!b) return
  deleteBackupFiles(b)
  store.set('backups', list.filter((x) => x.id !== backupId))
  log('info', 'backup-remove', backupId)
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

/** 原子写入 JSON：先写 .tmp 再 rename 替换 */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function readJsonSafe(file: string): { data: any | null; error: string | null } {
  if (!fs.existsSync(file)) return { data: null, error: 'not_found' }
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')), error: null }
  } catch (e) {
    return { data: null, error: (e as Error).message }
  }
}
