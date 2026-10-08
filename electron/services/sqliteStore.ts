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

/** 递归收集 JSON 对象中的所有键名（用于精确键匹配，H1） */
function collectKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k)
      collectKeys(v, acc)
    }
  }
  return acc
}

/**
 * 自适应探测（H1 收紧）：遍历表中所有行，仅当该行 value 为 JSON 对象，
 * 且其真实键名「精确」同时命中 keyFeatures（apiKey 特征）与 urlFeatures（baseUrl 特征）时，
 * 才视为凭证行——不再用序列化子串宽泛匹配，避免 baseurl/apikey 子串误命中无关行。
 * 返回全部命中行；命中多行时由调用方决定是否报错让用户手选，本函数不默认取首个。
 */
export async function probeItem(
  dbPath: string,
  table: string,
  keyCol: string,
  valCol: string,
  keyFeatures: string[],
  urlFeatures: string[]
): Promise<SqliteRow[]> {
  if (!fs.existsSync(dbPath) || keyFeatures.length === 0 || urlFeatures.length === 0) return []
  const db = await openDb(dbPath)
  try {
    const res = db.exec(`SELECT ${keyCol} AS k, ${valCol} AS v FROM ${table}`)
    if (!res || res.length === 0) return []
    const rows: any[][] = res[0].values
    const matched: SqliteRow[] = []
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
      const keys = collectKeys(parsed)
      const hasKey = keyFeatures.some((f) => keys.has(f))
      const hasUrl = urlFeatures.some((f) => keys.has(f))
      if (hasKey && hasUrl) {
        matched.push({ rowKey: String(k), valueText: text, isBlob: v instanceof Uint8Array })
      }
    }
    return matched
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
  const tmp = `${dbPath}.tmp-${process.pid}`
  try {
    const bindVal = isBlob ? new Uint8Array(Buffer.from(valueText, 'utf8')) : valueText
    db.run(
      `INSERT OR REPLACE INTO ${table} (${keyCol}, ${valCol}) VALUES (?, ?)`,
      [rowKey, bindVal]
    )
    const data: Uint8Array = db.export()
    fs.writeFileSync(tmp, Buffer.from(data))
    fs.renameSync(tmp, dbPath)
    // H3：整库重写主库后删除残留的 -wal/-shm，避免 IDE 重开时回放旧 WAL 造成不一致或损坏
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.rmSync(`${dbPath}${suffix}`, { force: true })
      } catch {
        // 附属文件删除失败不影响主库写入结果
      }
    }
  } finally {
    db.close()
    // L1：失败时清理遗留临时文件（成功 rename 后 tmp 已不存在，此为空操作）
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
    } catch {
      // 清理失败忽略
    }
  }
}

// 说明：恢复默认走 writeItem 写回“清除对应字段后的行 JSON”（而非删整行），
// 因为凭证行往往同时承载 IDE 自己的其它字段；历史上曾提供 deleteItem（删整行），
// 因无任何调用方且语义危于丢字段，已移除。
