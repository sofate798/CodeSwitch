import http from 'node:http'
import axios from 'axios'
import { store } from './store'
import { providerValues } from './provider'
import {
  openaiToAnthropicReq,
  anthropicToOpenaiReq,
  anthropicRespToOpenai,
  openaiRespToAnthropic,
  anthropicStreamToOpenai,
  openaiStreamToAnthropic
} from './proxyTranslate'
import { log } from './logger'
import type { Provider, ProxyConfig, ProxyStatus } from '../shared/types'

/**
 * 本地转发网关（Local Forwarding Gateway）
 *
 * 在 127.0.0.1 上启动一个 OpenAI / Anthropic 双协议兼容的 HTTP 服务，把请求转发到
 * 用户在 CodeSwitch 里选定的「目标供应商」。核心价值：
 *  - 任何允许自定义 Base URL 的客户端（IDE 扩展 Cline/Continue/Roo、Codex/Gemini CLI、
 *    脚本、curl 等）都能指向本网关，从而复用同一份供应商配置；
 *  - 支持 OpenAI ↔ Anthropic 跨协议自动转换（含流式 SSE），一端说 OpenAI、另一端是
 *    Claude Key 也能通；
 *  - 与 Cursor 订阅无关：Cursor 免费版服务端封锁了自带 AI 的自定义端点，但在 Cursor 里
 *    装一个免费的 OpenAI 兼容扩展（Cline/Continue/Roo）指向本网关即可用自定义供应商，
 *    不需要 Pro。
 *
 * 入站路由：
 *  - GET  /health                健康检查
 *  - GET  /v1/models | /models   模型列表（OpenAI 供应商透传，否则合成当前模型）
 *  - POST /v1/chat/completions   OpenAI 入站
 *  - POST /v1/messages           Anthropic 入站
 */

let server: http.Server | null = null
let lastError: string | undefined

function cfg(): ProxyConfig {
  const c = store.get('proxy') as Partial<ProxyConfig> | undefined
  return {
    enabled: c?.enabled ?? false,
    port: c?.port ?? 8787,
    providerId: c?.providerId ?? null
  }
}

export function proxyUrl(port = cfg().port): string {
  return `http://127.0.0.1:${port}`
}

export function proxyStatus(): ProxyStatus {
  const c = cfg()
  const p = (store.get('providers') as Provider[]).find((x) => x.id === c.providerId) ?? null
  return {
    enabled: c.enabled,
    running: !!server?.listening,
    port: c.port,
    url: proxyUrl(c.port),
    providerId: c.providerId,
    providerName: p?.name ?? null,
    error: lastError
  }
}

/** 当前生效的转发目标（解密后的三要素） */
function activeProvider(): { provider: Provider; apiKey: string; baseUrl: string; model: string } | null {
  const c = cfg()
  if (!c.providerId) return null
  const provider = (store.get('providers') as Provider[]).find((p) => p.id === c.providerId)
  if (!provider) return null
  const v = providerValues(provider)
  return { provider, ...v }
}

// ---------------- 生命周期 ----------------

export async function startProxy(portOverride?: number): Promise<ProxyStatus> {
  await stopProxy()
  const port = portOverride ?? cfg().port
  lastError = undefined
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      handle(req, res).catch((e) => sendError(res, 500, (e as Error).message, 'openai'))
    })
    srv.on('error', (e: NodeJS.ErrnoException) => {
      lastError = e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : e.message
      server = null
      log('error', 'proxy', `start failed: ${lastError}`)
      resolve(proxyStatus())
    })
    srv.listen(port, '127.0.0.1', () => {
      server = srv
      log('info', 'proxy', `listening on ${proxyUrl(port)}`)
      resolve(proxyStatus())
    })
  })
}

export async function stopProxy(): Promise<void> {
  if (server) {
    const s = server
    server = null
    await new Promise<void>((r) => s.close(() => r()))
  }
}

/** 应用配置：写入 store，并按 enabled 决定启停（端口变化会重启） */
export async function configureProxy(patch: Partial<ProxyConfig>): Promise<ProxyStatus> {
  const next: ProxyConfig = { ...cfg(), ...patch }
  store.set('proxy', next)
  if (next.enabled) return startProxy(next.port)
  await stopProxy()
  return proxyStatus()
}

/** app 启动时调用：仅在用户曾启用过时自动拉起 */
export async function autoStartProxy(): Promise<void> {
  const c = cfg()
  if (c.enabled) await startProxy(c.port)
}

// ---------------- 请求处理 ----------------

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = (req.url || '/').split('?')[0]
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.statusCode = 204
    res.end()
    return
  }
  if (url === '/health' || url === '/') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, app: 'CodeSwitch Gateway', ...proxyStatus() }))
    return
  }

  const act = activeProvider()
  if (!act) return sendError(res, 503, '未选择转发目标供应商', 'openai')

  if (url.endsWith('/models')) return handleModels(act, res)
  if (url.endsWith('/chat/completions')) return handleChatCompletions(act, req, res)
  if (url.endsWith('/messages')) return handleMessages(act, req, res)
  return sendError(res, 404, `未知路由: ${url}`, 'openai')
}

