import axios, { AxiosError } from 'axios'
import { decrypt } from './crypto'
import type { Provider, TestResult, IDEAdapterDef } from '../shared/types'

/** 规范化 baseUrl：去掉末尾斜杠；OpenAI 协议补全 /v1，Anthropic 协议剥离尾部 /v1（调用方统一拼 /v1/messages） */
function normalizeBase(url: string, protocol: 'openai' | 'anthropic'): string {
  let u = url.trim().replace(/\/+$/, '')
  if (protocol === 'openai') {
    if (!/\/v\d+($|\/)/.test(u)) u += '/v1'
  } else if (/\/v1$/i.test(u)) {
    u = u.replace(/\/v1$/i, '')
  }
  return u
}

/** 按协议发起最小可用请求，返回 2xx 视为成功 */
export async function testProvider(p: Provider): Promise<TestResult> {
  const key = decrypt(p.apiKey)
  const base = normalizeBase(p.baseUrl, p.protocol)
  const started = Date.now()
  try {
    if (p.protocol === 'openai') {
      // 优先 /v1/models（更轻），失败再降级 chat
      try {
        const res = await axios.get(`${base}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          timeout: 5000,
          validateStatus: () => true
        })
        if (res.status < 300) return { ok: true, message: `HTTP ${res.status}`, latencyMs: Date.now() - started }
      } catch {
        // fall through to chat
      }
      const res = await axios.post(
        `${base}/chat/completions`,
        { model: p.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 5000, validateStatus: () => true }
      )
      if (res.status < 300) return { ok: true, message: `HTTP ${res.status}`, latencyMs: Date.now() - started }
      return { ok: false, message: `HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}` }
    } else {
      const res = await axios.post(
        `${base}/v1/messages`,
        { model: p.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
        {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          timeout: 5000,
          validateStatus: () => true
        }
      )
      if (res.status < 300) return { ok: true, message: `HTTP ${res.status}`, latencyMs: Date.now() - started }
      return { ok: false, message: `HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}` }
    }
  } catch (e) {
    const err = e as AxiosError
    return { ok: false, message: err.code === 'ECONNABORTED' ? '请求超时 (5s)' : err.message }
  }
}

/**
 * 把供应商信息按目标 IDE 的字段映射写入配置对象（不直接落盘，由调用方原子写）。
 * 不兼容的协议返回 null。
 */
export function applyToConfig(
  provider: Provider,
  ide: IDEAdapterDef,
  currentConfig: any
): { config: any; incompatible: boolean } {
  if (!ide.protocols.includes(provider.protocol)) {
    return { config: currentConfig, incompatible: true }
  }
  const cfg = currentConfig && typeof currentConfig === 'object' ? JSON.parse(JSON.stringify(currentConfig)) : {}
  const key = decrypt(provider.apiKey)
  const base = normalizeBase(provider.baseUrl, provider.protocol)

  const setPath = (obj: any, path: string, value: unknown) => {
    if (!path) return
    const parts = path.split('.')
    let cur = obj
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}
      cur = cur[parts[i]]
    }
    cur[parts[parts.length - 1]] = value
  }

  if (ide.fields.apiKey) setPath(cfg, ide.fields.apiKey, key)
  if (ide.fields.baseUrl) setPath(cfg, ide.fields.baseUrl, base)
  if (ide.fields.model) setPath(cfg, ide.fields.model, provider.model)
  if (provider.protocol === 'anthropic' && ide.fields.apiKey) {
    // 在 apiKey 同级加协议标记（若 IDE 要求）
    const parentPath = ide.fields.apiKey.split('.').slice(0, -1).join('.')
    if (parentPath) setPath(cfg, `${parentPath}.protocol`, 'anthropic')
  }
  return { config: cfg, incompatible: false }
}
