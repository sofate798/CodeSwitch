import fs from 'node:fs'
import { IDE_REGISTRY, resolvePath } from '../adapters/registry'
import { store } from './store'
import { backupFile, readJsonSafe, writeJsonAtomic, restoreBackup } from './backup'
import { providerValues, applyFieldsToConfig, setPath, getPath, unsetPath } from './provider'
import { readItem, probeItem, writeItem, type SqliteRow } from './sqliteStore'
import { tryDecryptSecret, encryptSecret } from './secureValue'
import { readToml, writeTomlAtomic, ensureTable, removeTable } from './tomlStore'
import { readEnv, writeEnvAtomic, removeEnvKeys } from './envStore'
import { isIdeRunning } from './processGuard'
import { KeyUnavailableError } from './crypto'
import { log } from './logger'
import type {
  IDEAdapterDef,
  IDEState,
  Provider,
  IDEStatus,
  IDECapability,
  StorageSpec,
  FieldMap,
  OpResult
} from '../shared/types'

type SqliteSpec = Extract<StorageSpec, { kind: 'sqlite' }>
type TomlSpec = Extract<StorageSpec, { kind: 'toml' }>
type EnvSpec = Extract<StorageSpec, { kind: 'env' }>
type JsonSpec = Extract<StorageSpec, { kind: 'json' }>

