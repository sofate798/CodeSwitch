import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { LogEntry, OpResult } from '../shared/types'

let logFile = ''
let logDir = ''
const memory: LogEntry[] = []
const MAX_MEMORY = 500
/** 日志保留天数：超过则清理旧文件（Sam-L2） */
const RETENTION_DAYS = 14
/** 单个日志文件大小上限：超过则滚动切分（Sam-L2） */
const MAX_FILE_BYTES = 5 * 1024 * 1024
/** 清空标记文件名：记录最后一次「清空日志」的时间，重启后跳过该时刻之前的历史文件 */
const CLEAR_MARKER = '.cleared'

/** appendFile 失败时只在内存落一条告警，且不重复刷屏 */
let appendWarned = false
/** 最近一次清空的时间戳（0 表示无清空标记） */
let clearedAt = 0

export function initLogger(): void {
  logDir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  logFile = path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.log`)
  clearedAt = readClearMarker()
  rotateLogs()
  loadRecentFromFile()
}

function markerFile(): string {
  return path.join(logDir, CLEAR_MARKER)
}

function readClearMarker(): number {
  try {
    const f = markerFile()
    if (!fs.existsSync(f)) return 0
    const n = Number(fs.readFileSync(f, 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

function writeClearMarker(ts: number): void {
  try {
    fs.writeFileSync(markerFile(), String(ts), 'utf8')
  } catch {
    // 标记写入失败不影响清空本身
  }
}

/** 列出 logDir 下所有 .log 历史文件（按名称/时间升序） */
function listLogFiles(): string[] {
  try {
    return fs
      .readdirSync(logDir)
      .filter((f) => f.endsWith('.log'))
      .sort()
      .map((f) => path.join(logDir, f))
  } catch {
    return []
  }
}

/**
 * 轮转清理（Sam-L2）：
 *  - 删除超过保留天数的旧日志文件；
 *  - 当天文件超过大小上限时，滚动切分为 app-<date>.<n>.log 后另起新文件。
 */
function rotateLogs(): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  for (const f of listLogFiles()) {
    try {
      if (f === logFile) continue
      const st = fs.statSync(f)
      if (st.mtimeMs < cutoff) fs.rmSync(f, { force: true })
    } catch {
      // 单个文件清理失败忽略
    }
  }
  // 滚动切分产生的 app-<date>.log.<n> 不在 listLogFiles（仅 .endsWith('.log')）集合内，
  // 须单独纳入保留期清理，否则长期运行下切分文件无限累积（clearLogs 已处理，但常规轮转也要收）。
  try {
    for (const name of fs.readdirSync(logDir)) {
      if (!/\.log\.\d+$/.test(name)) continue
      const f = path.join(logDir, name)
      try {
        if (fs.statSync(f).mtimeMs < cutoff) fs.rmSync(f, { force: true })
      } catch {
        // 单个切分文件清理失败忽略
      }
    }
  } catch {
    // 目录读取失败忽略
  }
  // 当天文件大小上限滚动
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_FILE_BYTES) {
      let i = 1
      let rolled = `${logFile}.${i}`
      while (fs.existsSync(rolled)) rolled = `${logFile}.${++i}`
      fs.renameSync(logFile, rolled)
    }
  } catch {
    // 滚动失败忽略，继续追加写
  }
}

/** 解析一行日志：格式 <iso> [level] action detail */
function parseLine(line: string, idPrefix: string): LogEntry | null {
  const m = line.match(/^(\S+)\s+\[(\w+)\]\s+(\S+)\s?(.*)$/)
  if (!m) return null
  const ts = Date.parse(m[1])
  if (Number.isNaN(ts)) return null
  return {
    id: `${idPrefix}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    ts,
    level: m[2] as LogEntry['level'],
    action: m[3],
    detail: m[4]
  }
}

