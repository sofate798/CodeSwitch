import fs from 'node:fs'
import { IDE_REGISTRY, resolvePath } from '../adapters/registry'
import { store } from './store'
import { backupFile, readJsonSafe, writeJsonAtomic, restoreBackup } from './backup'
import { providerValues, applyFieldsToConfig, setPath, getPath, unsetPath } from './provider'
import { readItem, probeItem, writeItem } from './sqliteStore'
import { tryDecryptSecret, encryptSecret } from './secureValue'
import { readToml, writeTomlAtomic, ensureTable, removeTable } from './tomlStore'
import { readEnv, writeEnvAtomic, removeEnvKeys } from './envStore'
import { isIdeRunning } from './processGuard'
import { log } from './logger'
import type {
  IDEAdapterDef,
  IDEState,
  Provider,
  IDEStatus,
  IDECapability,
  StorageSpec,
  FieldMap
} from '../shared/types'

export interface ApplyResult {
  ok: boolean
  message: string
  needCloseIde?: boolean
}

type SqliteSpec = Extract<StorageSpec, { kind: 'sqlite' }>
type TomlSpec = Extract<StorageSpec, { kind: 'toml' }>
type EnvSpec = Extract<StorageSpec, { kind: 'env' }>
type JsonSpec = Extract<StorageSpec, { kind: 'json' }>

/** 某策略下的候选目标路径（已展开环境变量） */
function candidatePaths(ide: IDEAdapterDef): string[] {
  const s = ide.storage
  const raw = s.kind === 'sqlite' ? s.dbPaths : s.paths
  return raw.map(resolvePath).filter(Boolean)
}

/** 手动指定的路径优先 */
function manualPath(ideId: string): string | null {
  return store.get('ideBindings')[ideId]?.configPath ?? null
}

/** 已存在的目标路径（用于展示 / 状态判定），不存在返回 null */
function locateExisting(ide: IDEAdapterDef): string | null {
  const manual = manualPath(ide.id)
  if (manual && fs.existsSync(manual)) return manual
  for (const p of candidatePaths(ide)) if (fs.existsSync(p)) return p
  return null
}

/** 写入目标路径：手动 > 已存在 > 首个候选（用于新建） */
function targetForWrite(ide: IDEAdapterDef): string | null {
  const manual = manualPath(ide.id)
  if (manual) return manual
  for (const p of candidatePaths(ide)) if (fs.existsSync(p)) return p
  return candidatePaths(ide)[0] ?? null
}

function computeCapability(ide: IDEAdapterDef): IDECapability {
  if (ide.capability) return ide.capability
  if (ide.writable === false) return 'manual'
  return 'auto'
}

function isInstalled(ide: IDEAdapterDef): boolean {
  for (const tpl of ide.homeMarkers ?? []) {
    const p = resolvePath(tpl)
    if (p && fs.existsSync(p)) return true
  }
  for (const tpl of ide.detectPaths) {
    const p = resolvePath(tpl)
    if (p && fs.existsSync(p)) return true
  }
  return locateExisting(ide) !== null
}

/** sqlite 定位凭证行：优先已知 rowKey，否则自适应探测 */
async function locateSqliteRow(dbPath: string, s: SqliteSpec, hintRowKey?: string) {
  const key = hintRowKey ?? s.rowKey
  if (key) {
    const row = await readItem(dbPath, s.table, s.keyColumn, s.valueColumn, key)
    if (row) return row
  }
  if (s.probeContains?.length) {
    return await probeItem(dbPath, s.table, s.keyColumn, s.valueColumn, s.probeContains)
  }
  return null
}

/** 状态探测：判断目标 IDE 是否已被自定义（不依赖我们的绑定记录） */
async function detectCustomized(ide: IDEAdapterDef, path: string | null): Promise<'customized' | 'default' | 'error'> {
  const s = ide.storage
  try {
    if (!path || !fs.existsSync(path)) return 'default'
    if (s.kind === 'json') {
      const { data, error } = readJsonSafe(path)
      if (error) return 'error'
      return s.fields.apiKey && getPath(data, s.fields.apiKey) ? 'customized' : 'default'
    }
    if (s.kind === 'sqlite') {
      const row = await locateSqliteRow(path, s)
      if (!row?.valueText) return 'default'
      const obj = JSON.parse(row.valueText)
      return s.valueFields.apiKey && getPath(obj, s.valueFields.apiKey) ? 'customized' : 'default'
    }
    if (s.kind === 'toml') {
      const doc = readToml(path)
      return s.table && getPath(doc, s.table.join('.')) ? 'customized' : 'default'
    }
    if (s.kind === 'env') {
      const e = readEnv(path)
      return s.mapping.apiKey && e[s.mapping.apiKey] ? 'customized' : 'default'
    }
  } catch {
    return 'error'
  }
  return 'default'
}