async function handleModels(act: NonNullable<ReturnType<typeof activeProvider>>, res: http.ServerResponse): Promise<void> {
  if (act.provider.protocol === 'openai') {
    try {
      const r = await axios.get(`${act.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${act.apiKey}` },
        timeout: 10000,
        validateStatus: () => true
      })
      if (r.status < 300) {
        res.statusCode = r.status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(r.data))
        return
      }
    } catch {
      // 降级为合成列表
    }
  }
  const body = {
    object: 'list',
    data: [{ id: act.model, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'codeswitch' }]
  }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

async function handleChatCompletions(act: NonNullable<ReturnType<typeof activeProvider>>, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req)
  if (!body.model) body.model = act.model
  const stream = !!body.stream
  try {
    if (act.provider.protocol === 'openai') {
      return await passThrough(`${act.baseUrl}/chat/completions`, { Authorization: `Bearer ${act.apiKey}` }, body, res)
    }
    // OpenAI 入站 → Anthropic 供应商
    const anthReq = openaiToAnthropicReq(body, act.model)
    const r = await axios.post(`${act.baseUrl}/v1/messages`, anthReq, {
      headers: { 'content-type': 'application/json', 'x-api-key': act.apiKey, 'anthropic-version': '2023-06-01' },
      responseType: stream ? 'stream' : 'json',
      timeout: 0,
      validateStatus: () => true
    })
    if (r.status >= 300) return await relayError(res, r, 'openai')
    if (!stream) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(anthropicRespToOpenai(r.data, act.model)))
      return
    }
    return anthropicStreamToOpenai(r.data, res, act.model)
  } catch (e) {
    return sendError(res, 502, (e as Error).message, 'openai')
  }
}

async function handleMessages(act: NonNullable<ReturnType<typeof activeProvider>>, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req)
  if (!body.model) body.model = act.model
  const stream = !!body.stream
  try {
    if (act.provider.protocol === 'anthropic') {
      return await passThrough(`${act.baseUrl}/v1/messages`, { 'x-api-key': act.apiKey, 'anthropic-version': '2023-06-01' }, body, res)
    }
    // Anthropic 入站 → OpenAI 供应商
    const oReq = anthropicToOpenaiReq(body, act.model)
    const r = await axios.post(`${act.baseUrl}/chat/completions`, oReq, {
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${act.apiKey}` },
      responseType: stream ? 'stream' : 'json',
      timeout: 0,
      validateStatus: () => true
    })
    if (r.status >= 300) return await relayError(res, r, 'anthropic')
    if (!stream) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(openaiRespToAnthropic(r.data)))
      return
    }
    return openaiStreamToAnthropic(r.data, res, act.model)
  } catch (e) {
    return sendError(res, 502, (e as Error).message, 'anthropic')
  }
}

/** 同协议透传：直接管道上游响应（流式/非流式统一处理） */
async function passThrough(url: string, headers: Record<string, string>, body: any, res: http.ServerResponse): Promise<void> {
  const r = await axios.post(url, body, {
    headers: { 'content-type': 'application/json', ...headers },
    responseType: 'stream',
    timeout: 0,
    validateStatus: () => true
  })
  res.statusCode = r.status
  const ct = r.headers['content-type']
  if (ct) res.setHeader('content-type', Array.isArray(ct) ? ct.join(', ') : String(ct))
  r.data.on('error', () => {
    if (!res.writableEnded) res.end()
  })
  r.data.pipe(res)
}

// ---------------- 错误 ----------------

function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let s = ''
    stream.setEncoding('utf8')
    stream.on('data', (c: string) => (s += c))
    stream.on('end', () => resolve(s))
    stream.on('error', () => resolve(s))
  })
}

async function relayError(res: http.ServerResponse, r: any, format: 'openai' | 'anthropic'): Promise<void> {
  let text = ''
  try {
    if (typeof r.data === 'string') text = r.data
    else if (r.data && typeof r.data.pipe === 'function') text = await streamToString(r.data)
    else text = JSON.stringify(r.data)
  } catch {
    text = ''
  }
  sendError(res, r.status || 502, text.slice(0, 800) || `上游返回 ${r.status}`, format)
}

function sendError(res: http.ServerResponse, code: number, message: string, format: 'openai' | 'anthropic'): void {
  if (res.writableEnded || res.headersSent) {
    try {
      res.end()
    } catch {
      // ignore
    }
    return
  }
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  const payload =
    format === 'anthropic'
      ? { type: 'error', error: { type: 'api_error', message } }
      : { error: { message, type: 'api_error', code } }
  res.end(JSON.stringify(payload))
}
