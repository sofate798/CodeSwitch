import { ipcMain, dialog, app, shell, BrowserWindow } from 'electron'
import fs from 'node:fs'
import { store } from '../services/store'
import { scanIDEs, applyProvider, resetIDE, manualAdd, generateConfig, checkIdeRunning } from '../services/ideScanner'
import { testProvider } from '../services/provider'
import { listSnapshots, createSnapshot, applySnapshot, removeSnapshot } from '../services/snapshot'
import { listBackups, restoreBackup, removeBackup } from '../services/backup'
import { getLogs, clearLogs } from '../services/logger'
import { encrypt, decrypt } from '../services/crypto'
import { randomUUID } from 'node:crypto'
import type { Provider, AppSettings, Protocol } from '../shared/types'

export function registerIpc(): void {
  // ---- IDE ----
  ipcMain.handle('ide:scan', () => scanIDEs())
  ipcMain.handle('ide:apply', (_e, ideId: string, providerId: string) => applyProvider(ideId, providerId))
  ipcMain.handle('ide:reset', async (_e, ideId: string) => {
    if (ideId !== 'all') return resetIDE(ideId)
    const errs: string[] = []
    let done = 0
    for (const s of await scanIDEs()) {
      if (!s.installed) continue
      if (s.capability !== 'auto') continue // 手动/辅助型跳过，不计入失败
      const r = await resetIDE(s.id)
      if (r.skipped) continue
      if (!r.ok) errs.push(r.message)
      else done++
    }
    return errs.length
      ? { ok: false, message: `部分失败: ${errs.join('; ')}` }
      : { ok: true, message: `已恢复 ${done} 个 IDE 到默认配置` }
  })
  ipcMain.handle('ide:manual-add', (_e, ideId: string, path: string) => manualAdd(ideId, path))
  ipcMain.handle('ide:check-running', (_e, ideId: string) => checkIdeRunning(ideId))
  ipcMain.handle('ide:generate-config', (_e, ideId: string, providerId: string) => generateConfig(ideId, providerId))

  // ---- Provider ----
  ipcMain.handle('provider:list', () => store.get('providers'))
  ipcMain.handle('provider:save', (_e, input: Partial<Provider> & { protocol: 'openai' | 'anthropic' }) => {
    const list: Provider[] = store.get('providers')
    const now = Date.now()
    const idx = input.id ? list.findIndex((p) => p.id === input.id) : -1

    if (idx >= 0) {
      const existing = list[idx]
      // apiKey 仅在用户提供新值时加密；否则保留旧密文
      let apiKeyCipher = existing.apiKey
      if (input.apiKey && !input.apiKey.startsWith('enc:') && input.apiKey !== '****') {
        apiKeyCipher = encrypt(input.apiKey)
      }
      // 就地替换列表元素，确保修改真正落盘
      list[idx] = {
        ...existing,
        name: input.name ?? existing.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl ?? existing.baseUrl,
        model: input.model ?? existing.model,
        group: input.group ?? existing.group,
        apiKey: apiKeyCipher,
        updatedAt: now
      }
      store.set('providers', list)
      return list[idx]
    }

    if (!input.name || !input.baseUrl || !input.model || !input.apiKey) throw new Error('缺少必填字段')
    const np: Provider = {
      id: randomUUID(),
      name: input.name,
      protocol: input.protocol,
      apiKey: encrypt(input.apiKey),
      baseUrl: input.baseUrl,
      model: input.model,
      group: input.group,
      createdAt: now,
      updatedAt: now
    }
    list.push(np)
    store.set('providers', list)
    return np
  })
  ipcMain.handle('provider:remove', (_e, id: string) => {
    store.set('providers', (store.get('providers') as Provider[]).filter((p: Provider) => p.id !== id))
    // 清理 ideBindings / snapshots 中对该供应商的残留引用
    const bindings = store.get('ideBindings')
    for (const [ideId, v] of Object.entries(bindings)) {
      if (v.providerId === id) bindings[ideId] = { ...v, providerId: null }
    }
    store.set('ideBindings', bindings)
    const snapshots = store.get('snapshots')
    for (const s of snapshots) {
      for (const [ideId, b] of Object.entries(s.ideBindings)) {
        if (b.providerId === id) s.ideBindings[ideId] = { providerId: null }
      }
    }
    store.set('snapshots', snapshots)
  })
  ipcMain.handle('provider:test', (_e, id: string) => {
    const p = (store.get('providers') as Provider[]).find((x: Provider) => x.id === id)
    if (!p) return { ok: false, message: '供应商不存在' }
    return testProvider(p)
  })
  ipcMain.handle('provider:reveal-key', (_e, id: string) => {
    const p = (store.get('providers') as Provider[]).find((x: Provider) => x.id === id)
    return p ? decrypt(p.apiKey) : ''
  })

  // 供应商导出：主进程弹保存对话框，写出 JSON（含明文 Key，便于迁移）
  ipcMain.handle('provider:export', async () => {
    const providers = store.get('providers')
    if (providers.length === 0) return { ok: false, message: '没有可导出的供应商' }
    const r = await dialog.showSaveDialog({
      title: '导出供应商',
      defaultPath: `codeswitch-providers-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, message: '已取消' }
    const payload = {
      app: 'CodeSwitch',
      version: 1,
      exportedAt: new Date().toISOString(),
      providers: providers.map((p) => ({
        name: p.name,
        protocol: p.protocol,
        apiKey: decrypt(p.apiKey),
        baseUrl: p.baseUrl,
        model: p.model,
        group: p.group ?? ''
      }))
    }
    fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, message: r.filePath, count: providers.length }
  })

  // 供应商导入：主进程弹打开对话框，校验后以新 id 入库（同名跳过）
  ipcMain.handle('provider:import', async () => {
    const r = await dialog.showOpenDialog({
      title: '导入供应商',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, message: '已取消' }
    let parsed: any
    try {
      parsed = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))
    } catch (e) {
      return { ok: false, message: `文件解析失败: ${(e as Error).message}` }
    }
    const incoming: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed.providers) ? parsed.providers : []
    const valid = incoming.filter(
      (p) => p && typeof p.name === 'string' && (p.protocol === 'openai' || p.protocol === 'anthropic') && typeof p.baseUrl === 'string'
    )
    if (valid.length === 0) return { ok: false, message: '文件中没有有效的供应商数据' }
    const list: Provider[] = store.get('providers')
    const existingNames = new Set(list.map((p) => p.name))
    const now = Date.now()
    let added = 0
    for (const p of valid) {
      if (existingNames.has(p.name)) continue
      list.push({
        id: randomUUID(),
        name: p.name,
        protocol: p.protocol as Protocol,
        apiKey: encrypt(String(p.apiKey ?? '')),
        baseUrl: p.baseUrl,
        model: String(p.model ?? ''),
        group: typeof p.group === 'string' && p.group ? p.group : undefined,
        createdAt: now,
        updatedAt: now
      })
      added++
    }
    store.set('providers', list)
    return { ok: true, message: `导入 ${added} 个供应商（跳过 ${valid.length - added} 个同名）`, count: added }
  })

  // ---- Snapshot ----
  ipcMain.handle('snapshot:list', () => listSnapshots())
  ipcMain.handle('snapshot:create', (_e, name: string, desc: string) => createSnapshot(name, desc))
  ipcMain.handle('snapshot:apply', (_e, id: string) => applySnapshot(id))
  ipcMain.handle('snapshot:remove', (_e, id: string) => removeSnapshot(id))

  // ---- Backup ----
  ipcMain.handle('backup:list', (_e, ideId?: string) => listBackups(ideId))
  ipcMain.handle('backup:restore', (_e, backupId: string) => restoreBackup(backupId))
  ipcMain.handle('backup:remove', (_e, backupId: string) => removeBackup(backupId))

  // ---- Log ----
  ipcMain.handle('log:list', () => getLogs())
  ipcMain.handle('log:clear', () => clearLogs())

  // ---- Settings ----
  ipcMain.handle('settings:get', () => store.get('settings'))
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    const next = { ...store.get('settings'), ...patch }
    store.set('settings', next)
    // 仅当本次修改包含 autoLaunch 时才更新开机自启，避免主题/语言切换触发副作用
    if ('autoLaunch' in patch) {
      app.setLoginItemSettings({ openAtLogin: next.autoLaunch })
    }
    // 主题变化时同步 Windows 原生标题栏按钮配色
    if ('theme' in patch && process.platform === 'win32') {
      const w: BrowserWindow | undefined = BrowserWindow.getAllWindows()[0]
      if (w) {
        const light = next.theme === 'light'
        w.setTitleBarOverlay({
          color: light ? '#ffffff' : '#1b1d23',
          symbolColor: light ? '#1f2329' : '#e6e8ee',
          height: 40
        })
        w.setBackgroundColor(light ? '#f3f4f6' : '#141519')
      }
    }
    return next
  })

  // ---- System ----
  ipcMain.handle('system:pick-file', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      defaultPath: defaultPath || undefined
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('system:open-data-dir', () => shell.openPath(app.getPath('userData')))
  ipcMain.handle('system:open-path', (_e, targetPath: string) => {
    if (!targetPath) return
    // 文件存在则定位选中，否则打开其所在目录
    if (fs.existsSync(targetPath)) shell.showItemInFolder(targetPath)
    else shell.openPath(targetPath)
  })
}
