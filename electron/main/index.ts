import { app, shell, BrowserWindow, Tray, Menu, ipcMain, nativeTheme } from 'electron'
// 必须最先执行：在 electron-store 实例化前重定向 userData（自定义数据目录）
import './bootstrap'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from '../ipc/handlers'
import { IDE_REGISTRY } from '../adapters/registry'
import { initLogger, log } from '../services/logger'
import { store } from '../services/store'
import { autoStartProxy, stopProxy } from '../services/proxy'
import { isLegacyCipher, migrateCipher } from '../services/crypto'
import { applyTitleBarOverlay, resolveDark, TITLE_BAR } from './titleBar'
import type { OpResult, Provider } from '../shared/types'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuiting = false

/**
 * 全局异常兜底（Sam-M3）：主进程任何未捕获异常/未处理拒绝都落日志并优雅降级，
 * 避免静默崩溃。在模块加载时即注册，尽早生效。
 */
function registerProcessGuards(): void {
  process.on('uncaughtException', (err) => {
    try {
      log('error', 'uncaughtException', String((err as Error)?.message ?? err))
    } catch {
      // 日志本身失败也不能再抛
    }
  })
  process.on('unhandledRejection', (reason) => {
    try {
      log('error', 'unhandledRejection', String((reason as Error)?.message ?? reason))
    } catch {
      // ignore
    }
  })
}
registerProcessGuards()

/**
 * 根据主题切换 Windows 原生标题栏按钮（最小化/最大化/关闭）的配色。
 * 具体取值与“覆盖层颜色必须等于 topbar 背景”的约束集中在 ./titleBar 中维护。
 */
function currentTheme(): string {
  return (store.get('settings') as { theme?: string })?.theme ?? 'system'
}

export function applyTitleBarTheme(theme: string): void {
  applyTitleBarOverlay(win, theme)
}

// OS 明暗实时切换时重解析标题栏配色（仅 'system' 模式实际会变，显式 light/dark 保持不动），
// 与渲染层 prefers-color-scheme 响应保持同步，避免系统切浅色后原生按钮区仍停在深色。
nativeTheme.on('updated', () => applyTitleBarOverlay(win, currentTheme()))

function createWindow(): void {
  // 首帧即按解析后的实际明暗着色，避免浅色系统下先闪现深色背景再纠正。
  const initialDark = resolveDark(currentTheme())
  const initialBar = initialDark ? TITLE_BAR.dark : TITLE_BAR.light
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    center: true,
    autoHideMenuBar: true,
    backgroundColor: initialBar.color,
    title: 'CodeSwitch',
    icon: path.join(__dirname, '../../resources/icons/icon.ico'),
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay: process.platform === 'win32'
      ? { ...initialBar, height: TITLE_BAR.height }
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win?.show())

  // 启动时按已解析的主题应用一次标题栏配色，避免浅色用户看到黑条
  applyTitleBarTheme(currentTheme())
  win.webContents.setWindowOpenHandler((details) => {
    // 外链收口：openExternal 会把 URL 交给系统 shell，非 http(s)/mailto 的 scheme（如 file: / 自定义协议）
    // 可能直接拉起本地程序或泄露本地路径，此处一律丢弃并落日志。
    let protocol = ''
    try {
      protocol = new URL(details.url).protocol
    } catch {
      protocol = ''
    }
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
      shell.openExternal(details.url).catch((e) => log('error', 'openExternal', String((e as Error)?.message ?? e)))
    } else {
      log('warn', 'window-open', `rejected non-web scheme: ${details.url.slice(0, 120)}`)
    }
    return { action: 'deny' }
  })

  // 阻止主窗口导航离开应用本体（渲染进程只跑本地打包资源 / dev server）。
  // 没有此守卫时，一个意外跳转就会把界面换成外部页面，同时失去 window.api 桥接。
  // preload 会注入到窗口加载的任何页面，放行任意 file:// 等于把 window.api 交给任意本地 HTML，故只认应用入口本身。
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppEntryUrl(url)) {
      e.preventDefault()
      log('warn', 'will-navigate', `blocked navigation to ${url.slice(0, 120)}`)
    }
  })

  // 关闭按钮 -> 最小化到托盘
  win.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault()
      win?.hide()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(RENDERER_INDEX)
  }
}

const RENDERER_INDEX = path.join(__dirname, '../renderer/index.html')

/** dev 按 origin 精确比对（前缀比对会放行 localhost:5173.evil.com 之类）；生产只认打包后的 index.html */
function isAppEntryUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) {
    try {
      return u.origin === new URL(dev).origin
    } catch {
      return false
    }
  }
  if (u.protocol !== 'file:') return false
  const norm = (p: string): string => decodeURIComponent(p).toLowerCase()
  return norm(u.pathname) === norm(pathToFileURL(RENDERER_INDEX).pathname)
}

