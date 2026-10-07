import fs from 'node:fs'
import { IDE_REGISTRY, resolvePath } from '../adapters/registry'
import { store } from './store'
import { backupFile, readJsonSafe, writeJsonAtomic } from './backup'
import { applyToConfig } from './provider'
import { log } from './logger'
import type { IDEAdapterDef, IDEState, Provider, IDEStatus } from '../shared/types'

function findConfigPath(ide: IDEAdapterDef): string | null {
  const manual = store.get('ideBindings')[ide.id]?.configPath
  if (manual && fs.existsSync(manual)) return manual
  for (const tpl of ide.configPaths) {
    const p = resolvePath(tpl)
    if (p && p.endsWith('.json') && fs.existsSync(p)) return p
  }
  return null
}

/** 首选配置路径（无论文件是否存在），用于可写 IDE 首次创建配置文件 */
function preferredConfigPath(ide: IDEAdapterDef): string | null {
  const manual = store.get('ideBindings')[ide.id]?.configPath
  if (manual) return manual
  for (const tpl of ide.configPaths) {
    const p = resolvePath(tpl)
    if (p && p.endsWith('.json')) return p // 只选 JSON，跳过 .pb/.toml
  }
  return null
}

function isInstalled(ide: IDEAdapterDef): boolean {
  // 1. 家目录探针（跨盘符最可靠）
  for (const tpl of ide.homeMarkers ?? []) {
    const p = resolvePath(tpl)
    if (p && fs.existsSync(p)) return true
  }
  // 2. 可执行文件多位置
  for (const tpl of ide.detectPaths) {
    const p = resolvePath(tpl)
    if (p && fs.existsSync(p)) return true
  }
  // 3. 配置文件存在也算
  return findConfigPath(ide) !== null
}

/** 扫描全部 IDE，返回状态列表 */
export function scanIDEs(): IDEState[] {
  const bindings = store.get('ideBindings')
  const providers = store.get('providers')
  const result: IDEState[] = []

  for (const ide of IDE_REGISTRY) {
    const installed = isInstalled(ide)
    const configPath = findConfigPath(ide)
    const binding = bindings[ide.id]

    let status: IDEStatus = 'missing'
    let currentProviderId: string | null = null
    let note: string | undefined = ide.note

    if (!installed) {
      status = 'missing'
    } else if (!configPath) {
      // 已安装但尚未生成配置文件：属干净默认状态（可一键写入时自动创建）
      status = 'default'
      note = note ?? '已安装但未找到配置文件，可手动指定'
    } else {
      const { data, error } = readJsonSafe(configPath)
      if (error) {
        status = 'error'
        note = `配置解析失败: ${error}`
      } else {
        currentProviderId = binding?.providerId ?? null
        if (currentProviderId) {
          status = 'customized'
        } else {
          // 启发式：若配置里有 apiKey 但不在我们绑定列表，也视为 customized
          const hasKey = ide.fields.apiKey && getPath(data, ide.fields.apiKey)
          status = hasKey ? 'customized' : 'default'
        }
      }
    }

    result.push({
      id: ide.id,
      name: ide.name,
      installed,
      status,
      configPath,
      currentProviderId,
      lastBackup: store.get('backups').find((b) => b.ideId === ide.id)?.timestamp ?? null,
      note
    })
  }
  return result
}

function getPath(obj: any, dotPath: string): any {
  return dotPath.split('.').reduce((o, k) => o?.[k], obj)
}

