import fs from 'node:fs'
import { IDE_REGISTRY, resolvePath } from '../adapters/registry'
import { store } from './store'
import { backupFile, readJsonSafe, writeJsonAtomic, restoreBackup, parseJsonc } from './backup'
import { providerValues, applyFieldsToConfig, setPath, getPath, unsetPath } from './provider'
import { readItem, probeItem, writeItem, type SqliteRow } from './sqliteStore'
import { readToml, writeTomlAtomic, ensureTable, removeTable, tomlToText } from './tomlStore'
import { readEnv, writeEnvAtomic, removeEnvKeys } from './envStore'
import { isIdeRunning } from './processGuard'
import { KeyUnavailableError, decrypt } from './crypto'
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

/**
 * assist 型生成片段落点：恢复默认时清除；状态探测时若命中也视为已自定义。
 * （Zed 新流程写 openai_compatible.codeswitch，旧 fields 只覆盖早期直写的 openai.*）
 */
const ASSIST_CLEAR_PATHS: Record<string, string[]> = {
  zed: ['language_models.openai_compatible.codeswitch']
}

/** 状态探测：判断目标 IDE 是否已被自定义（不依赖我们的绑定记录） */
async function detectCustomized(ide: IDEAdapterDef, path: string | null): Promise<'customized' | 'default' | 'error'> {
  const s = ide.storage
  try {
    if (!path || !fs.existsSync(path)) return 'default'
    if (s.kind === 'json') {
      const { data, error } = readJsonSafe(path)
      if (error) return 'error'
      if (s.fields.apiKey && getPath(data, s.fields.apiKey)) return 'customized'
      for (const p of ASSIST_CLEAR_PATHS[ide.id] ?? []) {
        if (getPath(data, p) !== undefined) return 'customized'
      }
      return 'default'
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
      // assist 型 sqlite（Cursor）从不由本应用写入，不值得每次扫描都把整库读进 sql.js：
      // 实测 Cursor 的 state.vscdb 约 300MB，WASM 内存增长后不会归还，主进程会常驻数百 MB
      const skipProbe = capability === 'assist' && ide.storage.kind === 'sqlite'
      const probe = currentProviderId ? 'customized' : skipProbe ? 'default' : await detectCustomized(ide, existing)
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

/** 只解除供应商引用：configPath 可能是用户手动指定的路径，恢复默认后不能丢 */
function unbind(ideId: string): void {
  const bindings = store.get('ideBindings')
  if (!bindings[ideId]) return
  bindings[ideId] = { ...bindings[ideId], providerId: null }
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

  // M4：整库/整文件回写前统一检测 IDE 是否运行（含 json/env，此前仅 sqlite/toml）。
  // 写入拦截走 fresh 模式（绕过进程快照缓存），不允许任何陈旧窗口。
  if (await isIdeRunning(ide.processNames, true)) {
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
  // 上次写入已定位过的行键优先（与恢复默认同口径），否则多候选行的库每次应用都会卡在 rowAmbiguous
  const prev = store.get('ideBindings')[ide.id]
  const hintRowKey = prev?.configPath === dbPath ? prev.sqliteRowKey : undefined
  const loc: LocateResult = fs.existsSync(dbPath) ? await locateSqliteRow(dbPath, s, hintRowKey) : { row: null, ambiguous: false }
  // H1：命中多行无法安全定位，返回 rowAmbiguous 让用户手选，绝不默认写首个
  if (loc.ambiguous) return { ok: false, code: 'msg.ide.rowAmbiguous' }
  const existingRow = loc.row
  const rowKey = existingRow?.rowKey ?? s.rowKey
  // 已安装、库也在，只是探测不到凭证行（多为从未在 IDE 内配置过自定义模型）：不能复用 notFound，
  // 否则界面说“未找到该 IDE”，快照应用还会把它当未安装静默跳过
  if (!rowKey) return { ok: false, code: 'msg.ide.slotNotFound', args: { name: ide.name } }

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
    // 必须写明文：Electron safeStorage 在 Windows 产出 v10 密文，密钥存于本应用私有的 Local State，目标 IDE 无法解密
    if (fields.apiKey) setPath(obj, fields.apiKey, vals.apiKey)
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

function boundProvider(ideId: string): Provider | undefined {
  const pid = store.get('ideBindings')[ideId]?.providerId
  return pid ? store.get('providers').find((p) => p.id === pid) : undefined
}

/**
 * 旧版写进 legacySecretFile 的 Key：仅当其值仍等于当前绑定供应商的 Key（可确认是本应用写的）时，
 * 返回置空后的文档供调用方回写；用户自己的凭证、无法解密或文件不可解析时一律不动（返回 null）。
 * 置 null 而非删键：与 Codex 自身写出的 auth.json 形态一致。
 */
function legacySecretCleanup(ideId: string, s: TomlSpec): { path: string; doc: Record<string, unknown> } | null {
  if (!s.legacySecretFile) return null
  const sp = resolvePath(s.legacySecretFile.path)
  const bp = boundProvider(ideId)
  if (!sp || !bp || !fs.existsSync(sp)) return null
  try {
    const key = decrypt(bp.apiKey).trim()
    const raw = fs.readFileSync(sp, 'utf8')
    const doc = raw.trim() ? parseJsonc(raw) : null
    const field = s.legacySecretFile.field
    if (!key || !doc || typeof doc !== 'object' || typeof doc[field] !== 'string' || doc[field].trim() !== key) return null
    doc[field] = null
    return { path: sp, doc }
  } catch {
    return null
  }
}

function applyToml(ide: IDEAdapterDef, provider: Provider, s: TomlSpec, target: string): OpResult {
  const vals = providerValues(provider, ide.id)
  // 须在 bind() 改写绑定前取：比对的是上一个绑定供应商的 Key
  const legacy = legacySecretCleanup(ide.id, s)
  const bk = backupFile(ide.id, target, `apply:${provider.name}`)
  try {
    const doc = readToml(target)
    if (s.scalars) for (const [k, v] of Object.entries(s.scalars)) doc[k] = subToken(v, vals)
    if (s.table && s.tableValues) {
      // 表段由本应用独占：整段替换，旧版写入的 env_key / wire_api="chat" 等已失效的键不能残留
      removeTable(doc, s.table)
      const t = ensureTable(doc, s.table)
      for (const [k, v] of Object.entries(s.tableValues)) t[k] = subToken(v, vals)
    }
    // M5：维持整体重写（依赖上面的自动备份兜底），取舍详见 tomlStore.ts 头部注释
    writeTomlAtomic(target, doc)
    if (legacy) writeLegacySecret(ide.id, legacy, `apply:${provider.name}:secret`)
    bind(ide.id, provider.id, target)
    log('info', 'apply', `${ide.id} <- ${provider.name} (${provider.protocol}, toml)`)
    return { ok: true, code: 'msg.ide.applyNeedRestart' }
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

function writeLegacySecret(ideId: string, legacy: { path: string; doc: Record<string, unknown> }, reason: string): void {
  const bk = backupFile(ideId, legacy.path, reason)
  try {
    writeJsonAtomic(legacy.path, legacy.doc)
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
  // 手动配置型无需恢复：ok=true 且 canceled=true 表示「已跳过、未实际改动」。
  // assist 型（Zed / Cursor）早期版本直写过字段（含明文 Key），恢复默认仍需能清掉这些残留；
  // 各 reset* 在找不到这些字段时不备份也不重写，对从未写过的目标是无操作。
  if (cap === 'manual') {
    return { ok: true, canceled: true, code: 'msg.ide.notWritable' }
  }

  // M4：整库/整文件回写前统一检测 IDE 是否运行（含 json/env）；同为写入拦截，走 fresh 模式
  if (await isIdeRunning(ide.processNames, true)) {
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
 * M6：按字段映射清除值 + 清理历史上 applyFieldsToConfig 注入的 protocol 私有键。
 * 返回是否真的删过东西：调用方据此决定是否备份 + 回写，避免“恢复默认”对未碰过的
 * 用户文件做无意义的重写（JSON 重排缩进 / TOML 丢失注释 / 备份列表塞满无效条目）。
 */
function clearFields(obj: any, fields: FieldMap): boolean {
  let changed = false
  const paths = [fields.apiKey, fields.baseUrl, fields.model]
  for (const p of paths) {
    if (p && getPath(obj, p) !== undefined) {
      unsetPath(obj, p)
      changed = true
    }
  }
  // 该键曾写在各字段父路径下（如 language_models.openai.protocol），恢复默认时一并移除
  const parents = new Set<string>()
  for (const p of paths) {
    if (!p) continue
    const idx = p.lastIndexOf('.')
    if (idx > 0) parents.add(p.slice(0, idx))
  }
  for (const parent of parents) {
    if (getPath(obj, `${parent}.protocol`) !== undefined) {
      unsetPath(obj, `${parent}.protocol`)
      changed = true
    }
  }
  return changed
}

function resetJson(ide: IDEAdapterDef, s: JsonSpec, target: string): void {
  const { data, error } = readJsonSafe(target)
  if (error && error !== 'not_found') throw new Error(`配置文件无法解析（${error}），已取消恢复以保护原文件`)
  const cfg = data && typeof data === 'object' ? JSON.parse(JSON.stringify(data)) : {}
  // 先在副本上试清：旧版直写字段 + assist 生成片段落点都没命中 → 本应用从未写过，不备份也不重写
  let changed = clearFields(cfg, s.fields)
  for (const p of ASSIST_CLEAR_PATHS[ide.id] ?? []) {
    if (getPath(cfg, p) !== undefined) {
      unsetPath(cfg, p)
      changed = true
    }
  }
  if (!changed) return
  const bk = backupFile(ide.id, target, 'reset')
  try {
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
  let changed = clearFields(obj, s.valueFields)
  if (s.anthropicValueFields) changed = clearFields(obj, s.anthropicValueFields) || changed
  // 行内并无本应用写入的字段：既不写回磁盘，也不留一条无意义的备份
  if (!changed) return
  const bk = backupFile(ide.id, dbPath, 'reset', [`${dbPath}-wal`, `${dbPath}-shm`])
  try {
    await writeItem(dbPath, s.table, s.keyColumn, s.valueColumn, row.rowKey, JSON.stringify(obj), row.isBlob)
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

function resetToml(ide: IDEAdapterDef, s: TomlSpec, target: string): void {
  // TOML 整体重写会丢用户注释，所以“没得可清”时必须原文件不动：先在解析副本上算完变更，
  // 确认确有本应用写入的表段/标量才备份 + 回写。
  const doc = readToml(target)
  let changed = s.table ? removeTable(doc, s.table) : false
  // 仅当我们设置的 provider 名生效时才移除顶层标量，避免破坏用户自有配置
  if (s.scalars && 'model_provider' in s.scalars && doc.model_provider === 'codeswitch') {
    delete doc.model_provider
    changed = true
    // 顶层 model 是应用时一并改写的：仍等于所绑供应商的模型才移除（交还 Codex 默认模型），
    // 否则切回官方 provider 后会带着第三方模型名请求而报错；用户之后改过的值不动
    const bp = boundProvider(ide.id)
    if ('model' in s.scalars && bp && doc.model === bp.model) delete doc.model
  }
  // M6：toml 策略从不注入 protocol 私有键（apply 仅写 scalars/table），故无需清理
  const legacy = legacySecretCleanup(ide.id, s)
  if (!changed && !legacy) return
  const bk = changed ? backupFile(ide.id, target, 'reset') : null
  try {
    if (changed) writeTomlAtomic(target, doc)
    if (legacy) writeLegacySecret(ide.id, legacy, 'reset:secret')
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

function resetEnv(ide: IDEAdapterDef, s: EnvSpec, target: string): void {
  const keys = [s.mapping.apiKey, s.mapping.baseUrl, s.mapping.model].filter(Boolean) as string[]
  if (keys.length === 0) return
  // M6：env 策略从不注入 protocol 私有键（仅按 mapping 增删），故无需清理
  const env = readEnv(target)
  if (!keys.some((k) => k in env)) return // 文件里没有我们写过的键：不备份也不重写
  const bk = backupFile(ide.id, target, 'reset')
  try {
    removeEnvKeys(target, keys)
  } catch (e) {
    if (bk) restoreBackup(bk.id)
    throw e
  }
}

// ---------------- 生成配置（assist / 无法自动定位时的兜底） ----------------

/**
 * 目标结构无法用三字段映射表达的 assist 型 IDE，按其官方 schema 生成片段（均不含 API Key）。
 * Zed：openai_compatible 的对象键即 provider id，Key 读取自钥匙串或环境变量 <ID 大写>_API_KEY（此处为 CODESWITCH_API_KEY）。
 */
const ASSIST_SNIPPETS: Record<string, (vals: { baseUrl: string; model: string }) => unknown> = {
  zed: (vals) => ({
    language_models: {
      openai_compatible: {
        codeswitch: {
          api_url: vals.baseUrl,
          available_models: [{ name: vals.model, display_name: vals.model, max_tokens: 128000 }]
        }
      }
    }
  })
}

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
  // 数据库不是可手动粘贴的载体，“打开所在文件夹”指向 state.vscdb 只会误导
  const targetPath = s.kind === 'sqlite' ? undefined : targetForWrite(ide) ?? undefined
  let text = ''

  const snippet = ASSIST_SNIPPETS[ide.id]
  if (snippet) {
    text = JSON.stringify(snippet(vals), null, 2)
  } else if (s.kind === 'json') {
    text = JSON.stringify(applyFieldsToConfig(provider, s.fields, {}, ide.id), null, 2)
  } else if (s.kind === 'toml') {
    const doc: Record<string, any> = {}
    if (s.scalars) for (const [k, v] of Object.entries(s.scalars)) doc[k] = subToken(v, vals)
    if (s.table && s.tableValues) {
      const t = ensureTable(doc, s.table)
      for (const [k, v] of Object.entries(s.tableValues)) t[k] = subToken(v, vals)
    }
    text = `# ${resolvePath(s.paths[0]) ?? s.paths[0]}\n` + tomlToText(doc)
  } else if (s.kind === 'env') {
    const lines: string[] = []
    if (s.mapping.apiKey) lines.push(`${s.mapping.apiKey}=${vals.apiKey}`)
    if (s.mapping.baseUrl) lines.push(`${s.mapping.baseUrl}=${vals.baseUrl}`)
    if (s.mapping.model) lines.push(`${s.mapping.model}=${vals.model}`)
    text = lines.join('\n')
  }

  if (!text.trim()) {
    // sqlite 型（凭证在 IDE 加密存储或槽位无法定位）：给出三要素，由用户在 IDE 设置界面填写
    text = `API Key: ${vals.apiKey}\nBase URL: ${vals.baseUrl}\nModel: ${vals.model}`
  }
  return { ok: true, data: { text, targetPath } }
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
