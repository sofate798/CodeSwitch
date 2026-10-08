import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { log } from './logger'
import type { OpResult } from '../shared/types'

/**
 * 数据目录管理（FR-07-5）。
 *
 * CodeSwitch 的持久化数据（electron-store 的 config.json、backups/、logs/）默认落在
 * app.getPath('userData') 下。要支持「自定义数据目录」，必须在 electron-store 实例化之前
 * 调用 app.setPath('userData', dir)，因此引导逻辑放在 main/bootstrap.ts 里、作为最先执行的
 * 副作用导入。
 *
 * 自定义目录记录在一个「固定引导文件」中（位于 Roaming/appData，本身不随自定义目录变化），
 * 这样重启后才能知道要把 userData 重定向到哪里。
 */

/** 固定引导文件：记录用户自定义的数据目录，跨重启生效（位置恒定，不受 setPath 影响） */
function bootstrapFile(): string {
  return path.join(app.getPath('appData'), 'codeswitch-datadir.json')
}

/** 迁移时需要一并搬运的数据条目（electron-store 主文件 + 备份目录 + 日志目录） */
const MIGRATE_ITEMS = ['config.json', 'backups', 'logs']

function readBootstrap(): string | null {
  try {
    const f = bootstrapFile()
    if (!fs.existsSync(f)) return null
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    return typeof j?.dataDir === 'string' && j.dataDir ? j.dataDir : null
  } catch {
    return null
  }
}

function writeBootstrap(dir: string | null): void {
  const f = bootstrapFile()
  if (!dir) {
    fs.rmSync(f, { force: true })
    return
  }
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ dataDir: dir }, null, 2), 'utf8')
}

/**
 * 在 electron-store 实例化前调用：若存在有效的自定义数据目录则重定向 userData。
 * 目录不存在（如移动硬盘未挂载）时安全回退到默认目录，绝不阻断启动。
 */
export function applyCustomDataDir(): void {
  const dir = readBootstrap()
  if (dir && fs.existsSync(dir)) {
    try {
      app.setPath('userData', dir)
    } catch {
      // 重定向失败则回退默认目录
    }
  }
}

/** 当前用户自定义的数据目录（未设置返回 null） */
export function getCustomDataDir(): string | null {
  return readBootstrap()
}

/** 数据目录信息：实际生效目录 + 是否自定义 */
export function getDataDirInfo(): { current: string; custom: string | null } {
  return { current: app.getPath('userData'), custom: readBootstrap() }
}

/**
 * 迁移到新数据目录：把 config.json / backups / logs 复制到新目录并记录引导文件。
 * 不删除旧目录（保守，避免误删）；调用方应提示用户重启后生效。
 * 统一 OpResult 契约：对外只回消息码，异常细节仅落日志（与 handler 层的消息码渲染解耦）。
 */
export function migrateDataDir(newDir: string): OpResult<{ newDir: string }> {
  const oldDir = app.getPath('userData')
  if (!newDir) return { ok: false, code: 'msg.common.error' }
  if (path.resolve(oldDir) === path.resolve(newDir)) {
    // 选到当前目录：独立消息码，避免被降级为笼统的“操作失败”误导用户
    return { ok: false, code: 'msg.settings.dataDirSame' }
  }
  try {
    fs.mkdirSync(newDir, { recursive: true })
    for (const item of MIGRATE_ITEMS) {
      const src = path.join(oldDir, item)
      const dst = path.join(newDir, item)
      if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true, force: true })
    }
    writeBootstrap(newDir)
    log('info', 'migrate-data-dir', `${oldDir} -> ${newDir}`)
    return { ok: true, code: 'msg.settings.dataDirChanged', data: { newDir } }
  } catch (e) {
    // 异常原文（可能含路径/系统英文描述）只进日志，不外透 UI
    log('error', 'migrate-data-dir', `failed: ${(e as Error).message}`)
    return { ok: false, code: 'msg.common.error' }
  }
}

/** 取消自定义数据目录（恢复默认）：仅清除引导文件，重启后回到默认 userData */
export function clearCustomDataDir(): void {
  writeBootstrap(null)
}
