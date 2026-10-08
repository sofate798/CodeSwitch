import { ipcMain, dialog, app, shell, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { store, mutate } from '../services/store'
import { scanIDEs, applyProvider, resetIDE, manualAdd, generateConfig, checkIdeRunning } from '../services/ideScanner'
import { testProvider } from '../services/provider'
import { listSnapshots, createSnapshot, applySnapshot, removeSnapshot, insertSnapshot } from '../services/snapshot'
import { listBackups, restoreBackup, removeBackup } from '../services/backup'
import { getLogs, getLogsForExport, clearLogs, log } from '../services/logger'
import { proxyStatus, configureProxy, stopProxy, getProxyToken } from '../services/proxy'
import { getDataDirInfo, migrateDataDir } from '../services/paths'
import { applyTitleBarOverlay } from '../main/titleBar'
import { encrypt, decrypt, keyTail, isCipher } from '../services/crypto'
import { randomUUID } from 'node:crypto'
import type { Provider, AppSettings, Protocol, ProxyConfig, Snapshot, OpResult } from '../shared/types'

/**
 * 包装 ipcMain.handle：统一捕获底层未预期异常，规整为 { ok:false, code:'msg.common.error' } 并落错误日志，
 * 杜绝渲染端 invoke 产生 unhandled rejection。日志仅记录频道与错误描述，绝不写入明文密钥。
 */
function safeHandle(channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args)
    } catch (err) {
      log('error', `ipc:${channel}`, err instanceof Error ? err.message : String(err))
      return { ok: false, code: 'msg.common.error' } satisfies OpResult
    }
  })
}

interface DialogDict {
  exportProviders: string
  importProviders: string
  exportSnapshot: string
  importSnapshot: string
  exportLogs: string
  selectDataDir: string
  /** .csnap 文件过滤器显示名 */
  snapshotFilter: string
}

/**
 * 主进程内置轻量 zh/en 对话框文案词典（对齐 main/index.ts 托盘文案做法）。
 * 原生对话框标题/过滤器名是主进程即时显示串，无法走渲染层消息码，故在此按当前 locale 取值，杜绝硬编码中文。
 */
const DIALOG_I18N: Record<'zh' | 'en', DialogDict> = {
  zh: {
    exportProviders: '导出供应商',
    importProviders: '导入供应商',
    exportSnapshot: '导出快照',
    importSnapshot: '导入快照',
    exportLogs: '导出日志',
    selectDataDir: '选择数据目录',
    snapshotFilter: 'CodeSwitch 快照'
  },
  en: {
    exportProviders: 'Export Providers',
    importProviders: 'Import Providers',
    exportSnapshot: 'Export Snapshot',
    importSnapshot: 'Import Snapshot',
    exportLogs: 'Export Logs',
    selectDataDir: 'Select Data Directory',
    snapshotFilter: 'CodeSwitch Snapshot'
  }
}

/** 按当前 locale（store.settings.locale，默认 zh-CN）返回对话框文案词典 */
function dlgDict(): DialogDict {
  const loc = (store.get('settings') as { locale?: string })?.locale
  return loc === 'en-US' ? DIALOG_I18N.en : DIALOG_I18N.zh
}

