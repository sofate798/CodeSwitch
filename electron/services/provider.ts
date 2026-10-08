import axios, { AxiosError } from 'axios'
import { decrypt } from './crypto'
import type { Provider, Protocol, FieldMap, OpResult } from '../shared/types'

/**
 * baseUrl 规范化拆分为「连接测试用」与「写入 IDE 用」两条路径（H5）：
 * - resolveTestBaseUrl：仅用于 testProvider 拼 /models、/chat/completions、/v1/messages；
 * - normalizeWriteBaseUrl：用于落盘到各 IDE 配置，是否补 /v1 下沉为 per-IDE 策略，
 *   杜绝写入后出现 /v1/v1 重复或端点不符。
 */

/** 落盘 baseUrl 的版本段策略 */
export type BaseUrlWriteMode = 'withV1' | 'stripV1' | 'asIs'

/**
 * per-IDE 落盘策略覆盖表（H5）。缺省时按协议推断：openai -> withV1，anthropic -> stripV1。
 * 若某 IDE 出现 /v1/v1 重复或端点不符，在此按 ideId 覆盖，无需改动写入逻辑。
 */
export const BASE_URL_WRITE_MODE: Record<string, BaseUrlWriteMode> = {
  // 目前所有已适配 IDE 均沿用协议默认；此处保留为 per-IDE 扩展点。
}

function trimSlashes(u: string): string {
  return (u || '').trim().replace(/\/+$/, '')
}

/** 连接测试用 base：OpenAI 确保单个 /v1；Anthropic 去尾 /v1（调用方统一拼 /v1/messages） */
export function resolveTestBaseUrl(url: string, protocol: Protocol): string {
  const u = trimSlashes(url)
  if (protocol === 'openai') {
    return /\/v\d+($|\/)/.test(u) ? u : `${u}/v1`
  }
  return u.replace(/\/v1$/i, '')
}

/** 落盘用 base：按 per-IDE 策略决定是否补 /v1，并防止 /v1/v1 重复 */
export function normalizeWriteBaseUrl(url: string, protocol: Protocol, ideId?: string): string {
  const u = trimSlashes(url)
  const mode: BaseUrlWriteMode = (ideId && BASE_URL_WRITE_MODE[ideId]) || (protocol === 'openai' ? 'withV1' : 'stripV1')
  if (mode === 'withV1') {
    // 已含 /vN 段则不再追加，避免出现 /v1/v1
    return /\/v\d+($|\/)/.test(u) ? u : `${u}/v1`
  }
  if (mode === 'stripV1') return u.replace(/\/v1$/i, '')
  return u
}

