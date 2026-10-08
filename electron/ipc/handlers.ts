import { ipcMain, dialog, app, shell, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { store, mutate } from '../services/store'
import { scanIDEs, applyProvider, resetIDE, manualAdd, generateConfig, checkIdeRunning } from '../services/ideScanner'
import { testProvider, isHttpUrl } from '../services/provider'
import { listSnapshots, createSnapshot, applySnapshot, removeSnapshot, insertSnapshot } from '../services/snapshot'
import { listBackups, restoreBackup, removeBackup } from '../services/backup'
import { getLogs, getLogsForExport, clearLogs, log } from '../services/logger'
import { proxyStatus, configureProxy, stopProxy, getProxyToken } from '../services/proxy'
import { getDataDirInfo, migrateDataDir } from '../services/paths'
import { applyTitleBarOverlay } from '../main/titleBar'
import { encrypt, decrypt, keyTail, isCipher } from '../services/crypto'
import { IDE_REGISTRY, resolvePath } from '../adapters/registry'
import { isIdeRunning } from '../services/processGuard'
import { randomUUID } from 'node:crypto'
import type { Provider, AppSettings, Protocol, MsgCode, ProxyConfig, Snapshot, OpResult } from '../shared/types'

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

/**
 * 值型通道（成功载荷是裸数据：数组 / AppSettings / ProxyStatus / string 等）的包装。
 *
 * 不能复用 safeHandle：它出错时回 { ok:false, code }，而该形状对裸数据通道不是合法值，
 * 会被渲染端当成“成功拿到的数据”直接赋值（ide:scan 返回对象 -> store.ides 不再是数组，
 * 页面运行时报错且 error 仍为 null；proxy:status 返回对象 -> 端口/URL 变 undefined），
 * 既静默吞掉失败又破坏类型前提。此处记录日志后原样抛出，让 invoke 在渲染端 reject，
 * 由已有的 allSettled / try-catch 进入真正的失败分支（展示消息码，不展示原始异常文本）。
 */
function safeHandleValue<T>(channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args)
    } catch (err) {
      log('error', `ipc:${channel}`, err instanceof Error ? err.message : String(err))
      throw err
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
  /** 导入的快照未带名称时的默认名（属于落盘数据，必须随 locale） */
  snapshotDefaultName: string
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
    snapshotFilter: 'CodeSwitch 快照',
    snapshotDefaultName: '导入的快照'
  },
  en: {
    exportProviders: 'Export Providers',
    importProviders: 'Import Providers',
    exportSnapshot: 'Export Snapshot',
    importSnapshot: 'Import Snapshot',
    exportLogs: 'Export Logs',
    selectDataDir: 'Select Data Directory',
    snapshotFilter: 'CodeSwitch Snapshot',
    snapshotDefaultName: 'Imported Snapshot'
  }
}

/** 按当前 locale（store.settings.locale，默认 zh-CN）返回对话框文案词典 */
function dlgDict(): DialogDict {
  const loc = (store.get('settings') as { locale?: string })?.locale
  return loc === 'en-US' ? DIALOG_I18N.en : DIALOG_I18N.zh
}
// ---------------- 入参校验（A1：主进程收口，不信任渲染层） ----------------

/** 供应商字段长度上限（超限拒绝落盘，避免脏数据撑坏列表/配置） */
const PROVIDER_LIMITS = { name: 80, baseUrl: 500, model: 200, group: 100 } as const
/** 快照名称/备注长度上限 */
const SNAPSHOT_LIMITS = { name: 60, description: 200 } as const
const PROTOCOLS: Protocol[] = ['openai', 'anthropic']
/** 前端掩码占位：提交值等于此串时视为未修改 Key，跳过重新加密 */
const KEY_MASK_PLACEHOLDER = '****'

const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

interface FailResult {
  ok: false
  code: MsgCode
  args?: Record<string, string | number>
}

function fail(code: MsgCode, args?: Record<string, string | number>): FailResult {
  return { ok: false, code, args }
}

/** 校验后的供应商安全入参（均已 trim） */
interface CleanProviderInput {
  name: string
  protocol: Protocol
  baseUrl: string
  model: string
  group: string
  apiKey: string
}

type ProviderValidation = { ok: true; data: CleanProviderInput } | FailResult

/**
 * 校验供应商写入入参：trim + 长度上限 + protocol 白名单 + baseUrl 必须 http(s) + 重名拦截。
 * 返回校验后的安全入参；失败返回结构化错误（消息码由前端 i18n 渲染）。
 * editingId 用于编辑态排除自身做重名检查。
 */
