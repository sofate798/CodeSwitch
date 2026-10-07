import { execFile } from 'node:child_process'

/**
 * 目标 IDE 进程检测：sql.js 采用「整库读入内存再写回」的方式，
 * 若 IDE 正在运行，退出时会用内存态覆盖数据库导致我们的写入失效甚至损坏，
 * 因此 sqlite/toml 写入前必须先确认 IDE 已关闭。
 * Windows 用 tasklist 精确匹配映像名；其它平台暂不检测（返回 false）。
 */
export function isProcessRunning(imageName: string): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${imageName}`, '/NH'],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err) return resolve(false)
        // tasklist 未命中时输出 "INFO: No tasks..."，命中时包含映像名
        resolve(stdout.toLowerCase().includes(imageName.toLowerCase()))
      }
    )
  })
}

/** 任一进程名在运行即视为该 IDE 正在运行 */
export async function isIdeRunning(processNames?: string[]): Promise<boolean> {
  if (!processNames || processNames.length === 0) return false
  for (const name of processNames) {
    if (await isProcessRunning(name)) return true
  }
  return false
}