/** 对指定 IDE 应用供应商 */
export function applyProvider(ideId: string, providerId: string): { ok: boolean; message: string } {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  const provider: Provider | undefined = store.get('providers').find((p) => p.id === providerId)
  if (!ide) return { ok: false, message: '未知 IDE' }
  if (!provider) return { ok: false, message: '供应商不存在' }
  if (ide.writable === false) {
    return { ok: false, message: `${ide.name} 不支持自动写入：${ide.note ?? '请手动配置'}` }
  }

  let configPath = findConfigPath(ide)
  if (!configPath) {
    // 可写 IDE 配置文件尚未创建：用首选路径新建
    configPath = preferredConfigPath(ide)
    if (!configPath) return { ok: false, message: '未找到该 IDE 的配置文件，请先手动指定路径' }
  }

  // 应用前自动备份（文件不存在时备份自动跳过）
  backupFile(ide.id, configPath, `apply:${provider.name}`)

  const { data, error } = readJsonSafe(configPath)
  if (error && error !== 'not_found') return { ok: false, message: `配置文件损坏: ${error}` }

  const { config, incompatible } = applyToConfig(provider, ide, data ?? {})
  if (incompatible) {
    return { ok: false, message: `${ide.name} 不支持 ${provider.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'} 协议` }
  }

  try {
    writeJsonAtomic(configPath, config)
    store.set(`ideBindings.${ideId}`, { providerId, configPath })
    log('info', 'apply', `${ideId} <- ${provider.name} (${provider.protocol})`)
    return { ok: true, message: `已应用到 ${ide.name}，重启 IDE 后生效` }
  } catch (e) {
    return { ok: false, message: `写入失败: ${(e as Error).message}` }
  }
}

/** 恢复指定 IDE 到默认（清空我们写入的字段，或从最近备份还原） */
export function resetIDE(ideId: string): { ok: boolean; message: string; skipped?: boolean } {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  if (!ide) return { ok: false, message: '未知 IDE' }
  if (ide.writable === false) {
    // 非直写型配置（SQLite/TOML 等）不做任何文件改动，避免破坏
    return { ok: true, message: `${ide.name} 为手动配置型，已跳过`, skipped: true }
  }
  const configPath = findConfigPath(ide)
  if (!configPath) return { ok: false, message: '未找到配置文件' }

  const { data, error } = readJsonSafe(configPath)
  if (error && error !== 'not_found') {
    // 解析失败时绝不覆盖，防止把损坏/TOML 配置写为空 JSON
    return { ok: false, message: `配置文件无法解析（${error}），已取消恢复以保护原文件` }
  }

  backupFile(ide.id, configPath, 'reset')
  const cfg = data && typeof data === 'object' ? JSON.parse(JSON.stringify(data)) : {}

  // 清空我们写入的字段
  const unsetPath = (obj: any, dotPath: string) => {
    if (!dotPath) return
    const parts = dotPath.split('.')
    let cur = obj
    for (let i = 0; i < parts.length - 1; i++) cur = cur?.[parts[i]]
    if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]]
  }
  if (ide.fields.apiKey) unsetPath(cfg, ide.fields.apiKey)
  if (ide.fields.baseUrl) unsetPath(cfg, ide.fields.baseUrl)
  if (ide.fields.model) unsetPath(cfg, ide.fields.model)

  try {
    writeJsonAtomic(configPath, cfg)
    const bindings = store.get('ideBindings')
    delete bindings[ideId]
    store.set('ideBindings', bindings)
    log('info', 'reset', ideId)
    return { ok: true, message: `${ide.name} 已恢复默认` }
  } catch (e) {
    return { ok: false, message: `恢复失败: ${(e as Error).message}` }
  }
}

/** 手动指定 IDE 配置文件路径（保留已应用的供应商绑定） */
export function manualAdd(ideId: string, configPath: string): { ok: boolean; message: string } {
  const ide = IDE_REGISTRY.find((x) => x.id === ideId)
  if (!ide) return { ok: false, message: '未知 IDE' }
  if (!fs.existsSync(configPath)) return { ok: false, message: '文件不存在' }
  const bindings = store.get('ideBindings')
  bindings[ideId] = { providerId: bindings[ideId]?.providerId ?? null, configPath }
  store.set('ideBindings', bindings)
  log('info', 'manual-path', `${ideId} -> ${configPath}`)
  return { ok: true, message: '路径已保存' }
}
