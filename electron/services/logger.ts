import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { LogEntry } from '../shared/types'

let logFile = ''
let logDir = ''
const memory: LogEntry[] = []
const MAX_MEMORY = 500

export function initLogger(): void {
  logDir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  logFile = path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.log`)
  loadRecentFromFile()
}

/** 启动时把最近一个日志文件的内容载入内存，重启后日志页不空白 */
function loadRecentFromFile(): void {
  try {
    if (!fs.existsSync(logFile)) {
      // 找最近的日志文件（跨天重启场景）
      const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log')).sort()
      if (files.length === 0) return
      logFile = path.join(logDir, files[files.length - 1])
    }
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-MAX_MEMORY)
    for (const line of lines) {
      // 格式: <iso> [level] action detail
      const m = line.match(/^(\S+)\s+\[(\w+)\]\s+(\S+)\s?(.*)$/)
      if (!m) continue
      const ts = Date.parse(m[1])
      if (Number.isNaN(ts)) continue
      memory.push({ id: `loaded-${ts}-${Math.random().toString(36).slice(2, 8)}`, ts, level: m[2] as LogEntry['level'], action: m[3], detail: m[4] })
    }
  } catch {
    // 日志加载失败不影响启动
  }
}

export function log(level: LogEntry['level'], action: string, detail = ''): void {
  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    level,
    action,
    detail
  }
  memory.push(entry)
  if (memory.length > MAX_MEMORY) memory.shift()
  if (logFile) {
    fs.appendFile(logFile, `${new Date(entry.ts).toISOString()} [${level}] ${action} ${detail}\n`, () => {})
  }
}

export function getLogs(): LogEntry[] {
  return [...memory].reverse()
}

export function clearLogs(): void {
  memory.length = 0
}