/** 扫描全部 IDE，返回状态列表（含能力等级与运行状态） */
export async function scanIDEs(): Promise<IDEState[]> {
  const bindings = store.get('ideBindings')
  const result: IDEState[] = []

  for (const ide of IDE_REGISTRY) {
    const installed = isInstalled(ide)
    const existing = locateExisting(ide)
    const binding = bindings[ide.id]
    const capability = computeCapability(ide)

    let status: IDEStatus = 'missing'
    let currentProviderId: string | null = binding?.providerId ?? null
    let note: string | undefined = ide.note
    let running: boolean | undefined

    if (installed) {
      running = await isIdeRunning(ide.processNames)
      const probe = currentProviderId ? 'customized' : await detectCustomized(ide, existing)
      if (probe === 'error') {
        status = 'error'
        note = '配置解析失败，已保护原文件不做改动'
      } else {
        status = probe === 'customized' ? 'customized' : 'default'
      }
    }

    result.push({
      id: ide.id,
      name: ide.name,
      installed,
      status,
      configPath: existing,
      currentProviderId,
      lastBackup: store.get('backups').find((b) => b.ideId === ide.id)?.timestamp ?? null,
      note,
      capability,
      running
    })
  }
  return result
}

function bind(ideId: string, providerId: string, configPath: string, sqliteRowKey?: string): void {
  store.set(`ideBindings.${ideId}`, { providerId, configPath, sqliteRowKey })
}

function unbind(ideId: string): void {
  const bindings = store.get('ideBindings')
  delete bindings[ideId]
  store.set('ideBindings', bindings)
}

// ---------------- 应用（按策略分派） ----------------

export async function applyProvider(ideId: string, providerId: string): Promise<ApplyResult> {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  const provider: Provider | undefined = store.get('providers').find((p) => p.id === providerId)
  if (!ide) return { ok: false, message: '未知 IDE' }
  if (!provider) return { ok: false, message: '供应商不存在' }

  const cap = computeCapability(ide)
  if (cap === 'manual') return { ok: false, message: `${ide.name} 需手动配置：${ide.note ?? ''}` }
  if (cap === 'assist') return { ok: false, message: `${ide.name} 为辅助配置型，请用「生成配置」后手动粘贴` }
  if (!ide.protocols.includes(provider.protocol)) {
    return { ok: false, message: `${ide.name} 不支持 ${provider.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'} 协议` }
  }

  const s = ide.storage
  // 整库/整文件回写型：必须先关闭 IDE，避免其退出时覆盖或损坏
  if (s.kind === 'sqlite' || s.kind === 'toml') {
    if (await isIdeRunning(ide.processNames)) {
      return { ok: false, needCloseIde: true, message: `请先完全关闭 ${ide.name} 后再应用（其配置正被占用）` }
    }
  }

  const target = targetForWrite(ide)
  if (!target) return { ok: false, message: '未找到该 IDE 的配置文件，请先手动指定路径' }

  try {
    if (s.kind === 'json') return applyJson(ide, provider, s, target)
    if (s.kind === 'sqlite') return await applySqlite(ide, provider, s, target)
    if (s.kind === 'toml') return applyToml(ide, provider, s, target)
    return applyEnv(ide, provider, s, target)
  } catch (e) {
    return { ok: false, message: `写入失败: ${(e as Error).message}` }
  }
}

