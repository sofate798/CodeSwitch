import { nativeTheme, type BrowserWindow } from 'electron'

/**
 * Windows 原生标题栏覆盖层（最小化/最大化/关闭按钮）配色集中定义。
 *
 * 关键点：覆盖层颜色必须等于应用 topbar 的背景（即 main.css 的 --bg-app），
 * 否则右上角会出现一块与界面融不上的色差矩形；高度与 topbar 对齐（48px），
 * 使原生按钮垂直居中、接缝消失。
 *
 * 这里集中维护，供主进程启动与 IPC 主题切换两处复用，避免颜色/高度值漂移。
 * 若 main.css 的 --bg-app 调整，务必同步这里的取值。
 */
export const TITLE_BAR = {
  dark: { color: '#131419', symbolColor: '#e6e8ee' },
  light: { color: '#f3f4f6', symbolColor: '#1f2329' },
  height: 48
} as const

/**
 * 把用户主题设置解析为「最终明/暗」。
 * 'system' 必须跟随 OS 实际偏好（与渲染层 matchMedia('prefers-color-scheme') 同源），
 * 否则浅色系统的 system 模式下原生覆盖层会恒黑，与浅色 topbar 出现色差矩形（历史回归项）。
 */
export function resolveDark(theme: string): boolean {
  if (theme === 'light') return false
  if (theme === 'dark') return true
  return nativeTheme.shouldUseDarkColors // 'system'（及缺省）：跟随 OS
}

/** 按主题应用标题栏覆盖层与窗口背景色（仅 Windows 生效，其余平台直接返回）。 */
export function applyTitleBarOverlay(win: BrowserWindow | null, theme: string): void {
  if (!win || process.platform !== 'win32') return
  const c = resolveDark(theme) ? TITLE_BAR.dark : TITLE_BAR.light
  win.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: TITLE_BAR.height })
  win.setBackgroundColor(c.color)
}