export function registerIpc(): void {
  // ---- IDE ----
  safeHandle('ide:scan', () => scanIDEs())
  safeHandle('ide:apply', (_e, ideId: string, providerId: string) => applyProvider(ideId, providerId))
  safeHandle('ide:reset', async (_e, ideId: string) => {
    if (ideId !== 'all') return resetIDE(ideId)
    // 'all'：遍历各 IDE 调 resetIDE；resetIDE 对手动/辅助型返回 canceled=true（已跳过）。
    // 区分“成功/失败/跳过”，全部尝试均失败（无任何成功）时按失败返回，避免“恢复 0 个”被当作成功。
    let count = 0
    let failed = 0
    for (const s of await scanIDEs()) {
      if (!s.installed) continue
      const r = await resetIDE(s.id)
      if (r.canceled) continue
      if (r.ok) count++
      else failed++
    }
    if (count === 0 && failed > 0) {
      return { ok: false, code: 'msg.ide.resetAllFailed', args: { failed } } satisfies OpResult
    }
    return { ok: true, code: 'msg.ide.resetAllDone', args: { count } } satisfies OpResult
  })
  safeHandle('ide:manual-add', (_e, ideId: string, path: string) => manualAdd(ideId, path))
  safeHandle('ide:check-running', (_e, ideId: string) => checkIdeRunning(ideId))
  safeHandle('ide:generate-config', (_e, ideId: string, providerId: string) => generateConfig(ideId, providerId))

  // ---- Provider ----
  safeHandle('provider:list', () => {
    const list = store.get('providers') as Provider[]
    // keyTail 内部已容错（失败返回 ''），不会抛异常；仅输出明文后 4 位供前端脱敏展示
    return list.map((p) => ({ ...p, keyTail: keyTail(p.apiKey) }))
  })
  safeHandle('provider:save', (_e, input: Partial<Provider> & { protocol: 'openai' | 'anthropic' }) => {
    const list: Provider[] = store.get('providers')
    const now = Date.now()
    const idx = input.id ? list.findIndex((p) => p.id === input.id) : -1

    if (idx >= 0) {
      const existing = list[idx]
      // apiKey 仅在用户提供新值时加密；否则保留旧密文
      let apiKeyCipher = existing.apiKey
      if (input.apiKey && !isCipher(input.apiKey) && input.apiKey !== '****') {
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
      return { ok: true, code: 'msg.provider.saveOk', data: list[idx] } satisfies OpResult<Provider>
    }

    if (!input.name || !input.baseUrl || !input.model || !input.apiKey) {
      return { ok: false, code: 'msg.provider.missingFields' } satisfies OpResult
    }
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
    return { ok: true, code: 'msg.provider.saveOk', data: np } satisfies OpResult<Provider>
  })
  safeHandle('provider:remove', (_e, id: string) => {
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
    return { ok: true, code: 'msg.provider.removeOk' } satisfies OpResult
  })
  safeHandle('provider:test', (_e, id: string) => {
    const p = (store.get('providers') as Provider[]).find((x: Provider) => x.id === id)
    if (!p) return { ok: false, code: 'msg.common.error' } satisfies OpResult
    return testProvider(p)
  })

  // 供应商导出：主进程弹保存对话框，写出 JSON（含明文 Key，便于迁移）
  safeHandle('provider:export', async () => {
    const providers = store.get('providers')
    if (providers.length === 0) return { ok: false, code: 'msg.common.error' } satisfies OpResult
    const d = dlgDict()
    const r = await dialog.showSaveDialog({
      title: d.exportProviders,
      defaultPath: `codeswitch-providers-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    // 导出需解密明文 Key；主密钥不可用/密文损坏时 decrypt 会抛 KeyUnavailableError，
    // 绝不冒泡异常（也不写明文入日志），规整为结构化错误返回
    let entries: Array<{ name: string; protocol: Protocol; apiKey: string; baseUrl: string; model: string; group: string }>
    try {
      entries = providers.map((p) => ({
        name: p.name,
        protocol: p.protocol,
        apiKey: decrypt(p.apiKey),
        baseUrl: p.baseUrl,
        model: p.model,
        group: p.group ?? ''
      }))
    } catch {
      return { ok: false, code: 'msg.provider.keyUnavailable' } satisfies OpResult
    }
    const payload = {
      app: 'CodeSwitch',
      version: 1,
      exportedAt: new Date().toISOString(),
      providers: entries
    }
    fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, code: 'msg.provider.exportOk', data: r.filePath, args: { count: providers.length } } satisfies OpResult<string>
  })

  // 供应商导入：主进程弹打开对话框，校验后以新 id 入库（同名跳过）
  safeHandle('provider:import', async () => {
    const d = dlgDict()
    const r = await dialog.showOpenDialog({
      title: d.importProviders,
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, canceled: true }
    let parsed: any
    try {
      parsed = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))
    } catch (e) {
      // 解析失败细节落日志（便于排查），对外统一走消息码，不硬编码中文
      log('warn', 'provider:import', (e as Error).message)
      return { ok: false, code: 'msg.provider.importFailed' } satisfies OpResult
    }
    const incoming: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed.providers) ? parsed.providers : []
    const valid = incoming.filter(
      (p) => p && typeof p.name === 'string' && (p.protocol === 'openai' || p.protocol === 'anthropic') && typeof p.baseUrl === 'string'
    )
    if (valid.length === 0) return { ok: false, code: 'msg.provider.importFailed' } satisfies OpResult
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
    return { ok: true, code: 'msg.provider.importOk', args: { count: added, skipped: valid.length - added } } satisfies OpResult
  })

  // ---- Snapshot ----
  safeHandle('snapshot:list', () => listSnapshots())
  safeHandle('snapshot:create', (_e, name: string, desc: string) => createSnapshot(name, desc))
  safeHandle('snapshot:apply', (_e, id: string) => applySnapshot(id))
  safeHandle('snapshot:remove', (_e, id: string) => removeSnapshot(id))

  // 快照导出：写出 .csnap（JSON），内嵌该快照引用的供应商（含明文 Key），保证跨机可迁移
  safeHandle('snapshot:export', async (_e, id: string) => {
    const snap = (store.get('snapshots') as Snapshot[]).find((s) => s.id === id)
    if (!snap) return { ok: false, code: 'msg.common.error' } satisfies OpResult
    const providers = store.get('providers') as Provider[]
    const refIds = [
      ...new Set(
        Object.values(snap.ideBindings)
          .map((b) => b.providerId)
          .filter((x): x is string => !!x)
      )
    ]
    // 内嵌供应商需解密明文 Key；decrypt 失败（KeyUnavailableError）不冒泡，返回结构化错误
    let embedded: Array<{ refId: string; name: string; protocol: Protocol; apiKey: string; baseUrl: string; model: string; group: string }>
    try {
      embedded = refIds
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
    } catch {
      return { ok: false, code: 'msg.provider.keyUnavailable' } satisfies OpResult
    }
    const safeName = (snap.name || 'snapshot').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const d = dlgDict()
    const r = await dialog.showSaveDialog({
      title: d.exportSnapshot,
      defaultPath: `${safeName}.csnap`,
      filters: [
        { name: d.snapshotFilter, extensions: ['csnap'] },
        { name: 'JSON', extensions: ['json'] }
      ]
    })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
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
    return { ok: true, code: 'msg.snapshot.exportOk', data: r.filePath } satisfies OpResult<string>
  })

  // 快照导入：读取 .csnap，先导入内嵌供应商（同名复用、否则新建），再把绑定的 providerId 重映射到本机 id
  safeHandle('snapshot:import', async () => {
    const d = dlgDict()
    const r = await dialog.showOpenDialog({
      title: d.importSnapshot,
      properties: ['openFile'],
      filters: [{ name: d.snapshotFilter, extensions: ['csnap', 'json'] }]
    })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, canceled: true }
    let parsed: any
    try {
      parsed = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))
    } catch (e) {
      // 解析失败细节落日志（便于排查），对外统一走消息码，不硬编码中文
      log('warn', 'snapshot:import', (e as Error).message)
      return { ok: false, code: 'msg.snapshot.importFailed' } satisfies OpResult
    }
    if (!parsed || parsed.kind !== 'snapshot' || !parsed.snapshot || typeof parsed.snapshot !== 'object') {
      return { ok: false, code: 'msg.snapshot.importFailed' } satisfies OpResult
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
    if (!snap.ok) {
      // 透传服务层结构化错误码/参数；缺失时兜底为通用错误
      return snap.code ? { ok: false, code: snap.code, args: snap.args } satisfies OpResult : { ok: false, code: 'msg.common.error' } satisfies OpResult
    }
    return { ok: true, code: 'msg.snapshot.importOk', args: { count: 1, name: snap.data?.name ?? '' } } satisfies OpResult
  })

  // ---- Backup ----
  safeHandle('backup:list', (_e, ideId?: string) => listBackups(ideId))
  safeHandle('backup:restore', (_e, backupId: string) => restoreBackup(backupId))
  safeHandle('backup:remove', (_e, backupId: string) => removeBackup(backupId))

  // ---- Log ----
  safeHandle('log:list', () => getLogs())
  safeHandle('log:clear', () => clearLogs())

  // 日志导出：按 txt / json 写出当前已加载的日志（按时间正序）
  safeHandle('log:export', async (_e, format: 'txt' | 'json') => {
    const fmt: 'txt' | 'json' = format === 'json' ? 'json' : 'txt'
    const chrono = getLogsForExport() // 合并全部历史文件 + 内存，已按时间正序（旧在前）
    if (chrono.length === 0) return { ok: false, code: 'msg.common.error' } satisfies OpResult
    const date = new Date().toISOString().slice(0, 10)
    const d = dlgDict()
    const r = await dialog.showSaveDialog({
      title: d.exportLogs,
      defaultPath: `codeswitch-logs-${date}.${fmt}`,
      filters: fmt === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'Text', extensions: ['txt'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
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
    return { ok: true, code: 'msg.log.exportOk', data: r.filePath, args: { count: chrono.length } } satisfies OpResult<string>
  })

  // ---- Settings ----
  safeHandle('settings:get', () => store.get('settings'))
  safeHandle('settings:set', (_e, patch: Partial<AppSettings>) => {
    const next = { ...store.get('settings'), ...patch }
    store.set('settings', next)
    // 仅当本次修改包含 autoLaunch 时才更新开机自启，避免主题/语言切换触发副作用
    if ('autoLaunch' in patch) {
      app.setLoginItemSettings({ openAtLogin: next.autoLaunch })
    }
    // 主题变化时同步 Windows 原生标题栏按钮配色（取值与平台守卫集中在 applyTitleBarOverlay）
    if ('theme' in patch) {
      applyTitleBarOverlay(BrowserWindow.getAllWindows()[0] ?? null, next.theme)
    }
    return next
  })

  // ---- Proxy (本地转发网关) ----
  safeHandle('proxy:status', () => proxyStatus())
  safeHandle('proxy:configure', async (_e, patch: Partial<ProxyConfig>) => {
    const r = await configureProxy(patch)
    return r.data ?? proxyStatus()
  })
  // 网关本地鉴权 token：供前端在设置页展示，用户据此配置客户端（Alex-H4）
  safeHandle('proxy:token', () => getProxyToken())

  // ---- System ----
  safeHandle('system:pick-file', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      defaultPath: defaultPath || undefined
    })
    return r.canceled ? null : r.filePaths[0]
  })
  safeHandle('system:open-data-dir', () => shell.openPath(app.getPath('userData')))
  safeHandle('system:open-path', (_e, targetPath: string) => {
    if (!targetPath) return
    // 文件存在则定位选中，否则打开其所在目录
    if (fs.existsSync(targetPath)) shell.showItemInFolder(targetPath)
    else shell.openPath(targetPath)
  })

  // 数据目录：获取当前生效目录与自定义目录
  safeHandle('system:get-data-dir', () => getDataDirInfo())

  // 数据目录：弹目录选择框，迁移数据并写入引导文件；成功后提示重启
  safeHandle('system:set-data-dir', async () => {
    const d = dlgDict()
    const r = await dialog.showOpenDialog({
      title: d.selectDataDir,
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, canceled: true }
    const res = migrateDataDir(r.filePaths[0])
    if (!res.ok) {
      // migrateDataDir 的失败详情为服务层文本，仅落日志，不外泄给用户；对外统一走消息码
      log('warn', 'system:set-data-dir', res.message)
      return { ok: false, code: 'msg.common.error' } satisfies OpResult
    }
    return { ok: true, code: 'msg.settings.dataDirChanged', data: { needRestart: true } } satisfies OpResult<{ needRestart?: boolean }>
  })

  // 重置软件：清除 CodeSwitch 全部本地数据（不触碰各 IDE 自身配置文件）
  safeHandle('system:reset-all', async () => {
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
      // 多键读改写在串行队列内一次完成，消除并发竞态（Sam-M6）
      await mutate((s) => {
        const prevSettings = s.get('settings')
        s.set('providers', [])
        s.set('snapshots', [])
        s.set('backups', [])
        s.set('ideBindings', {})
        s.set('proxy', { enabled: false, port: 8787, providerId: null })
        s.set('settings', {
          theme: prevSettings.theme,
          locale: prevSettings.locale,
          autoLaunch: false,
          dataDir: ''
        })
      })
      clearLogs()
      // 关闭开机自启
      app.setLoginItemSettings({ openAtLogin: false })
      return { ok: true, code: 'msg.settings.resetDone' } satisfies OpResult
    } catch (e) {
      log('error', 'system:reset-all', (e as Error).message)
      return { ok: false, code: 'msg.common.error' } satisfies OpResult
    }
  })

  // 重启应用（更改数据目录后生效）：先停网关释放端口再 relaunch
  safeHandle('system:relaunch', async () => {
    await stopProxy()
    app.relaunch()
    app.exit(0)
  })
}