// ---------------- 托盘本地化（Tina-H2） ----------------

interface TrayDict {
  show: string
  quit: string
  tooltip: string
}

/** 主进程内置轻量 zh/en 词典，复用 tray.show / tray.quit 语义，不再硬编码中文 */
const TRAY_I18N: Record<'zh' | 'en', TrayDict> = {
  zh: { show: '显示主窗口', quit: '退出 CodeSwitch', tooltip: 'CodeSwitch' },
  en: { show: 'Show Main Window', quit: 'Quit CodeSwitch', tooltip: 'CodeSwitch' }
}

function trayDict(): TrayDict {
  const loc = (store.get('settings') as { locale?: string })?.locale
  return loc === 'en-US' ? TRAY_I18N.en : TRAY_I18N.zh
}

/** 按当前 locale 重建托盘菜单；语言变更时调用以刷新 */
function refreshTray(): void {
  if (!tray) return
  const d = trayDict()
  tray.setToolTip(d.tooltip)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: d.show, click: () => win?.show() },
      { type: 'separator' },
      {
        label: d.quit,
        click: () => {
          isQuiting = true
          app.quit()
        }
      }
    ])
  )
}

function createTray(): void {
  const iconPath = path.join(__dirname, '../../resources/icons/icon.ico')
  tray = new Tray(iconPath)
  refreshTray()
  tray.on('double-click', () => win?.show())
}

// ---------------- 自动更新（Sam-H1，事件驱动） ----------------

let autoUpdater: any = null
let downloadedVersion = ''

/** 语义化版本比较：latest 是否严格新于 current */
function isNewerVersion(latest: string, current: string): boolean {
  const pa = String(latest).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(current).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const a = pa[i] || 0
    const b = pb[i] || 0
    if (a > b) return true
    if (a < b) return false
  }
  return false
}

async function getAutoUpdater(): Promise<any> {
  if (autoUpdater) return autoUpdater
  const mod = await import('electron-updater')
  autoUpdater = mod.autoUpdater
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info: any) => {
    downloadedVersion = info?.version ?? ''
    log('info', 'update', `downloaded ${downloadedVersion}`)
  })
  autoUpdater.on('error', (e: any) => log('error', 'update', String(e?.message ?? e)))
  return autoUpdater
}

function setupAutoUpdater(): void {
  // 当前应用版本（供关于区展示，拔除前端硬编码）
  ipcMain.handle('system:get-version', () => app.getVersion())

  // 更新状态：downloadedVersion 非空表示已有下载完成的更新，前端据此展示“立即安装”
  ipcMain.handle('system:get-update-state', () => ({ downloadedVersion }))

  ipcMain.handle('system:check-update', async (): Promise<OpResult> => {
    // 开发模式无 feed URL，优雅降级
    if (!app.isPackaged) return { ok: false, code: 'msg.update.noFeed' }
    try {
      const au = await getAutoUpdater()
      const current = app.getVersion()
      return await new Promise<OpResult>((resolve) => {
        let settled = false
        const off = (): void => {
          au.removeListener('update-available', onAvailable)
          au.removeListener('update-not-available', onNotAvailable)
          au.removeListener('error', onError)
        }
        const done = (r: OpResult): void => {
          if (settled) return
          settled = true
          off()
          clearTimeout(timer)
          resolve(r)
        }
        function onAvailable(info: any): void {
          const v = info?.version ?? ''
          // 用 updateInfo.version 与本地版本比较，绝不"只要联网就恒判有更新"
          if (v && isNewerVersion(v, current)) done({ ok: true, code: 'msg.update.available', args: { version: v } })
          else done({ ok: false, code: 'msg.update.notAvailable' })
        }
        function onNotAvailable(): void {
          done({ ok: false, code: 'msg.update.notAvailable' })
        }
        function onError(e: any): void {
          const msg = String(e?.message ?? e ?? '')
          const noFeed = /publish|feed|update config|no update|ENOENT.*app-update/i.test(msg)
          done({ ok: false, code: noFeed ? 'msg.update.noFeed' : 'msg.update.error', args: { reason: msg } })
        }
        const timer = setTimeout(() => done({ ok: false, code: 'msg.update.error', args: { reason: 'timeout' } }), 30000)
        au.on('update-available', onAvailable)
        au.on('update-not-available', onNotAvailable)
        au.on('error', onError)
        au.checkForUpdates().catch(onError)
      })
    } catch (e) {
      // 未配置 publish feed 等情况优雅降级
      return { ok: false, code: 'msg.update.noFeed', args: { reason: String((e as Error)?.message ?? e) } }
    }
  })

  // update-downloaded 后支持手动安装并重启（通道由 B4 在 preload/API 暴露）
  ipcMain.handle('system:install-update', async (): Promise<OpResult> => {
    try {
      const au = await getAutoUpdater()
      if (downloadedVersion) {
        isQuiting = true
        setImmediate(() => {
          try {
            au.quitAndInstall()
          } catch (e) {
            log('error', 'update', `quitAndInstall failed: ${String((e as Error)?.message ?? e)}`)
          }
        })
        return { ok: true, code: 'msg.update.downloaded', args: { version: downloadedVersion } }
      }
      return { ok: false, code: 'msg.update.notAvailable' }
    } catch (e) {
      return { ok: false, code: 'msg.update.error', args: { reason: String((e as Error)?.message ?? e) } }
    }
  })
}