/** 启动时把最近一个日志文件的内容载入内存，重启后日志页不空白 */
function loadRecentFromFile(): void {
  try {
    let candidate = logFile
    if (!fs.existsSync(candidate)) {
      // 找最近的日志文件（跨天重启场景）
      const files = listLogFiles()
      if (files.length === 0) return
      candidate = files[files.length - 1]
      logFile = candidate
    }
    // Sam-H2：清空标记之后的历史文件才允许重载，杜绝清空后重启旧日志复现
    if (clearedAt > 0) {
      const st = fs.statSync(candidate)
      if (st.mtimeMs <= clearedAt) return
    }
    const lines = fs.readFileSync(candidate, 'utf8').split('\n').filter(Boolean).slice(-MAX_MEMORY)
    for (const line of lines) {
      const entry = parseLine(line, 'loaded')
      if (entry) memory.push(entry)
    }
  } catch {
    // 日志加载失败不影响启动
  }
}

/** 仅入内存（不触发文件写），用于 appendFile 失败告警，避免递归写盘 */
function pushMemory(entry: LogEntry): void {
  memory.push(entry)
  if (memory.length > MAX_MEMORY) memory.shift()
}

export function log(level: LogEntry['level'], action: string, detail = ''): void {
  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    level,
    action,
    detail
  }
  pushMemory(entry)
  if (logFile) {
    fs.appendFile(logFile, `${new Date(entry.ts).toISOString()} [${level}] ${action} ${detail}\n`, (err) => {
      // Sam-L2：不再空回调吞错——写盘失败时至少落一条内存告警（仅一次，避免刷屏/递归）
      if (err && !appendWarned) {
        appendWarned = true
        pushMemory({
          id: `${Date.now()}-appendwarn`,
          ts: Date.now(),
          level: 'warn',
          action: 'log-write-failed',
          detail: `无法写入日志文件: ${err.message}`
        })
      }
    })
  }
}

export function getLogs(): LogEntry[] {
  return [...memory].reverse()
}

/**
 * 导出支撑（Sam-M5）：合并 logDir 下全部历史文件 + 内存，得到完整时间线。
 * 而非仅内存最近 500 条。返回按时间正序（旧在前）的日志，供 log:export 使用。
 */
export function getLogsForExport(): LogEntry[] {
  const seen = new Set<string>()
  const all: LogEntry[] = []
  const push = (e: LogEntry): void => {
    // 以 时间+动作+详情 作为去重键（内存与文件可能有重叠）
    const key = `${e.ts}|${e.level}|${e.action}|${e.detail ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    all.push(e)
  }
  // 1) 历史文件（跳过清空标记之前的文件）
  for (const f of listLogFiles()) {
    try {
      if (clearedAt > 0 && fs.statSync(f).mtimeMs <= clearedAt) continue
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        const entry = parseLine(line, 'file')
        if (entry) push(entry)
      }
    } catch {
      // 单文件解析失败忽略
    }
  }
  // 2) 内存（含尚未落盘或落盘失败的最新条目）
  for (const e of memory) push(e)
  return all.sort((a, b) => a.ts - b.ts)
}

/**
 * 清空日志（Sam-H2）：
 *  - 清空内存；
 *  - 删除 logDir 下当日及历史 .log 文件；
 *  - 写清空标记，使重启后 loadRecentFromFile / 导出跳过该时刻之前的历史，杜绝旧日志复现。
 * 返回 msg.log.clearOk。
 */
export function clearLogs(): OpResult {
  memory.length = 0
  appendWarned = false
  const now = Date.now()
  let removed = 0
  for (const f of listLogFiles()) {
    try {
      fs.rmSync(f, { force: true })
      removed++
    } catch {
      // 删除失败的文件由清空标记兜底，重启后不会被重载
    }
  }
  // 也清理滚动切分产生的 .log.<n> 文件
  try {
    for (const name of fs.readdirSync(logDir)) {
      if (/\.log\.\d+$/.test(name)) {
        fs.rmSync(path.join(logDir, name), { force: true })
        removed++
      }
    }
  } catch {
    // ignore
  }
  clearedAt = now
  writeClearMarker(now)
  // 重新指向当天文件（已被删除，下次 log 时自动创建）
  logFile = path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.log`)
  return { ok: true, code: 'msg.log.clearOk', args: { count: removed } }
}
