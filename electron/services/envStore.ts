import fs from 'node:fs'
import path from 'node:path'

/**
 * KEY=VALUE 环境变量文件读写（如 Gemini CLI ~/.gemini/.env）。
 * 增量修改：只更新/追加指定键，保留其它行与注释。
 */

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

export function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(LINE_RE)
    if (!m) continue
    out[m[1]] = stripQuotes(m[2])
  }
  return out
}

function stripQuotes(v: string): string {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

/** 写入/更新若干键（值为空字符串则跳过），保留文件中其它内容 */
export function writeEnvAtomic(file: string, updates: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const lines = original.split(/\r?\n/)
  const seen = new Set<string>()
  const next = lines.map((line) => {
    const m = line.match(LINE_RE)
    if (!m) return line
    const key = m[1]
    if (Object.prototype.hasOwnProperty.call(updates, key) && updates[key] !== '') {
      seen.add(key)
      return `${key}=${updates[key]}`
    }
    return line
  })
  // 追加尚未出现的新键
  for (const [key, val] of Object.entries(updates)) {
    if (val === '' || seen.has(key)) continue
    next.push(`${key}=${val}`)
  }
  let text = next.join('\n')
  if (!text.endsWith('\n')) text += '\n'
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/** 删除若干键所在行（恢复默认时用） */
export function removeEnvKeys(file: string, keys: string[]): void {
  if (!fs.existsSync(file) || keys.length === 0) return
  const keySet = new Set(keys)
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => {
    const m = line.match(LINE_RE)
    return !(m && keySet.has(m[1]))
  })
  let text = lines.join('\n')
  if (text && !text.endsWith('\n')) text += '\n'
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}
