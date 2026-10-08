import { execFile } from 'node:child_process'

/**
 * 目标 IDE 进程检测：sql.js 采用「整库读入内存再写回」的方式，
 * 若 IDE 正在运行，退出时会用内存态覆盖数据库导致我们的写入失效甚至损坏，
 * 因此 sqlite/toml 写入前必须先确认 IDE 已关闭。
 * Windows 用 tasklist 精确匹配映像名；其它平台暂不检测（返回 false）。
 *
 * 一次 tasklist 拿全量快照而非「每个进程名一次 spawn」：
 * 扫描 11 款 IDE 时后者会串行拉起十几个子进程（每个最长 4s 超时），首页加载被拖慢；
 * 快照带极短 TTL + 并发去重，一次扫描只真正执行一次 tasklist。
 * 写入/恢复等「真正要拦」的调用走 fresh 模式，绕过缓存，避免任何陈旧窗口。
 */

/** 进程快照缓存时长（毫秒）：仅用于只读扫描，足够覆盖一次 scanIDEs 的串行循环 */
const SNAPSHOT_TTL_MS = 1500

let cached: { at: number; names: Set<string> } | null = null
let inflight: Promise<Set<string> | null> | null = null

/** 读取当前 Windows 进程映像名集合（小写）；非 Windows 或命令失败返回 null（视为“不检测”） */
function readProcessSnapshot(): Promise<Set<string> | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (inflight) return inflight
  inflight = new Promise<Set<string> | null>((resolve) => {
    // CSV 输出便于稳定解析：每行 "映像名","PID",...；/NH 去掉表头
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      inflight = null
      if (err) {
        resolve(null) // 与旧实现一致：检测失败不阻断，视为未运行
        return
      }
      const names = new Set<string>()
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)"/)
        if (m) names.add(m[1].toLowerCase())
      }
      cached = { at: Date.now(), names }
      resolve(names)
    })
  })
  return inflight
}

/** 取进程快照（force=true 时忽略缓存，保证拿到最新状态） */
async function processNames(force: boolean): Promise<Set<string> | null> {
  if (!force && cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.names
  return await readProcessSnapshot()
}

/** 单个映像名是否在运行（缓存快照，供只读展示使用） */
export async function isProcessRunning(imageName: string): Promise<boolean> {
  const names = await processNames(false)
  if (!names) return false
  return names.has(imageName.toLowerCase())
}

/** 任一进程名在运行即视为该 IDE 正在运行；fresh=true 绕过缓存（写入/恢复前的拦截判定） */
export async function isIdeRunning(processNamesArg?: string[], fresh = false): Promise<boolean> {
  if (!processNamesArg || processNamesArg.length === 0) return false
  const names = await processNames(fresh)
  if (!names) return false
  return processNamesArg.some((n) => names.has(n.toLowerCase()))
}
