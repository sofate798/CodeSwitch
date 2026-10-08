import { app, shell, BrowserWindow, Tray, Menu, ipcMain } from 'electron'
// 必须最先执行：在 electron-store 实例化前重定向 userData（自定义数据目录）
import './bootstrap'
import path from 'node:path'
import { registerIpc } from '../ipc/handlers'
import { initLogger, log } from '../services/logger'
import { store } from '../services/store'
import { autoStartProxy, stopProxy } from '../services/proxy'
import { isLegacyCipher, migrateCipher } from '../services/crypto'
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
 * 深色：侧栏底色 #1b1d23 + 浅色图标；浅色：白底 + 深色图标。
 */
export function applyTitleBarTheme(theme: string): void {
  if (!win || process.platform !== 'win32') return
  const light = theme === 'light'
  win.setTitleBarOverlay({
    color: light ? '#ffffff' : '#1b1d23',
    symbolColor: light ? '#1f2329' : '#e6e8ee',
    height: 40
  })
  win.setBackgroundColor(light ? '#f3f4f6' : '#141519')
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    center: true,
    autoHideMenuBar: true,
    backgroundColor: '#141519',
    title: 'CodeSwitch',
    icon: path.join(__dirname, '../../resources/icons/icon.ico'),
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay: process.platform === 'win32'
      ? { color: '#1b1d23', symbolColor: '#e6e8ee', height: 40 }
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win?.show())

  // 启动时按已保存的主题应用一次标题栏配色，避免浅色用户看到黑条
  applyTitleBarTheme((store.get('settings') as { theme?: string })?.theme ?? 'dark')
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
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

app.whenReady().then(() => {
  initLogger()
  registerIpc()
  setupAutoUpdater()
  createWindow()
  createTray()
  // 启动密钥迁移（旧→新重加密）
  migrateLegacyCiphers()
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
  stopProxy().catch(() => {})
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuiting) app.quit()
})
