import axios, { AxiosError } from 'axios'
import { decrypt } from './crypto'
import type { Provider, TestResult, FieldMap } from '../shared/types'

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
 * 取出供应商的明文三要素（apiKey 解密、baseUrl 按协议规范化、model）。
 * 各存储策略写入前统一调用，保证 OpenAI/Anthropic 的 baseUrl 拼接规则一致。
 */
export function providerValues(p: Provider): { apiKey: string; baseUrl: string; model: string } {
  return { apiKey: decrypt(p.apiKey), baseUrl: normalizeBase(p.baseUrl, p.protocol), model: p.model }
}

/** 按点路径写值，缺失的中间层自动创建 */
export function setPath(obj: any, dotPath: string, value: unknown): void {
  if (!dotPath) return
  const parts = dotPath.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

/** 按点路径读值 */
export function getPath(obj: any, dotPath: string): any {
  if (!dotPath) return undefined
  return dotPath.split('.').reduce((o, k) => o?.[k], obj)
}

/** 按点路径删值 */
export function unsetPath(obj: any, dotPath: string): void {
  if (!dotPath) return
  const parts = dotPath.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) cur = cur?.[parts[i]]
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]]
}

/** json 策略：按字段映射把供应商值写入 JSON 对象（返回新对象，不改原引用） */
export function applyFieldsToConfig(provider: Provider, fields: FieldMap, currentConfig: any): any {
  const cfg = currentConfig && typeof currentConfig === 'object' ? JSON.parse(JSON.stringify(currentConfig)) : {}
  const vals = providerValues(provider)
  if (fields.apiKey) setPath(cfg, fields.apiKey, vals.apiKey)
  if (fields.baseUrl) setPath(cfg, fields.baseUrl, vals.baseUrl)
  if (fields.model) setPath(cfg, fields.model, vals.model)
  if (provider.protocol === 'anthropic' && fields.apiKey) {
    const parentPath = fields.apiKey.split('.').slice(0, -1).join('.')
    if (parentPath) setPath(cfg, `${parentPath}.protocol`, 'anthropic')
  }
  return cfg
}
