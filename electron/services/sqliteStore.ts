import fs from 'node:fs'
import path from 'node:path'

/**
 * 基于 sql.js（WASM）的 SQLite 读写封装。
 * 采用「整库读入内存 -> 修改 -> export -> 原子写回」策略，无 native 依赖，打包最简单。
 * 要求目标 IDE 已关闭（由 processGuard 保证），否则退出时会覆盖我们的写入。
 *
 * VS Code 系 IDE 的自定义凭证存于 globalStorage/state.vscdb 的 ItemTable：
 *   CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)
 * value 可能是 TEXT(JSON) 或 BLOB，读写时镜像其原始类型。
 */

// sql.js 无内置类型，用 require 拿 any，避免额外 @types 依赖
// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs = require('sql.js') as (config?: { locateFile?: (f: string) => string }) => Promise<any>

let sqlPromise: Promise<any> | null = null

function wasmFile(): string {
  // require.resolve('sql.js') -> .../dist/sql-wasm.js，同目录即 sql-wasm.wasm
  const entry = require.resolve('sql.js')
  return path.join(path.dirname(entry), 'sql-wasm.wasm')
}

function getSql(): Promise<any> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => wasmFile() })
  }
  return sqlPromise
}

export interface SqliteRow {
  rowKey: string
  /** value 列的文本内容（BLOB 会按 utf8 解码） */
  valueText: string | null
  /** 原值是否为 BLOB 类型，写回时镜像 */
  isBlob: boolean
}

function toText(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8')
  return String(v)
}

/** 打开数据库（读入内存），调用方负责 close */
async function openDb(dbPath: string): Promise<any> {
  const SQL = await getSql()
  const buf = fs.readFileSync(dbPath)
  return new SQL.Database(new Uint8Array(buf))
}

/** 按已知行键读取一行 */
export async function readItem(
  dbPath: string,
  table: string,
  keyCol: string,
  valCol: string,
  rowKey: string
): Promise<SqliteRow | null> {
  if (!fs.existsSync(dbPath)) return null
  const db = await openDb(dbPath)
  try {
    const stmt = db.prepare(`SELECT ${keyCol} AS k, ${valCol} AS v FROM ${table} WHERE ${keyCol} = ?`)
    stmt.bind([rowKey])
    if (stmt.step()) {
      const row = stmt.getAsObject() as { k: unknown; v: unknown }
      return { rowKey, valueText: toText(row.v), isBlob: row.v instanceof Uint8Array }
    }
    return null
  } finally {
    db.close()
  }
}

/**
 * 自适应探测：遍历表中所有行，找出 value 为 JSON 且包含任一特征键的行。
 * 用于 schema 未知 / 版本各异的 VS Code 分支（Trae/Kiro/Qoder/Windsurf）。
 */
export async function probeItem(
  dbPath: string,
  table: string,
  keyCol: string,
  valCol: string,
  contains: string[]
): Promise<SqliteRow | null> {
  if (!fs.existsSync(dbPath) || contains.length === 0) return null
  const db = await openDb(dbPath)
  try {
    const res = db.exec(`SELECT ${keyCol} AS k, ${valCol} AS v FROM ${table}`)
    if (!res || res.length === 0) return null
    const rows: any[][] = res[0].values
    for (const [k, v] of rows) {
      const text = toText(v)
      if (!text) continue
      let parsed: any
      try {
        parsed = JSON.parse(text)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== 'object') continue
      const flat = JSON.stringify(parsed).toLowerCase()
      if (contains.some((c) => flat.includes(c.toLowerCase()))) {
        return { rowKey: String(k), valueText: text, isBlob: v instanceof Uint8Array }
      }
    }
    return null
  } finally {
    db.close()
  }
}

/** 原子写回一行（INSERT OR REPLACE），保持原值类型（TEXT/BLOB） */
export async function writeItem(
  dbPath: string,
  table: string,
  keyCol: string,
  valCol: string,
  rowKey: string,
  valueText: string,
  isBlob: boolean
): Promise<void> {
  const SQL = await getSql()
  let db: any
  // 文件存在则在其基础上改，否则新建库并建表
  if (fs.existsSync(dbPath)) {
    db = await openDb(dbPath)
  } else {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    db = new SQL.Database()
    db.run(`CREATE TABLE IF NOT EXISTS ${table} (${keyCol} TEXT UNIQUE ON CONFLICT REPLACE, ${valCol} BLOB)`)
  }
  try {
    const bindVal = isBlob ? new Uint8Array(Buffer.from(valueText, 'utf8')) : valueText
    db.run(
      `INSERT OR REPLACE INTO ${table} (${keyCol}, ${valCol}) VALUES (?, ?)`,
      [rowKey, bindVal]
    )
    const data: Uint8Array = db.export()
    const tmp = `${dbPath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, Buffer.from(data))
    fs.renameSync(tmp, dbPath)
  } finally {
    db.close()
  }
}

/** 删除一行（恢复默认时用） */
export async function deleteItem(
  dbPath: string,
  table: string,
  keyCol: string,
  rowKey: string
): Promise<void> {
  if (!fs.existsSync(dbPath)) return
  const db = await openDb(dbPath)
  try {
    db.run(`DELETE FROM ${table} WHERE ${keyCol} = ?`, [rowKey])
    const data: Uint8Array = db.export()
    const tmp = `${dbPath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, Buffer.from(data))
    fs.renameSync(tmp, dbPath)
  } finally {
    db.close()
  }
}