function applyJson(ide: IDEAdapterDef, provider: Provider, s: JsonSpec, target: string): ApplyResult {
  const bk = backupFile(ide.id, target, `apply:${provider.name}`)
  try {
    const { data, error } = readJsonSafe(target)
    if (error && error !== 'not_found') throw new Error(`配置文件损坏: ${error}`)
    const cfg = applyFieldsToConfig(provider, s.fields, data ?? {})
    writeJsonAtomic(target, cfg)
    bind(ide.id, provider.id, target)
    log('info', 'apply', `${ide.id} <- ${provider.name} (${provider.protocol}, json)`)
    return { ok: true, message: `已应用到 ${ide.name}，重启 IDE 后生效` }
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

async function applySqlite(ide: IDEAdapterDef, provider: Provider, s: SqliteSpec, dbPath: string): Promise<ApplyResult> {
  const vals = providerValues(provider)
  const fields: FieldMap = provider.protocol === 'anthropic' && s.anthropicValueFields ? s.anthropicValueFields : s.valueFields

  // 先探测定位（写入前需知道 rowKey 与原值类型/加密形态）
  const existingRow = fs.existsSync(dbPath) ? await locateSqliteRow(dbPath, s) : null
  const rowKey = existingRow?.rowKey ?? s.rowKey
  if (!rowKey) {
    return { ok: false, message: `未能在 ${ide.name} 数据库中定位凭证槽位，请改用「生成配置」手动设置` }
  }

  const bk = backupFile(ide.id, dbPath, `apply:${provider.name}`, [`${dbPath}-wal`, `${dbPath}-shm`])
  try {
    let obj: any = {}
    if (existingRow?.valueText) {
      try {
        obj = JSON.parse(existingRow.valueText)
      } catch {
        obj = {}
      }
    }
    // apiKey 镜像原字段加密形态：原值是 DPAPI 密文则重新加密，否则明文
    if (fields.apiKey) {
      const dec = tryDecryptSecret(getPath(obj, fields.apiKey))
      const mirror = dec.encrypted && s.encryptSecret !== false
      setPath(obj, fields.apiKey, encryptSecret(vals.apiKey, mirror))
    }
    if (fields.baseUrl) setPath(obj, fields.baseUrl, vals.baseUrl)
    if (fields.model) setPath(obj, fields.model, vals.model)

    await writeItem(dbPath, s.table, s.keyColumn, s.valueColumn, rowKey, JSON.stringify(obj), existingRow?.isBlob ?? false)
    bind(ide.id, provider.id, dbPath, rowKey)
    log('info', 'apply', `${ide.id} <- ${provider.name} (${provider.protocol}, sqlite:${rowKey})`)
    return { ok: true, message: `已应用到 ${ide.name}，重启 IDE 后生效` }
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

function subToken(v: string | number | boolean, vals: { apiKey: string; baseUrl: string; model: string }) {
  if (typeof v !== 'string') return v
  return v.replace(/\$\{model\}/g, vals.model).replace(/\$\{baseUrl\}/g, vals.baseUrl).replace(/\$\{apiKey\}/g, vals.apiKey)
}

function applyToml(ide: IDEAdapterDef, provider: Provider, s: TomlSpec, target: string): ApplyResult {
  const vals = providerValues(provider)
  const bk = backupFile(ide.id, target, `apply:${provider.name}`)
  try {
    const doc = readToml(target)
    if (s.scalars) for (const [k, v] of Object.entries(s.scalars)) doc[k] = subToken(v, vals)
    if (s.table && s.tableValues) {
      const t = ensureTable(doc, s.table)
      for (const [k, v] of Object.entries(s.tableValues)) t[k] = subToken(v, vals)
    }
    writeTomlAtomic(target, doc)
    // 密钥单独落到 auth.json（如 Codex）
    if (s.secretFile) {
      const sp = resolvePath(s.secretFile.path)
      const bk2 = backupFile(ide.id, sp, `apply:${provider.name}:secret`)
      try {
        const j = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : {}
        j[s.secretFile.field] = vals.apiKey
        writeJsonAtomic(sp, j)
      } catch (e) {
        if (bk2) restoreBackup(bk2.id)
        throw e
      }
    }
    bind(ide.id, provider.id, target)
    log('info', 'apply', `${ide.id} <- ${provider.name} (${provider.protocol}, toml)`)
    return { ok: true, message: `已应用到 ${ide.name}，重开终端 / IDE 后生效` }
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

function applyEnv(ide: IDEAdapterDef, provider: Provider, s: EnvSpec, target: string): ApplyResult {
  const vals = providerValues(provider)
  const bk = backupFile(ide.id, target, `apply:${provider.name}`)
  try {
    const updates: Record<string, string> = {}
    if (s.mapping.apiKey) updates[s.mapping.apiKey] = vals.apiKey
    if (s.mapping.baseUrl) updates[s.mapping.baseUrl] = vals.baseUrl
    if (s.mapping.model) updates[s.mapping.model] = vals.model
    writeEnvAtomic(target, updates)
    bind(ide.id, provider.id, target)
    log('info', 'apply', `${ide.id} <- ${provider.name} (${provider.protocol}, env)`)
    return { ok: true, message: `已应用到 ${ide.name}，重开终端后生效` }
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

// ---------------- 恢复默认（按策略分派） ----------------

export async function resetIDE(ideId: string): Promise<ApplyResult & { skipped?: boolean }> {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  if (!ide) return { ok: false, message: '未知 IDE' }

  const cap = computeCapability(ide)
  if (cap === 'manual' || cap === 'assist') {
    return { ok: true, skipped: true, message: `${ide.name} 为手动/辅助配置型，已跳过` }
  }

  const s = ide.storage
  if (s.kind === 'sqlite' || s.kind === 'toml') {
    if (await isIdeRunning(ide.processNames)) {
      return { ok: false, needCloseIde: true, message: `请先完全关闭 ${ide.name} 后再恢复（其配置正被占用）` }
    }
  }

  const target = locateExisting(ide)
  if (!target) return { ok: false, message: '未找到配置文件' }

  try {
    if (s.kind === 'json') resetJson(ide, s, target)
    else if (s.kind === 'sqlite') await resetSqlite(ide, s, target)
    else if (s.kind === 'toml') resetToml(ide, s, target)
    else resetEnv(ide, s, target)
    unbind(ideId)
    log('info', 'reset', ideId)
    return { ok: true, message: `${ide.name} 已恢复默认` }
  } catch (e) {
    return { ok: false, message: `恢复失败: ${(e as Error).message}` }
  }
}

function resetJson(ide: IDEAdapterDef, s: JsonSpec, target: string): void {
  const { data, error } = readJsonSafe(target)
  if (error && error !== 'not_found') throw new Error(`配置文件无法解析（${error}），已取消恢复以保护原文件`)
  const bk = backupFile(ide.id, target, 'reset')
  try {
    const cfg = data && typeof data === 'object' ? JSON.parse(JSON.stringify(data)) : {}
    if (s.fields.apiKey) unsetPath(cfg, s.fields.apiKey)
    if (s.fields.baseUrl) unsetPath(cfg, s.fields.baseUrl)
    if (s.fields.model) unsetPath(cfg, s.fields.model)
    writeJsonAtomic(target, cfg)
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

async function resetSqlite(ide: IDEAdapterDef, s: SqliteSpec, dbPath: string): Promise<void> {
  const hintRowKey = store.get('ideBindings')[ide.id]?.sqliteRowKey
  const row = await locateSqliteRow(dbPath, s, hintRowKey)
  if (!row?.valueText) return
  let obj: any
  try {
    obj = JSON.parse(row.valueText)
  } catch {
    return // 非 JSON 值不动，避免破坏
  }
  const bk = backupFile(ide.id, dbPath, 'reset', [`${dbPath}-wal`, `${dbPath}-shm`])
  try {
    const clear = (fm: FieldMap) => {
      if (fm.apiKey) unsetPath(obj, fm.apiKey)
      if (fm.baseUrl) unsetPath(obj, fm.baseUrl)
      if (fm.model) unsetPath(obj, fm.model)
    }
    clear(s.valueFields)
    if (s.anthropicValueFields) clear(s.anthropicValueFields)
    await writeItem(dbPath, s.table, s.keyColumn, s.valueColumn, row.rowKey, JSON.stringify(obj), row.isBlob)
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

function resetToml(ide: IDEAdapterDef, s: TomlSpec, target: string): void {
  const bk = backupFile(ide.id, target, 'reset')
  try {
    const doc = readToml(target)
    if (s.table) removeTable(doc, s.table)
    // 仅当我们设置的 provider 名生效时才移除顶层标量，避免破坏用户自有配置
    if (s.scalars) {
      for (const k of Object.keys(s.scalars)) {
        if (k === 'model_provider' && doc[k] === 'codeswitch') delete doc[k]
      }
    }
    writeTomlAtomic(target, doc)
    if (s.secretFile) {
      const sp = resolvePath(s.secretFile.path)
      if (fs.existsSync(sp)) {
        const bk2 = backupFile(ide.id, sp, 'reset:secret')
        try {
          const j = JSON.parse(fs.readFileSync(sp, 'utf8'))
          delete j[s.secretFile.field]
          writeJsonAtomic(sp, j)
        } catch (e) {
          if (bk2) restoreBackup(bk2.id)
          throw e
        }
      }
    }
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

function resetEnv(ide: IDEAdapterDef, s: EnvSpec, target: string): void {
  const bk = backupFile(ide.id, target, 'reset')
  try {
    const keys = [s.mapping.apiKey, s.mapping.baseUrl, s.mapping.model].filter(Boolean) as string[]
    removeEnvKeys(target, keys)
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

// ---------------- 生成配置（assist / 无法自动定位时的兜底） ----------------

export function generateConfig(ideId: string, providerId: string): { ok: boolean; message: string; text?: string; targetPath?: string } {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  const provider: Provider | undefined = store.get('providers').find((p) => p.id === providerId)
  if (!ide) return { ok: false, message: '未知 IDE' }
  if (!provider) return { ok: false, message: '供应商不存在' }
  if (!ide.protocols.includes(provider.protocol)) {
    return { ok: false, message: `${ide.name} 不支持 ${provider.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'} 协议` }
  }

  const vals = providerValues(provider)
  const s = ide.storage
  const targetPath = targetForWrite(ide) ?? undefined
  let text = ''

  if (s.kind === 'json') {
    text = JSON.stringify(applyFieldsToConfig(provider, s.fields, {}), null, 2)
  } else if (s.kind === 'sqlite') {
    const fields = provider.protocol === 'anthropic' && s.anthropicValueFields ? s.anthropicValueFields : s.valueFields
    const obj: any = {}
    if (fields.apiKey) setPath(obj, fields.apiKey, vals.apiKey)
    if (fields.baseUrl) setPath(obj, fields.baseUrl, vals.baseUrl)
    if (fields.model) setPath(obj, fields.model, vals.model)
    text = JSON.stringify(obj, null, 2)
  } else if (s.kind === 'toml') {
    const doc: Record<string, any> = {}
    if (s.scalars) for (const [k, v] of Object.entries(s.scalars)) doc[k] = subToken(v, vals)
    if (s.table && s.tableValues) {
      const t = ensureTable(doc, s.table)
      for (const [k, v] of Object.entries(s.tableValues)) t[k] = subToken(v, vals)
    }
    text = `# ${resolvePath(s.paths[0])}\n` + tomlPreview(doc)
    if (s.secretFile) text += `\n\n# ${resolvePath(s.secretFile.path)}\n{\n  "${s.secretFile.field}": "${vals.apiKey}"\n}`
  } else {
    const lines: string[] = []
    if (s.mapping.apiKey) lines.push(`${s.mapping.apiKey}=${vals.apiKey}`)
    if (s.mapping.baseUrl) lines.push(`${s.mapping.baseUrl}=${vals.baseUrl}`)
    if (s.mapping.model) lines.push(`${s.mapping.model}=${vals.model}`)
    text = lines.join('\n')
  }

  if (!text.trim()) {
    // 无可写字段（如 Copilot BYOK）：给出可复制的三要素摘要
    text = `API Key: ${vals.apiKey}\nBase URL: ${vals.baseUrl}\nModel: ${vals.model}`
  }
  return { ok: true, message: '已生成配置，可复制后手动粘贴', text, targetPath }
}

/** 极简 TOML 预览（仅用于生成配置的展示，不落盘） */
function tomlPreview(doc: Record<string, any>): string {
  const lines: string[] = []
  const scalars = Object.entries(doc).filter(([, v]) => typeof v !== 'object')
  const tables = Object.entries(doc).filter(([, v]) => v && typeof v === 'object')
  for (const [k, v] of scalars) lines.push(`${k} = ${JSON.stringify(v)}`)
  for (const [k, v] of tables) {
    lines.push(`\n[${k}]`)
    for (const [kk, vv] of Object.entries(v as Record<string, any>)) lines.push(`${kk} = ${JSON.stringify(vv)}`)
  }
  return lines.join('\n')
}

/** 手动指定 IDE 配置文件路径（保留已应用的供应商绑定） */
export function manualAdd(ideId: string, configPath: string): { ok: boolean; message: string } {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  if (!ide) return { ok: false, message: '未知 IDE' }
  if (!fs.existsSync(configPath)) return { ok: false, message: '文件不存在' }
  const bindings = store.get('ideBindings')
  bindings[ideId] = { providerId: bindings[ideId]?.providerId ?? null, configPath, sqliteRowKey: bindings[ideId]?.sqliteRowKey }
  store.set('ideBindings', bindings)
  log('info', 'manual-path', `${ideId} -> ${configPath}`)
  return { ok: true, message: '路径已保存' }
}

/** 供 UI 在打开应用弹窗前预判：目标 IDE 是否正在运行 */
export async function checkIdeRunning(ideId: string): Promise<boolean> {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  if (!ide) return false
  return await isIdeRunning(ide.processNames)
}