/** 是否为合法 http(s) URL（用于 testBadUrl 判定） */
function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL((raw || '').trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** axios 取消/超时（AbortController 触发）判定 */
function isAbortErr(e: unknown): boolean {
  const err = e as AxiosError
  return err?.code === 'ERR_CANCELED' || err?.code === 'ECONNABORTED' || err?.name === 'CanceledError' || err?.name === 'AbortError'
}

/** 按 HTTP 状态码归类失败（不回显上游响应体，仅返回状态码 —— Tina-L2） */
function httpErrResult(status: number): OpResult {
  if (status === 401 || status === 403) return { ok: false, code: 'msg.provider.testAuthFailed' }
  return { ok: false, code: 'msg.provider.testHttpErr', args: { status } }
}

/** 网络层异常归类：取消/超时 -> testTimeout，其余 -> testNetErr */
function netErrResult(e: unknown): OpResult {
  return isAbortErr(e) ? { ok: false, code: 'msg.provider.testTimeout' } : { ok: false, code: 'msg.provider.testNetErr' }
}

/** 整体总超时（M2）：/models 与 /chat/completions 共享同一 AbortController，最坏不超过 5s */
const TEST_TIMEOUT_MS = 5000

/**
 * 按协议发起最小可用请求。返回 OpResult（Tina-L2 / M2）：
 * - 成功 -> msg.provider.testOk（args.latencyMs）
 * - 鉴权失败(401/403) -> msg.provider.testAuthFailed
 * - 其它 HTTP 状态 -> msg.provider.testHttpErr（args.status，不回显上游响应体）
 * - URL 非法 -> msg.provider.testBadUrl；网络异常 -> msg.provider.testNetErr；超时 -> msg.provider.testTimeout
 * - 密钥不可解密 -> msg.provider.keyUnavailable（decrypt 现会抛 KeyUnavailableError）
 */
export async function testProvider(p: Provider): Promise<OpResult> {
  let key: string
  try {
    key = decrypt(p.apiKey)
  } catch {
    return { ok: false, code: 'msg.provider.keyUnavailable' }
  }

  if (!isHttpUrl(p.baseUrl)) return { ok: false, code: 'msg.provider.testBadUrl' }
  const base = resolveTestBaseUrl(p.baseUrl, p.protocol)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  const started = Date.now()
  try {
    if (p.protocol === 'openai') {
      // 优先 /v1/models（更轻），失败再降级 /chat/completions；两段共享总超时预算
      let lastStatus = 0
      try {
        const res = await axios.get(`${base}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: controller.signal,
          validateStatus: () => true
        })
        if (res.status < 300) return { ok: true, code: 'msg.provider.testOk', args: { latencyMs: Date.now() - started }, data: { latencyMs: Date.now() - started } }
        if (res.status === 401 || res.status === 403) return { ok: false, code: 'msg.provider.testAuthFailed' }
        lastStatus = res.status
      } catch (e) {
        // 超时/取消：整体预算已耗尽，直接返回；纯网络错误则再试 chat
        if (isAbortErr(e)) return { ok: false, code: 'msg.provider.testTimeout' }
      }
      try {
        const res = await axios.post(
          `${base}/chat/completions`,
          { model: p.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false },
          {
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            signal: controller.signal,
            validateStatus: () => true
          }
        )
        if (res.status < 300) return { ok: true, code: 'msg.provider.testOk', args: { latencyMs: Date.now() - started }, data: { latencyMs: Date.now() - started } }
        lastStatus = res.status
      } catch (e) {
        return netErrResult(e)
      }
      return httpErrResult(lastStatus)
    }

    // Anthropic：POST /v1/messages
    try {
      const res = await axios.post(
        `${base}/v1/messages`,
        { model: p.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
        {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          signal: controller.signal,
          validateStatus: () => true
        }
      )
      if (res.status < 300) return { ok: true, code: 'msg.provider.testOk', args: { latencyMs: Date.now() - started }, data: { latencyMs: Date.now() - started } }
      return httpErrResult(res.status)
    } catch (e) {
      return netErrResult(e)
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 取出供应商的明文三要素（apiKey 解密、baseUrl 按 per-IDE 落盘策略规范化、model）。
 * 各存储策略写入前统一调用。注意：decrypt 失败会抛 KeyUnavailableError，
 * 由调用方（apply/generateConfig 等返回 OpResult 的函数）捕获并映射为 msg.provider.keyUnavailable。
 */
export function providerValues(p: Provider, ideId?: string): { apiKey: string; baseUrl: string; model: string } {
  return { apiKey: decrypt(p.apiKey), baseUrl: normalizeWriteBaseUrl(p.baseUrl, p.protocol, ideId), model: p.model }
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

/**
 * json 策略：按字段映射把供应商值写入 JSON 对象（返回新对象，不改原引用）。
 * C2：不再注入私有键 protocol:'anthropic'（目标 IDE 不识别，会污染用户配置）。
 */
export function applyFieldsToConfig(provider: Provider, fields: FieldMap, currentConfig: any, ideId?: string): any {
  const cfg = currentConfig && typeof currentConfig === 'object' ? JSON.parse(JSON.stringify(currentConfig)) : {}
  const vals = providerValues(provider, ideId)
  if (fields.apiKey) setPath(cfg, fields.apiKey, vals.apiKey)
  if (fields.baseUrl) setPath(cfg, fields.baseUrl, vals.baseUrl)
  if (fields.model) setPath(cfg, fields.model, vals.model)
  return cfg
}