function validateProviderInput(input: Partial<Provider> & { protocol: Protocol }, editingId?: string): ProviderValidation {
  const name = trimmed(input.name)
  const baseUrl = trimmed(input.baseUrl)
  const model = trimmed(input.model)
  const group = trimmed(input.group)
  if (!PROTOCOLS.includes(input.protocol)) return fail('msg.provider.missingFields')
  if (name.length > PROVIDER_LIMITS.name || baseUrl.length > PROVIDER_LIMITS.baseUrl || model.length > PROVIDER_LIMITS.model || group.length > PROVIDER_LIMITS.group) {
    return fail('msg.provider.fieldTooLong')
  }
  if (baseUrl && !isHttpUrl(baseUrl)) return fail('msg.provider.invalidBaseUrl')
  if (name) {
    const list = store.get('providers') as Provider[]
    const dup = list.some((p) => p.name === name && p.id !== editingId)
    if (dup) return fail('msg.provider.duplicateName', { name })
  }
  return { ok: true, data: { name, protocol: input.protocol, baseUrl, model, group, apiKey: input.apiKey ?? '' } }
}

// ---------------- system:open-path 路径白名单（A2） ----------------

/** 规范化路径用于比较：去尾分隔符、统一分隔符；Windows 下大小写不敏感 */
function normPath(p: string): string {
  const n = path.normalize(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? n.toLowerCase() : n
}

function isSameOrInside(target: string, root: string): boolean {
  const t = normPath(target)
  const r = normPath(root)
  return t === r || t.startsWith(r + path.sep.toLowerCase())
}

/** 收集允许在文件管理器中打开的路径集：userData + 注册表全部候选路径/其父目录 + 手动指定路径 */
function openPathRoots(): string[] {
  const roots: string[] = [app.getPath('userData')]
  const pushRaw = (tpl?: string | null): void => {
    const p = tpl ? resolvePath(tpl) : null
    if (p) {
      roots.push(p)
      roots.push(path.dirname(p))
    }
  }
  for (const ide of IDE_REGISTRY) {
    ide.configPaths.forEach(pushRaw)
    ide.detectPaths.forEach(pushRaw)
    ;(ide.homeMarkers ?? []).forEach(pushRaw)
    const s = ide.storage
    if (s.kind === 'sqlite') s.dbPaths.forEach(pushRaw)
    else s.paths.forEach(pushRaw)
    if (s.kind === 'toml' && s.secretFile) pushRaw(s.secretFile.path)
  }
  for (const b of Object.values(store.get('ideBindings'))) if (b?.configPath) pushRaw(b.configPath)
  return roots
}

function openPathAllowed(targetPath: string): boolean {
  return openPathRoots().some((root) => isSameOrInside(targetPath, root))
}

export function registerIpc(): void {
  // ---- IDE ----
  safeHandleValue('ide:scan', () => scanIDEs())
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
      // 已安装但没有配置文件（notFound）＝本无可恢复，跳过；否则“全部失败”会被这类 IDE 误触发
      if (!r.ok && r.code === 'msg.ide.notFound') continue
      if (r.ok) count++
      else failed++
    }
    if (count === 0 && failed > 0) {
      return { ok: false, code: 'msg.ide.resetAllFailed', args: { failed } } satisfies OpResult
    }
    return { ok: true, code: 'msg.ide.resetAllDone', args: { count } } satisfies OpResult
  })
  safeHandle('ide:manual-add', (_e, ideId: string, path: string) => manualAdd(ideId, path))
  safeHandleValue('ide:check-running', (_e, ideId: string) => checkIdeRunning(ideId))
  safeHandle('ide:generate-config', (_e, ideId: string, providerId: string) => generateConfig(ideId, providerId))

  // ---- Provider ----
  safeHandleValue('provider:list', () => {
    const list = store.get('providers') as Provider[]
    // keyTail 内部已容错（失败返回 ''），不会抛异常；仅输出明文后 4 位供前端脱敏展示
    return list.map((p) => ({ ...p, keyTail: keyTail(p.apiKey) }))
  })
  safeHandle('provider:save', (_e, input: Partial<Provider> & { protocol: Protocol }) => {
    const list: Provider[] = store.get('providers')
    const now = Date.now()
    const idx = input.id ? list.findIndex((p) => p.id === input.id) : -1
    const v = validateProviderInput(input, idx >= 0 ? input.id : undefined)
    if (!v.ok) return v satisfies OpResult
    const clean = v.data

    if (idx >= 0) {
      const existing = list[idx]
      // apiKey 仅在用户提供新值时加密；否则保留旧密文；掩码占位/密文形状跳过重新加密
      let apiKeyCipher = existing.apiKey
      if (clean.apiKey && !isCipher(clean.apiKey) && clean.apiKey !== KEY_MASK_PLACEHOLDER) {
        apiKeyCipher = encrypt(clean.apiKey)
      }
      // 就地替换列表元素，确保修改真正落盘
      list[idx] = {
        ...existing,
        name: clean.name || existing.name,
        protocol: clean.protocol,
        baseUrl: clean.baseUrl || existing.baseUrl,
        model: clean.model || existing.model,
        // group 为可选字段（与创建路径 clean.group||undefined 对齐）：绝不能用 || existing.group 兜底，
        // 否则用户编辑时清空分组会被旧值回填，导致分组一旦设置便无法移除。
        group: clean.group || undefined,
        apiKey: apiKeyCipher,
        updatedAt: now
      }
      store.set('providers', list)
      return { ok: true, code: 'msg.provider.saveOk', data: list[idx] } satisfies OpResult<Provider>
    }

    if (!clean.name || !clean.baseUrl || !clean.model || !clean.apiKey) {
      return fail('msg.provider.missingFields') satisfies OpResult
    }
    const np: Provider = {
      id: randomUUID(),
      name: clean.name,
      protocol: clean.protocol,
      apiKey: encrypt(clean.apiKey),
      baseUrl: clean.baseUrl,
      model: clean.model,
      group: clean.group || undefined,
      createdAt: now,
      updatedAt: now
    }
    list.push(np)
    store.set('providers', list)
    return { ok: true, code: 'msg.provider.saveOk', data: np } satisfies OpResult<Provider>
  })
  safeHandle('provider:remove', async (_e, id: string) => {
    // 多键读改写（providers + ideBindings + snapshots + proxy）进串行队列，消除与 apply/reset 的并发竞态（Sam-M6）
    await mutate((s) => {
      s.set('providers', (s.get('providers') as Provider[]).filter((p: Provider) => p.id !== id))
      // 清理 ideBindings / snapshots 中对该供应商的残留引用
      const bindings = s.get('ideBindings')
      for (const [ideId, v] of Object.entries(bindings)) {
        if (v.providerId === id) bindings[ideId] = { ...v, providerId: null }
      }
      s.set('ideBindings', bindings)
      const snapshots = s.get('snapshots')
      for (const snap of snapshots) {
        for (const [ideId, b] of Object.entries(snap.ideBindings)) {
          if (b.providerId === id) snap.ideBindings[ideId] = { providerId: null }
        }
      }
      s.set('snapshots', snapshots)
      // 若该供应商正是转发网关的目标，解除绑定
      const proxy = s.get('proxy')
      if (proxy?.providerId === id) s.set('proxy', { ...proxy, providerId: null })
    })
    return { ok: true, code: 'msg.provider.removeOk' } satisfies OpResult
  })
  safeHandle('provider:test', (_e, id: string) => {
    const p = (store.get('providers') as Provider[]).find((x: Provider) => x.id === id)
    if (!p) return { ok: false, code: 'msg.common.error' } satisfies OpResult
    return testProvider(p)
  })

  // 供应商引用查询（A6）：删除前由前端展示“正被哪些 IDE 使用”，仅读不写
  safeHandle('provider:usage', (_e, id: string) => {
    const bindings = store.get('ideBindings')
    const ideIds = Object.entries(bindings)
      .filter(([, v]) => v.providerId === id)
      .map(([k]) => k)
    const ideNames = ideIds.map((x) => IDE_REGISTRY.find((d) => d.id === x)?.name ?? x)
    return { ok: true, data: { ideIds, ideNames } } satisfies OpResult<{ ideIds: string[]; ideNames: string[] }>
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
    const incoming: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.providers) ? parsed.providers : []
    const valid = incoming.filter(
      (p) => p && typeof p.name === 'string' && (p.protocol === 'openai' || p.protocol === 'anthropic') && typeof p.baseUrl === 'string'
    )
    if (valid.length === 0) return { ok: false, code: 'msg.provider.importFailed' } satisfies OpResult
    const list: Provider[] = store.get('providers')
    const existingNames = new Set(list.map((p) => p.name))
    const now = Date.now()
    let added = 0
    for (const p of valid) {
      // 导入文件不可信：复用保存时的同一套校验（trim / 长度 / http(s) / 协议），名称与 URL 必填
      const v = validateProviderInput({ name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, model: String(p.model ?? ''), group: typeof p.group === 'string' ? p.group : '' })
      if (!v.ok || !v.data.name || !v.data.baseUrl || existingNames.has(v.data.name)) continue
      // 同一文件内的同名条目也只收第一条，否则会绕过重名约束
      existingNames.add(v.data.name)
      list.push({
        id: randomUUID(),
        name: v.data.name,
        protocol: v.data.protocol,
        apiKey: encrypt(String(p.apiKey ?? '')),
        baseUrl: v.data.baseUrl,
        model: v.data.model,
        group: v.data.group || undefined,
        createdAt: now,
        updatedAt: now
      })
      added++
    }
    store.set('providers', list)
    return { ok: true, code: 'msg.provider.importOk', args: { count: added, skipped: valid.length - added } } satisfies OpResult
  })

  // ---- Snapshot ----
  safeHandleValue('snapshot:list', () => listSnapshots())
  safeHandle('snapshot:create', (_e, name: string, desc: string) => {
    // 主进程收口：名称 trim 后必填且不超长，备注限长（前端同步校验，此处兜底）
    const n = trimmed(name)
    if (!n || n.length > SNAPSHOT_LIMITS.name) return fail('msg.snapshot.nameRequired') satisfies OpResult
    const d = trimmed(desc)
    if (d.length > SNAPSHOT_LIMITS.description) return fail('msg.provider.fieldTooLong', { max: SNAPSHOT_LIMITS.description }) satisfies OpResult
    return createSnapshot(n, d)
  })
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
    // 文案 msg.snapshot.importOk 的 {count} 是「快照内嵌的供应商数」（新建或同名复用均计入），绝不能写死 1
    let providerCount = 0
    for (const ep of Array.isArray(parsed.providers) ? parsed.providers : []) {
      if (!ep || typeof ep.name !== 'string' || (ep.protocol !== 'openai' && ep.protocol !== 'anthropic')) continue
      const name = ep.name.trim()
      const existing = list.find((p) => p.name === name)
      if (existing) {
        providerCount++
        if (ep.refId) idMap.set(ep.refId, existing.id)
        continue
      }
      // .csnap 不可信：与 provider:import 同口径校验，不合格的内嵌供应商不入库（其绑定随之回落为默认）
      const v = validateProviderInput({ name, protocol: ep.protocol, baseUrl: String(ep.baseUrl ?? ''), model: String(ep.model ?? ''), group: typeof ep.group === 'string' ? ep.group : '' })
      if (!v.ok || !v.data.name || !v.data.baseUrl) continue
      providerCount++
      const np: Provider = {
        id: randomUUID(),
        name: v.data.name,
        protocol: v.data.protocol,
        apiKey: encrypt(String(ep.apiKey ?? '')),
        baseUrl: v.data.baseUrl,
        model: v.data.model,
        group: v.data.group || undefined,
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
    // 名称缺失/仅空白时统一回落到当前 locale 的默认名，绝不下沉到服务层去兜底本地化文案。
    const importedName = (typeof parsed.snapshot.name === 'string' ? parsed.snapshot.name.trim() : '') || d.snapshotDefaultName
    const snap = insertSnapshot({
      name: importedName,
      description: typeof parsed.snapshot.description === 'string' ? parsed.snapshot.description : '',
      createdAt: typeof parsed.snapshot.createdAt === 'number' ? parsed.snapshot.createdAt : now,
      ideBindings: remapped
    })
    if (!snap.ok) {
      // 透传服务层结构化错误码/参数；缺失时兜底为通用错误
      return snap.code ? { ok: false, code: snap.code, args: snap.args } satisfies OpResult : { ok: false, code: 'msg.common.error' } satisfies OpResult
    }
    return { ok: true, code: 'msg.snapshot.importOk', args: { count: providerCount, name: snap.data?.name ?? '' } } satisfies OpResult
  })

  // ---- Backup ----
  safeHandleValue('backup:list', (_e, ideId?: string) => listBackups(ideId))
  safeHandle('backup:restore', async (_e, backupId: string) => {
    // 与 apply/reset 同口径：整库/整文件回写前必须确认目标 IDE 已关闭，否则其退出时会用内存态覆盖恢复结果
    const ideId = listBackups().find((b) => b.id === backupId)?.ideId
    const ide = IDE_REGISTRY.find((d) => d.id === ideId)
    if (ide && (await isIdeRunning(ide.processNames, true))) {
      return { ok: false, code: 'msg.ide.needClose', args: { name: ide.name } } satisfies OpResult
    }
    return restoreBackup(backupId)
  })
  safeHandle('backup:remove', (_e, backupId: string) => removeBackup(backupId))

  // ---- Log ----
  safeHandleValue('log:list', () => getLogs())
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
  safeHandleValue('settings:get', () => store.get('settings'))
  safeHandleValue('settings:set', (_e, patch: Partial<AppSettings>) => {
    // 白名单校验：非法枚举/类型的键忽略并落警告，杜绝脏入参落盘后破坏界面/启动项
    const rules: Record<keyof AppSettings, (v: unknown) => boolean> = {
      theme: (v) => v === 'system' || v === 'dark' || v === 'light',
      locale: (v) => v === 'zh-CN' || v === 'en-US',
      autoLaunch: (v) => typeof v === 'boolean',
      dataDir: (v) => typeof v === 'string'
    }
    const clean: Partial<AppSettings> = {}
    for (const [k, v] of Object.entries(patch ?? {})) {
      const rule = rules[k as keyof AppSettings]
      if (rule && rule(v)) (clean as Record<string, unknown>)[k] = v
      else log('warn', 'settings:set', `ignored invalid setting key: ${String(k)}`)
    }
    const next = { ...store.get('settings'), ...clean }
    store.set('settings', next)
    // 仅当本次修改包含 autoLaunch 时才更新开机自启，避免主题/语言切换触发副作用
    if ('autoLaunch' in clean) {
      app.setLoginItemSettings({ openAtLogin: next.autoLaunch })
    }
    // 主题变化时同步 Windows 原生标题栏按钮配色（取值与平台守卫集中在 applyTitleBarOverlay）
    if ('theme' in clean) {
      applyTitleBarOverlay(BrowserWindow.getAllWindows()[0] ?? null, next.theme)
    }
    return next
  })

  // ---- Proxy (本地转发网关) ----
  safeHandleValue('proxy:status', () => proxyStatus())
  // 透传完整 OpResult<ProxyStatus>（A4）：失败带消息码（如端口占用），data 仍携最新状态
  safeHandle('proxy:configure', async (_e, patch: Partial<ProxyConfig>) => configureProxy(patch))
  // 网关本地鉴权 token：供前端在设置页展示，用户据此配置客户端（Alex-H4）
  safeHandleValue('proxy:token', () => getProxyToken())

  // ---- System ----
  safeHandleValue('system:pick-file', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      defaultPath: defaultPath || undefined
    })
    return r.canceled ? null : r.filePaths[0]
  })
  safeHandle('system:open-data-dir', () => shell.openPath(app.getPath('userData')))
  safeHandle('system:open-path', (_e, targetPath: string) => {
    if (!targetPath) return
    // A2 安全收口：仅允许打开 userData 与 IDE 注册表候选路径集内的位置，拒绝任意路径探测
    if (!openPathAllowed(targetPath)) {
      log('warn', 'system:open-path', `rejected path outside allowed roots: ${targetPath}`)
      return
    }
    // 文件存在则定位选中；否则仅当父路径确为目录时才打开它。
    // openPath 会用默认程序“执行”文件，父路径若是可执行文件（如 x.exe\nonexistent）绝不能交给它。
    if (fs.existsSync(targetPath)) {
      shell.showItemInFolder(targetPath)
      return
    }
    const dir = path.dirname(targetPath)
    try {
      if (fs.statSync(dir).isDirectory()) shell.openPath(dir)
    } catch {
      // 父目录也不存在：无可打开
    }
  })

  // 数据目录：获取当前生效目录与自定义目录
  safeHandleValue('system:get-data-dir', () => getDataDirInfo())

  // 数据目录：弹目录选择框，迁移数据并写入引导文件；成功后提示重启
  safeHandle('system:set-data-dir', async () => {
    const d = dlgDict()
    const r = await dialog.showOpenDialog({
      title: d.selectDataDir,
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, canceled: true }
    const res = migrateDataDir(r.filePaths[0])
    // migrateDataDir 已统一 OpResult：失败只带消息码（同目录=dataDirSame，其余异常=common.error，细节已在服务层落日志）
    if (!res.ok) return res
    return { ...res, data: { needRestart: true } } satisfies OpResult<{ needRestart?: boolean }>
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
