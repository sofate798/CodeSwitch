import { ipcMain, dialog, app, shell, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { store } from '../services/store'
import { scanIDEs, applyProvider, resetIDE, manualAdd, generateConfig, checkIdeRunning } from '../services/ideScanner'
import { testProvider } from '../services/provider'
import { listSnapshots, createSnapshot, applySnapshot, removeSnapshot, insertSnapshot } from '../services/snapshot'
import { listBackups, restoreBackup, removeBackup } from '../services/backup'
import { getLogs, clearLogs } from '../services/logger'
import { proxyStatus, configureProxy, stopProxy } from '../services/proxy'
import { getDataDirInfo, migrateDataDir } from '../services/paths'
import { encrypt, decrypt } from '../services/crypto'
import { randomUUID } from 'node:crypto'
import type { Provider, AppSettings, Protocol, ProxyConfig, Snapshot } from '../shared/types'

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
    // 若该供应商正是转发网关的目标，解除绑定
    const proxy = store.get('proxy')
    if (proxy?.providerId === id) store.set('proxy', { ...proxy, providerId: null })
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

  // 快照导出：写出 .csnap（JSON），内嵌该快照引用的供应商（含明文 Key），保证跨机可迁移
  ipcMain.handle('snapshot:export', async (_e, id: string) => {
    const snap = (store.get('snapshots') as Snapshot[]).find((s) => s.id === id)
    if (!snap) return { ok: false, message: '快照不存在' }
    const providers = store.get('providers') as Provider[]
    const refIds = [
      ...new Set(
        Object.values(snap.ideBindings)
          .map((b) => b.providerId)
          .filter((x): x is string => !!x)
      )
    ]
    const embedded = refIds
      .map((pid) => providers.find((p) => p.id === pid))
      .filter((p): p is Provider => !!p)
      .map((p) => ({
        refId: p.id,
        name: p.name,
        protocol: p.protocol,
        apiKey: decrypt(p.apiKey),
        baseUrl: p.baseUrl,
        model: p.model,
        group: p.group ?? ''
      }))
    const safeName = (snap.name || 'snapshot').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const r = await dialog.showSaveDialog({
      title: '导出快照',
      defaultPath: `${safeName}.csnap`,
      filters: [
        { name: 'CodeSwitch 快照', extensions: ['csnap'] },
        { name: 'JSON', extensions: ['json'] }
      ]
    })
    if (r.canceled || !r.filePath) return { ok: false, message: '已取消' }
    const payload = {
      app: 'CodeSwitch',
      kind: 'snapshot',
      version: 1,
      exportedAt: new Date().toISOString(),
      snapshot: {
        name: snap.name,
        description: snap.description ?? '',
        createdAt: snap.createdAt,
        ideBindings: snap.ideBindings
      },
      providers: embedded
    }
    fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, message: r.filePath }
  })

  // 快照导入：读取 .csnap，先导入内嵌供应商（同名复用、否则新建），再把绑定的 providerId 重映射到本机 id
  ipcMain.handle('snapshot:import', async () => {
    const r = await dialog.showOpenDialog({
      title: '导入快照',
      properties: ['openFile'],
      filters: [{ name: 'CodeSwitch 快照', extensions: ['csnap', 'json'] }]
    })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, message: '已取消' }
    let parsed: any
    try {
      parsed = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))
    } catch (e) {
      return { ok: false, message: `文件解析失败: ${(e as Error).message}` }
    }
    if (!parsed || parsed.kind !== 'snapshot' || !parsed.snapshot || typeof parsed.snapshot !== 'object') {
      return { ok: false, message: '不是有效的 CodeSwitch 快照文件' }
    }
    // 1) 导入内嵌供应商，构建 旧 id -> 本机 id 映射
    const list: Provider[] = store.get('providers')
    const idMap = new Map<string, string>()
    const now = Date.now()
    for (const ep of Array.isArray(parsed.providers) ? parsed.providers : []) {
      if (!ep || typeof ep.name !== 'string' || (ep.protocol !== 'openai' && ep.protocol !== 'anthropic')) continue
      const existing = list.find((p) => p.name === ep.name)
      if (existing) {
        if (ep.refId) idMap.set(ep.refId, existing.id)
        continue
      }
      const np: Provider = {
        id: randomUUID(),
        name: ep.name,
        protocol: ep.protocol as Protocol,
        apiKey: encrypt(String(ep.apiKey ?? '')),
        baseUrl: String(ep.baseUrl ?? ''),
        model: String(ep.model ?? ''),
        group: typeof ep.group === 'string' && ep.group ? ep.group : undefined,
        createdAt: now,
        updatedAt: now
      }
      list.push(np)
      if (ep.refId) idMap.set(ep.refId, np.id)
    }
    store.set('providers', list)
    // 2) 重映射绑定：ideId 跨机稳定，仅 providerId 需要换成导入后的本机 id
    const remapped: Record<string, { providerId: string | null }> = {}
    const srcBindings = parsed.snapshot.ideBindings && typeof parsed.snapshot.ideBindings === 'object' ? parsed.snapshot.ideBindings : {}
    for (const [ideId, b] of Object.entries<any>(srcBindings)) {
      const oldPid: string | null = b && typeof b.providerId === 'string' ? b.providerId : null
      remapped[ideId] = { providerId: oldPid ? idMap.get(oldPid) ?? null : null }
    }
    // 3) 插入快照
    const snap = insertSnapshot({
      name: typeof parsed.snapshot.name === 'string' ? parsed.snapshot.name : '导入的快照',
      description: typeof parsed.snapshot.description === 'string' ? parsed.snapshot.description : '',
      createdAt: typeof parsed.snapshot.createdAt === 'number' ? parsed.snapshot.createdAt : now,
      ideBindings: remapped
    })
    return { ok: true, message: `已导入快照「${snap.name}」`, count: 1 }
  })

  // ---- Backup ----
  ipcMain.handle('backup:list', (_e, ideId?: string) => listBackups(ideId))
  ipcMain.handle('backup:restore', (_e, backupId: string) => restoreBackup(backupId))
  ipcMain.handle('backup:remove', (_e, backupId: string) => removeBackup(backupId))

  // ---- Log ----
  ipcMain.handle('log:list', () => getLogs())
  ipcMain.handle('log:clear', () => clearLogs())

  // 日志导出：按 txt / json 写出当前已加载的日志（按时间正序）
  ipcMain.handle('log:export', async (_e, format: 'txt' | 'json') => {
    const fmt: 'txt' | 'json' = format === 'json' ? 'json' : 'txt'
    const chrono = [...getLogs()].reverse() // getLogs() 为倒序（新在前），导出时恢复为正序
    if (chrono.length === 0) return { ok: false, message: '没有可导出的日志' }
    const date = new Date().toISOString().slice(0, 10)
    const r = await dialog.showSaveDialog({
      title: '导出日志',
      defaultPath: `codeswitch-logs-${date}.${fmt}`,
      filters: fmt === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'Text', extensions: ['txt'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, message: '已取消' }
    if (fmt === 'json') {
      const payload = {
        app: 'CodeSwitch',
        exportedAt: new Date().toISOString(),
        count: chrono.length,
        logs: chrono
      }
      fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8')
    } else {
      const text =
        chrono
          .map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.action}${l.detail ? ' ' + l.detail : ''}`)
          .join('\n') + '\n'
      fs.writeFileSync(r.filePath, text, 'utf8')
    }
    return { ok: true, message: r.filePath, count: chrono.length }
  })

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

  // ---- Proxy (本地转发网关) ----
  ipcMain.handle('proxy:status', () => proxyStatus())
  ipcMain.handle('proxy:configure', (_e, patch: Partial<ProxyConfig>) => configureProxy(patch))

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

  // 数据目录：获取当前生效目录与自定义目录
  ipcMain.handle('system:get-data-dir', () => getDataDirInfo())

  // 数据目录：弹目录选择框，迁移数据并写入引导文件；成功后提示重启
  ipcMain.handle('system:set-data-dir', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择数据目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, message: '已取消' }
    const res = migrateDataDir(r.filePaths[0])
    return res.ok ? { ok: true, message: res.message, needRestart: true } : { ok: false, message: res.message }
  })

  // 重置软件：清除 CodeSwitch 全部本地数据（不触碰各 IDE 自身配置文件）
  ipcMain.handle('system:reset-all', async () => {
    try {
      // 停掉转发网关
      await stopProxy()
      const ud = app.getPath('userData')
      // 清空 backups/ 与 logs/ 目录内容
      for (const sub of ['backups', 'logs']) {
        const dir = path.join(ud, sub)
        if (fs.existsSync(dir)) {
          for (const entry of fs.readdirSync(dir)) {
            fs.rmSync(path.join(dir, entry), { force: true, recursive: true })
          }
        }
      }
      // 重置 store 各键到默认值（保留主题/语言等纯显示偏好，避免重置后界面突变）
      const prevSettings = store.get('settings')
      store.set('providers', [])
      store.set('snapshots', [])
      store.set('backups', [])
      store.set('ideBindings', {})
      store.set('proxy', { enabled: false, port: 8787, providerId: null })
      store.set('settings', {
        theme: prevSettings.theme,
        locale: prevSettings.locale,
        autoLaunch: false,
        dataDir: ''
      })
      clearLogs()
      // 关闭开机自启
      app.setLoginItemSettings({ openAtLogin: false })
      return { ok: true, message: '已重置全部数据' }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })

  // 重启应用（更改数据目录后生效）：先停网关释放端口再 relaunch
  ipcMain.handle('system:relaunch', async () => {
    await stopProxy()
    app.relaunch()
    app.exit(0)
  })
}
