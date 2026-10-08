import { app, shell, BrowserWindow, Tray, Menu, ipcMain } from 'electron'
// 必须最先执行：在 electron-store 实例化前重定向 userData（自定义数据目录）
import './bootstrap'
import path from 'node:path'
import { registerIpc } from '../ipc/handlers'
import { initLogger, log } from '../services/logger'
import { store } from '../services/store'
import { autoStartProxy, stopProxy } from '../services/proxy'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuiting = false

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

function createTray(): void {
  const iconPath = path.join(__dirname, '../../resources/icons/icon.ico')
  tray = new Tray(iconPath)
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => win?.show() },
    { type: 'separator' },
    {
      label: '退出 CodeSwitch',
      click: () => {
        isQuiting = true
        app.quit()
      }
    }
  ])
  tray.setToolTip('CodeSwitch')
  tray.setContextMenu(menu)
  tray.on('double-click', () => win?.show())
}

function setupAutoUpdater(): void {
  ipcMain.handle('system:check-update', async () => {
    // electron-updater 在开发模式下没有 feed URL，直接返回提示
    if (!app.isPackaged) {
      return { pending: false, available: false, message: '开发模式下不检查更新' }
    }
    try {
      const { autoUpdater } = await import('electron-updater')
      const r = await autoUpdater.checkForUpdates()
      if (r?.updateInfo) {
        return { pending: false, available: true, version: r.updateInfo.version, message: r.updateInfo.version }
      }
      return { pending: false, available: false, message: 'up-to-date' }
    } catch (e: any) {
      return { pending: false, available: false, message: e?.message ?? 'check failed' }
    }
  })
}

app.whenReady().then(() => {
  initLogger()
  registerIpc()
  setupAutoUpdater()
  createWindow()
  createTray()
  // 若用户曾启用转发网关，开机自动拉起
  autoStartProxy().catch((e) => log('error', 'proxy', `auto-start failed: ${(e as Error).message}`))

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