// ---------------- 启动密钥迁移（旧密文 → 新密文） ----------------

/**
 * whenReady 后调用：对 providers 中 isLegacyCipher 为真的密文用 migrateCipher 重加密写回。
 * 逐条 try/catch，单条失败仅记录日志并标记需重新输入，绝不因单条失败导致整体崩溃。
 * 注意：绝不将 API Key 明文写入日志，仅记录 provider id 与错误信息。
 */
function migrateLegacyCiphers(): void {
  try {
    const providers = store.get('providers') as Provider[]
    let changed = false
    for (const p of providers) {
      try {
        if (p?.apiKey && isLegacyCipher(p.apiKey)) {
          p.apiKey = migrateCipher(p.apiKey)
          changed = true
        }
      } catch (e) {
        // 迁移失败：保留原密文不破坏数据，记录日志并标记该供应商需重新输入 Key
        log('error', 'key-migrate', `provider ${p?.id ?? '?'} migration failed, needs re-entry: ${String((e as Error)?.message ?? e)}`)
      }
    }
    if (changed) store.set('providers', providers)
    // snapshots 当前仅保存 providerId 引用、不含密文字段；如未来引入密文可在此扩展同样的逐条迁移
  } catch (e) {
    log('error', 'key-migrate', `fatal: ${String((e as Error)?.message ?? e)}`)
  }
}

// ---------------- 启动适配器对齐（清理已下架 IDE 的孤儿绑定） ----------------

/**
 * 注册表里被移除的 IDE（如早期的 GitHub Copilot）会在老用户数据里留下 ideBindings 孤儿键：
 * 扫描结果不再包含它，但「删除前引用查询 / 快照应用」仍会读到并报「IDE 未找到」。
 * 启动时按当前注册表剪除这些键（只动 CodeSwitch 自己的绑定记录，不碰 IDE 的配置文件）。
 */
function pruneStaleIdeBindings(): void {
  try {
    const bindings = store.get('ideBindings') as Record<string, unknown>
    const known = new Set(IDE_REGISTRY.map((d) => d.id))
    const stale = Object.keys(bindings).filter((id) => !known.has(id))
    if (!stale.length) return
    for (const id of stale) delete bindings[id]
    store.set('ideBindings', bindings)
    log('info', 'bindings-prune', `removed stale adapters: ${stale.join(', ')}`)
  } catch (e) {
    // 剪除失败不阻断启动：最差情况退回「快照应用报未找到」的旧行为
    log('error', 'bindings-prune', `failed: ${String((e as Error)?.message ?? e)}`)
  }
}

// ---------------- 单实例锁 ----------------

/**
 * 本应用关闭窗口仅隐藏到托盘（常驻后台），若无单实例锁，二次启动会产生两个进程：
 * 共用同一 userData（electron-store config.json 并发写有损坏风险）、网关端口 EADDRINUSE、
 * 双托盘图标。抢锁失败直接退出；已在运行的实例收到 second-instance 时唤起并聚焦主窗口。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (!win.isVisible()) win.show()
    if (win.isMinimized()) win.restore()
    win.focus()
  })
}

app.whenReady().then(() => {
  // app.quit() 是异步的，抢锁失败的第二实例仍可能走到 ready：此时绝不能再迁移密钥写 store、拉起网关、建托盘
  if (!gotSingleInstanceLock) return
  initLogger()
  registerIpc()
  setupAutoUpdater()
  createWindow()
  createTray()
  // 启动密钥迁移（旧→新重加密）
  migrateLegacyCiphers()
  pruneStaleIdeBindings()
  // 若用户曾启用转发网关，开机自动拉起
  autoStartProxy().catch((e) => log('error', 'proxy', `auto-start failed: ${(e as Error).message}`))

  // 语言变更时刷新托盘菜单（Tina-H2）
  store.onDidChange('settings', (nv: any, ov: any) => {
    if (nv?.locale !== ov?.locale) refreshTray()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  // 任何来源的退出（托盘外的 app.quit、更新安装等）都要放行窗口关闭，否则 close 被拦成“隐藏到托盘”而卡住退出
  isQuiting = true
  stopProxy().catch(() => {})
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuiting) app.quit()
})