/** 某策略下的候选目标路径（已展开环境变量）；M9：未解析占位符的路径为 null，被过滤掉 */
function candidatePaths(ide: IDEAdapterDef): string[] {
  const s = ide.storage
  const raw = s.kind === 'sqlite' ? s.dbPaths : s.paths
  return raw.map(resolvePath).filter((p): p is string => Boolean(p))
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

/** sqlite 行定位结果：ambiguous=true 表示探测命中多行，需用户手选（H1） */
interface LocateResult {
  row: SqliteRow | null
  ambiguous: boolean
}

/**
 * H1：从存储规格推导探测特征——精确 JSON 键匹配需同时命中 key + baseUrl 特征。
 * 主特征取自 valueFields / anthropicValueFields 的字段末段；probeContains 里含 url 的作为
 * baseUrl 补充特征、含 key 的作为 apiKey 补充特征（覆盖 api_key/base_url 等 snake_case 变体）。
 */
function probeFeatures(s: SqliteSpec): { keyFeatures: string[]; urlFeatures: string[] } {
  const keySet = new Set<string>()
  const urlSet = new Set<string>()
  const lastSeg = (p?: string | null): string | null => (p ? p.split('.').pop() ?? null : null)
  const ak = lastSeg(s.valueFields.apiKey)
  if (ak) keySet.add(ak)
  const ak2 = lastSeg(s.anthropicValueFields?.apiKey)
  if (ak2) keySet.add(ak2)
  const bu = lastSeg(s.valueFields.baseUrl)
  if (bu) urlSet.add(bu)
  const bu2 = lastSeg(s.anthropicValueFields?.baseUrl)
  if (bu2) urlSet.add(bu2)
  for (const c of s.probeContains ?? []) {
    const lc = c.toLowerCase()
    if (lc.includes('url')) urlSet.add(c)
    else if (lc.includes('key')) keySet.add(c)
  }
  return { keyFeatures: [...keySet], urlFeatures: [...urlSet] }
}

/** sqlite 定位凭证行：优先已知 rowKey（精确读），否则自适应探测（H1：命中多行标记 ambiguous） */
async function locateSqliteRow(dbPath: string, s: SqliteSpec, hintRowKey?: string): Promise<LocateResult> {
  const key = hintRowKey ?? s.rowKey
  if (key) {
    const row = await readItem(dbPath, s.table, s.keyColumn, s.valueColumn, key)
    if (row) return { row, ambiguous: false }
  }
  const { keyFeatures, urlFeatures } = probeFeatures(s)
  if (keyFeatures.length && urlFeatures.length) {
    const matches = await probeItem(dbPath, s.table, s.keyColumn, s.valueColumn, keyFeatures, urlFeatures)
    if (matches.length > 0) return { row: matches[0], ambiguous: matches.length > 1 }
  }
  return { row: null, ambiguous: false }
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
      const { row } = await locateSqliteRow(path, s)
      if (!row?.valueText) return 'default'
      // M8：区分「值非 JSON 但有效」与「解析失败」——非 JSON 的密文/字符串凭证属正常，
      // 有值即视为已自定义，不再误报为 error（配置异常）。
      try {
        const obj = JSON.parse(row.valueText)
        return s.valueFields.apiKey && getPath(obj, s.valueFields.apiKey) ? 'customized' : 'default'
      } catch {
        return 'customized'
      }
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
    let noteKey: string | undefined = ide.noteKey
    let running: boolean | undefined

    if (installed) {
      running = await isIdeRunning(ide.processNames)
      const probe = currentProviderId ? 'customized' : await detectCustomized(ide, existing)
      if (probe === 'error') {
        status = 'error'
        noteKey = 'ide.note.parseError'
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
      noteKey,
      protocols: ide.protocols,
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

export async function applyProvider(ideId: string, providerId: string): Promise<OpResult> {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  const provider: Provider | undefined = store.get('providers').find((p) => p.id === providerId)
  if (!ide) return { ok: false, code: 'msg.ide.notFound' }
  if (!provider) return { ok: false, code: 'msg.provider.notFound' }

  const cap = computeCapability(ide)
  if (cap === 'manual' || cap === 'assist') return { ok: false, code: 'msg.ide.notWritable' }
  if (!ide.protocols.includes(provider.protocol)) {
    return { ok: false, code: 'msg.ide.incompatibleProtocol', args: { ide: ide.name, protocol: provider.protocol } }
  }

  // M4：整库/整文件回写前统一检测 IDE 是否运行（含 json/env，此前仅 sqlite/toml）
  if (await isIdeRunning(ide.processNames)) {
    return { ok: false, code: 'msg.ide.needClose', args: { name: ide.name } }
  }

  const target = targetForWrite(ide)
  if (!target) return { ok: false, code: 'msg.ide.notFound' }

  const s = ide.storage
  try {
    if (s.kind === 'json') return applyJson(ide, provider, s, target)
    if (s.kind === 'sqlite') return await applySqlite(ide, provider, s, target)
    if (s.kind === 'toml') return applyToml(ide, provider, s, target)
    return applyEnv(ide, provider, s, target)
  } catch (e) {
    // decrypt 抛 KeyUnavailableError（B2 契约）-> 密钥不可用；其余写入异常 -> 配置无效
    if (e instanceof KeyUnavailableError) return { ok: false, code: 'msg.provider.keyUnavailable' }
    return { ok: false, code: 'msg.ide.configInvalid' }
  }
}

function applyJson(ide: IDEAdapterDef, provider: Provider, s: JsonSpec, target: string): OpResult {
  const { data, error } = readJsonSafe(target)
  if (error && error !== 'not_found') return { ok: false, code: 'msg.ide.configInvalid' }
  const bk = backupFile(ide.id, target, `apply:${provider.name}`)
  try {
    const cfg = applyFieldsToConfig(provider, s.fields, data ?? {}, ide.id)
    writeJsonAtomic(target, cfg)
    bind(ide.id, provider.id, target)
    log('info', 'apply', `${ide.id} <- ${provider.name} (${provider.protocol}, json)`)
    return { ok: true, code: 'msg.ide.applyDone', args: { name: ide.name } }
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

async function applySqlite(ide: IDEAdapterDef, provider: Provider, s: SqliteSpec, dbPath: string): Promise<OpResult> {
  const vals = providerValues(provider, ide.id)
  // C2：Anthropic 协议优先用 anthropicValueFields（Cursor 已补齐 apiKey+baseUrl+model）
  const fields: FieldMap = provider.protocol === 'anthropic' && s.anthropicValueFields ? s.anthropicValueFields : s.valueFields

  // 先探测定位（写入前需知道 rowKey 与原值类型/加密形态）
  const loc: LocateResult = fs.existsSync(dbPath) ? await locateSqliteRow(dbPath, s) : { row: null, ambiguous: false }
  // H1：命中多行无法安全定位，返回 rowAmbiguous 让用户手选，绝不默认写首个
  if (loc.ambiguous) return { ok: false, code: 'msg.ide.rowAmbiguous' }
  const existingRow = loc.row
  const rowKey = existingRow?.rowKey ?? s.rowKey
  if (!rowKey) return { ok: false, code: 'msg.ide.notFound' }

  // H2：原行 JSON.parse 失败则中止并返回 parseError，绝不静默置 {} 覆盖整行导致其它字段丢失
  let obj: any = {}
  if (existingRow?.valueText) {
    try {
      obj = JSON.parse(existingRow.valueText)
    } catch {
      return { ok: false, code: 'msg.ide.parseError' }
    }
  }

  const bk = backupFile(ide.id, dbPath, `apply:${provider.name}`, [`${dbPath}-wal`, `${dbPath}-shm`])
  try {
    // apiKey 落盘：原值是 DPAPI 密文则镜像加密；首次写入（无原值可镜像）且声明 encryptSecret 时默认加密（Alex-M3）
    if (fields.apiKey) {
      const original = getPath(obj, fields.apiKey)
      const dec = tryDecryptSecret(original)
      const hadOriginal = original != null && original !== ''
      const shouldEncrypt = s.encryptSecret !== false && (dec.encrypted || !hadOriginal)
      setPath(obj, fields.apiKey, encryptSecret(vals.apiKey, shouldEncrypt))
    }
    if (fields.baseUrl) setPath(obj, fields.baseUrl, vals.baseUrl)
    if (fields.model) setPath(obj, fields.model, vals.model)

    await writeItem(dbPath, s.table, s.keyColumn, s.valueColumn, rowKey, JSON.stringify(obj), existingRow?.isBlob ?? false)
    bind(ide.id, provider.id, dbPath, rowKey)
    log('info', 'apply', `${ide.id} <- ${provider.name} (${provider.protocol}, sqlite:${rowKey})`)
    return { ok: true, code: 'msg.ide.applyNeedRestart' }
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

function subToken(v: string | number | boolean, vals: { apiKey: string; baseUrl: string; model: string }) {
  if (typeof v !== 'string') return v
  return v.replace(/\$\{model\}/g, vals.model).replace(/\$\{baseUrl\}/g, vals.baseUrl).replace(/\$\{apiKey\}/g, vals.apiKey)
}

function applyToml(ide: IDEAdapterDef, provider: Provider, s: TomlSpec, target: string): OpResult {
  const vals = providerValues(provider, ide.id)
  const bk = backupFile(ide.id, target, `apply:${provider.name}`)
  try {
    const doc = readToml(target)
    if (s.scalars) for (const [k, v] of Object.entries(s.scalars)) doc[k] = subToken(v, vals)
    if (s.table && s.tableValues) {
      const t = ensureTable(doc, s.table)
      for (const [k, v] of Object.entries(s.tableValues)) t[k] = subToken(v, vals)
    }
    // M5：维持整体重写（依赖上面的自动备份兜底），取舍详见 tomlStore.ts 头部注释
    writeTomlAtomic(target, doc)
    // 密钥单独落到 auth.json（如 Codex）
    if (s.secretFile) {
      const sp = resolvePath(s.secretFile.path)
      if (sp) {
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
    }
    bind(ide.id, provider.id, target)
    log('info', 'apply', `${ide.id} <- ${provider.name} (${provider.protocol}, toml)`)
    return { ok: true, code: 'msg.ide.applyNeedRestart' }
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

function applyEnv(ide: IDEAdapterDef, provider: Provider, s: EnvSpec, target: string): OpResult {
  const vals = providerValues(provider, ide.id)
  const bk = backupFile(ide.id, target, `apply:${provider.name}`)
  try {
    const updates: Record<string, string> = {}
    if (s.mapping.apiKey) updates[s.mapping.apiKey] = vals.apiKey
    if (s.mapping.baseUrl) updates[s.mapping.baseUrl] = vals.baseUrl
    if (s.mapping.model) updates[s.mapping.model] = vals.model
    writeEnvAtomic(target, updates)
    bind(ide.id, provider.id, target)
    log('info', 'apply', `${ide.id} <- ${provider.name} (${provider.protocol}, env)`)
    return { ok: true, code: 'msg.ide.applyDone', args: { name: ide.name } }
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

// ---------------- 恢复默认（按策略分派） ----------------

export async function resetIDE(ideId: string): Promise<OpResult> {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  if (!ide) return { ok: false, code: 'msg.ide.notFound' }

  const cap = computeCapability(ide)
  // 手动/辅助配置型无需恢复：ok=true 且 canceled=true 表示「已跳过、未实际改动」
  if (cap === 'manual' || cap === 'assist') {
    return { ok: true, canceled: true, code: 'msg.ide.notWritable' }
  }

  // M4：整库/整文件回写前统一检测 IDE 是否运行（含 json/env）
  if (await isIdeRunning(ide.processNames)) {
    return { ok: false, code: 'msg.ide.needClose', args: { name: ide.name } }
  }

  const target = locateExisting(ide)
  if (!target) return { ok: false, code: 'msg.ide.notFound' }

  const s = ide.storage
  try {
    if (s.kind === 'json') resetJson(ide, s, target)
    else if (s.kind === 'sqlite') await resetSqlite(ide, s, target)
    else if (s.kind === 'toml') resetToml(ide, s, target)
    else resetEnv(ide, s, target)
    unbind(ideId)
    log('info', 'reset', ideId)
    return { ok: true, code: 'msg.ide.resetDone', args: { name: ide.name } }
  } catch (e) {
    if (e instanceof KeyUnavailableError) return { ok: false, code: 'msg.provider.keyUnavailable' }
    return { ok: false, code: 'msg.ide.configInvalid' }
  }
}

/**
 * M6：清理历史上 applyFieldsToConfig 注入的 protocol 私有键。
 * 该键曾写在各字段父路径下（如 language_models.openai.protocol），恢复默认时一并移除，
 * 避免为此前用户残留孤儿键。字段为扁平键（无父路径）时为空操作，安全。
 */
function stripInjectedProtocol(obj: any, fields: FieldMap): void {
  const parents = new Set<string>()
  for (const p of [fields.apiKey, fields.baseUrl, fields.model]) {
    if (!p) continue
    const idx = p.lastIndexOf('.')
    if (idx > 0) parents.add(p.slice(0, idx))
  }
  for (const parent of parents) unsetPath(obj, `${parent}.protocol`)
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
    stripInjectedProtocol(cfg, s.fields) // M6
    writeJsonAtomic(target, cfg)
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

async function resetSqlite(ide: IDEAdapterDef, s: SqliteSpec, dbPath: string): Promise<void> {
  const hintRowKey = store.get('ideBindings')[ide.id]?.sqliteRowKey
  const loc = await locateSqliteRow(dbPath, s, hintRowKey)
  // H1：无绑定且命中多行时无法安全定位，跳过以免误删无关行
  if (loc.ambiguous && !hintRowKey) return
  const row = loc.row
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
      stripInjectedProtocol(obj, fm) // M6（sqlite 字段多为扁平键，通常为空操作，防御性清理）
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
    // M6：toml 策略从不注入 protocol 私有键（apply 仅写 scalars/table），故无需清理
    writeTomlAtomic(target, doc)
    if (s.secretFile) {
      const sp = resolvePath(s.secretFile.path)
      if (sp && fs.existsSync(sp)) {
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
    // M6：env 策略从不注入 protocol 私有键（仅按 mapping 增删），故无需清理
    const keys = [s.mapping.apiKey, s.mapping.baseUrl, s.mapping.model].filter(Boolean) as string[]
    removeEnvKeys(target, keys)
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

// ---------------- 生成配置（assist / 无法自动定位时的兜底） ----------------

export function generateConfig(ideId: string, providerId: string): OpResult<{ text: string; targetPath?: string }> {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  const provider: Provider | undefined = store.get('providers').find((p) => p.id === providerId)
  if (!ide) return { ok: false, code: 'msg.ide.notFound' }
  if (!provider) return { ok: false, code: 'msg.provider.notFound' }
  if (!ide.protocols.includes(provider.protocol)) {
    return { ok: false, code: 'msg.ide.incompatibleProtocol', args: { ide: ide.name, protocol: provider.protocol } }
  }

  let vals: { apiKey: string; baseUrl: string; model: string }
  try {
    vals = providerValues(provider, ide.id)
  } catch {
    return { ok: false, code: 'msg.provider.keyUnavailable' }
  }

  const s = ide.storage
  const targetPath = targetForWrite(ide) ?? undefined
  let text = ''

  if (s.kind === 'json') {
    text = JSON.stringify(applyFieldsToConfig(provider, s.fields, {}, ide.id), null, 2)
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
    text = `# ${resolvePath(s.paths[0]) ?? s.paths[0]}\n` + tomlPreview(doc)
    if (s.secretFile) {
      text += `\n\n# ${resolvePath(s.secretFile.path) ?? s.secretFile.path}\n{\n  "${s.secretFile.field}": "${vals.apiKey}"\n}`
    }
  } else {
    const lines: string[] = []
    if (s.mapping.apiKey) lines.push(`${s.mapping.apiKey}=${vals.apiKey}`)
    if (s.mapping.baseUrl) lines.push(`${s.mapping.baseUrl}=${vals.baseUrl}`)
    if (s.mapping.model) lines.push(`${s.mapping.model}=${vals.model}`)
    text = lines.join('\n')
  }

  if (!text.trim()) {
    // 无可写字段（凭证槽位无法定位的辅助型 IDE）：给出可复制的三要素摘要
    text = `API Key: ${vals.apiKey}\nBase URL: ${vals.baseUrl}\nModel: ${vals.model}`
  }
  return { ok: true, data: { text, targetPath } }
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
export function manualAdd(ideId: string, configPath: string): OpResult {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  if (!ide) return { ok: false, code: 'msg.ide.notFound' }
  if (!fs.existsSync(configPath)) return { ok: false, code: 'msg.ide.pathInvalid' }
  const bindings = store.get('ideBindings')
  bindings[ideId] = { providerId: bindings[ideId]?.providerId ?? null, configPath, sqliteRowKey: bindings[ideId]?.sqliteRowKey }
  store.set('ideBindings', bindings)
  log('info', 'manual-path', `${ideId} -> ${configPath}`)
  return { ok: true, code: 'msg.ide.manualAddOk' }
}

/** 供 UI 在打开应用弹窗前预判：目标 IDE 是否正在运行 */
export async function checkIdeRunning(ideId: string): Promise<boolean> {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  if (!ide) return false
  return await isIdeRunning(ide.processNames)
}
