import http from 'node:http'
import { randomBytes } from 'node:crypto'
import axios from 'axios'
import { store } from './store'
import { providerValues } from './provider'
import { KeyUnavailableError } from './crypto'
import {
  openaiToAnthropicReq,
  anthropicToOpenaiReq,
  anthropicRespToOpenai,
  openaiRespToAnthropic,
  anthropicStreamToOpenai,
  openaiStreamToAnthropic
} from './proxyTranslate'
import { log } from './logger'
import type { Provider, ProxyConfig, ProxyStatus, OpResult } from '../shared/types'

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
 * 安全（Alex-H4）：
 *  - 本地随机 token 鉴权：启动时生成/读取，仅 CodeSwitch 内部与用户显式配置知晓；
 *    API 路由要求 Authorization: Bearer <token> 或 x-codeswitch-token 头（或 ?token=）；
 *  - CORS 由 * 收紧为回显受控 Origin（仅本机来源），并处理预检；
 *  - 校验 Host/Origin 防 DNS rebinding（仅接受 127.0.0.1 / localhost / ::1）。
 *
 * 入站路由：
 *  - GET  /health                健康检查（无需 token，仅返回存活信息）
 *  - GET  /v1/models | /models   模型列表（OpenAI 供应商透传，否则合成当前模型）
 *  - POST /v1/chat/completions   OpenAI 入站
 *  - POST /v1/messages           Anthropic 入站
 */

let server: http.Server | null = null
let lastError: string | undefined
/** activeProvider 解析失败（如密钥不可用）时的非敏感原因，供 handle 返回受控错误 */
let lastActiveError: string | undefined

/** 受控主机名（防 DNS rebinding） */
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]']

function cfg(): ProxyConfig {
  const c = store.get('proxy') as Partial<ProxyConfig> | undefined
  return {
    enabled: c?.enabled ?? false,
    port: c?.port ?? 8787,
    providerId: c?.providerId ?? null
  }
}

/** 读取/生成本地网关鉴权 token（Alex-H4）。首次调用时随机生成并持久化。 */
function ensureToken(): string {
  let t = store.get('proxyToken')
  if (!t) {
    t = randomBytes(32).toString('hex')
    store.set('proxyToken', t)
  }
  return t
}

/** 供上层（B4 handler / 前端配置引导）获取当前 token，用于用户显式配置客户端 */
export function getProxyToken(): string {
  return ensureToken()
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

/** 当前生效的转发目标（解密后的三要素）。
 * 密钥不可用（KeyUnavailableError）或解密失败时返回 null，并在 lastActiveError 记录非敏感原因（英文，
 * 供状态诊断与日志使用；界面文案由前端 i18n 渲染），绝不向上抛出异常、绝不回显明文 Key（Alex 对接要求）。 */
function activeProvider(): { provider: Provider; apiKey: string; baseUrl: string; model: string } | null {
  const c = cfg()
  if (!c.providerId) {
    lastActiveError = undefined
    return null
  }
  const provider = (store.get('providers') as Provider[]).find((p) => p.id === c.providerId)
  if (!provider) {
    lastActiveError = undefined
    return null
  }
  try {
    // 网关转发无特定 ideId，providerValues 走默认 baseUrl 归一化
    const v = providerValues(provider)
    lastActiveError = undefined
    return { provider, ...v }
  } catch (e) {
    const keyUnavailable = e instanceof KeyUnavailableError || (e as Error)?.name === 'KeyUnavailableError'
    lastActiveError = keyUnavailable
      ? 'Target provider key is unavailable; re-enter its API Key in CodeSwitch'
      : 'Target provider config failed to parse; please check its settings'
    // 仅记录 provider id 与非敏感原因，绝不记录明文 Key
    log('error', 'proxy', `activeProvider failed for ${provider.id}: ${keyUnavailable ? 'key unavailable' : 'decrypt/parse error'}`)
    return null
  }
}

// ---------------- 生命周期 ----------------

export async function startProxy(portOverride?: number): Promise<OpResult<ProxyStatus>> {
  await stopProxy()
  const port = portOverride ?? cfg().port
  ensureToken()
  lastError = undefined
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      handle(req, res).catch((e) => sendError(res, 500, (e as Error).message, 'openai'))
    })
    srv.on('error', (e: NodeJS.ErrnoException) => {
      // lastError 为技术诊断串（英文，进 ProxyStatus.error/日志）；用户可见文案走消息码由前端 i18n 渲染
      const portInUse = e.code === 'EADDRINUSE'
      lastError = portInUse ? `Port ${port} is already in use` : e.message
      server = null
      log('error', 'proxy', `start failed: ${lastError}`)
      resolve({
        ok: false,
        code: portInUse ? 'msg.proxy.errorPortInUse' : 'msg.proxy.error',
        args: portInUse ? { port } : {},
        data: proxyStatus()
      })
    })
    srv.listen(port, '127.0.0.1', () => {
      server = srv
      log('info', 'proxy', `listening on ${proxyUrl(port)}`)
      resolve({ ok: true, code: 'msg.proxy.started', args: { port }, data: proxyStatus() })
    })
  })
}

export async function stopProxy(): Promise<OpResult<ProxyStatus>> {
  if (server) {
    const s = server
    server = null
    await new Promise<void>((r) => s.close(() => r()))
  }
  return { ok: true, code: 'msg.proxy.stopped', data: proxyStatus() }
}

/** 应用配置：写入 store，并按 enabled 决定启停（端口变化会重启） */
export async function configureProxy(patch: Partial<ProxyConfig>): Promise<OpResult<ProxyStatus>> {
  const next: ProxyConfig = { ...cfg(), ...patch }
  store.set('proxy', next)
  if (next.enabled) return startProxy(next.port)
  await stopProxy()
  return { ok: true, code: 'msg.proxy.stopped', data: proxyStatus() }
}

/** app 启动时调用：仅在用户曾启用过时自动拉起 */
export async function autoStartProxy(): Promise<void> {
  const c = cfg()
  if (c.enabled) await startProxy(c.port)
}

// ---------------- 安全校验 ----------------

/** Host 校验：防 DNS rebinding，仅接受本机 Host */
function hostAllowed(req: http.IncomingMessage): boolean {
  const host = req.headers.host
  if (!host) return true // 部分本地客户端省略 Host
  const hostname = host.replace(/:\d+$/, '')
  return ALLOWED_HOSTS.includes(hostname) || ALLOWED_HOSTS.includes(host)
}

/** Origin 校验：仅接受本机来源，用于回显受控 CORS Origin */
function originAllowed(origin: string): boolean {
  try {
    const u = new URL(origin)
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin
  if (typeof origin === 'string' && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }
  // 不受控 Origin 不回显，浏览器侧即视为跨域被拒
}

/** token 鉴权：Bearer / x-codeswitch-token / ?token= 三种携带方式 */
function isAuthed(req: http.IncomingMessage, url: URL | null): boolean {
  const token = store.get('proxyToken')
  if (!token) return true // 理论上启动时已生成；无 token 时不阻断
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.slice(7).trim() === token) return true
  const x = req.headers['x-codeswitch-token']
  if (typeof x === 'string' && x === token) return true
  if (url && url.searchParams.get('token') === token) return true
  return false
}

// ---------------- 请求处理 ----------------

/** 请求体体积上限（A5）：超限直接拒绝，避免本机进程被超大 body 耗尽内存 */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** 超限错误：handle 层据此回 413（而非冒泡为 500） */
class MaxBodySizeError extends Error {
  constructor() {
    super('request body too large')
    this.name = 'MaxBodySizeError'
  }
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      if (tooLarge) return // 超限后不再缓冲，仅丢弃后续 chunk（内存已封顶）
      size += c.length
      if (size > MAX_BODY_BYTES) {
        // 不销毁 socket：立即 reject 让 handler 回 413，响应先于连接关闭送达调用方
        tooLarge = true
        reject(new MaxBodySizeError())
        return
      }
      data += c
    })
    req.on('end', () => {
      if (tooLarge) return
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

/** 入站 body 读取失败归类：超限 413，其余（JSON 解析失败等）400 */
function rejectBody(res: http.ServerResponse, e: unknown, format: 'openai' | 'anthropic'): void {
  if (e instanceof MaxBodySizeError) return sendError(res, 413, 'request body too large', format)
  return sendError(res, 400, 'invalid JSON body', format)
}

/**
 * Alex-M7：客户端断开时主动 abort 上游请求。
 * 监听下游 res 'close'（未完成即断开）与 req 'aborted'/'error'，触发 AbortController，
 * axios 收到 signal 会断开上游连接、销毁流，SSE 转换随之结束，避免无谓 token/连接消耗。
 */
function wireAbort(req: http.IncomingMessage, res: http.ServerResponse, ac: AbortController): void {
  const abort = (): void => {
    if (!ac.signal.aborted) ac.abort()
  }
  res.on('close', () => {
    if (!res.writableEnded) abort()
  })
  req.on('aborted', abort)
  req.on('error', abort)
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // 防 DNS rebinding：非法 Host 直接拒绝
  if (!hostAllowed(req)) {
    res.statusCode = 403
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: { message: 'forbidden host', type: 'api_error', code: 403 } }))
    return
  }
  applyCors(req, res)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-codeswitch-token, anthropic-version')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Max-Age', '86400')
    res.statusCode = 204
    res.end()
    return
  }

  let url: URL | null = null
  try {
    url = new URL(req.url || '/', proxyUrl())
  } catch {
    url = null
  }
  const pathname = url ? url.pathname : (req.url || '/').split('?')[0]

  // 健康检查：无需 token，仅返回存活信息（不泄露供应商等敏感状态）
  if (pathname === '/health' || pathname === '/') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, app: 'CodeSwitch Gateway', running: !!server?.listening }))
    return
  }

  // API 路由需鉴权
  if (!isAuthed(req, url)) return sendError(res, 401, '无效或缺失的访问令牌', 'openai')

  const act = activeProvider()
  if (!act) {
    // 密钥不可用/解析失败 -> 502 + 非敏感文案；未选择供应商 -> 503
    if (lastActiveError) return sendError(res, 502, lastActiveError, 'openai')
    return sendError(res, 503, '未选择转发目标供应商', 'openai')
  }

  const ac = new AbortController()
  wireAbort(req, res, ac)

  if (pathname.endsWith('/models')) return handleModels(act, res, ac.signal)
  if (pathname.endsWith('/chat/completions')) return handleChatCompletions(act, req, res, ac.signal)
  if (pathname.endsWith('/messages')) return handleMessages(act, req, res, ac.signal)
  return sendError(res, 404, `未知路由: ${pathname}`, 'openai')
}

async function handleModels(act: NonNullable<ReturnType<typeof activeProvider>>, res: http.ServerResponse, signal: AbortSignal): Promise<void> {
  if (act.provider.protocol === 'openai') {
    try {
      const r = await axios.get(`${act.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${act.apiKey}` },
        timeout: 10000,
        signal,
        validateStatus: () => true
      })
      if (r.status < 300) {
        res.statusCode = r.status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(r.data))
        return
      }
    } catch {
      // 降级为合成列表（含被 abort 的情况）
    }
  }
  if (res.writableEnded) return
  const body = {
    object: 'list',
    data: [{ id: act.model, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'codeswitch' }]
  }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

async function handleChatCompletions(act: NonNullable<ReturnType<typeof activeProvider>>, req: http.IncomingMessage, res: http.ServerResponse, signal: AbortSignal): Promise<void> {
  let body: any
  try {
    body = await readBody(req)
  } catch (e) {
    return rejectBody(res, e, 'openai')
  }
  if (!body.model) body.model = act.model
  const stream = !!body.stream
  try {
    if (act.provider.protocol === 'openai') {
      return await passThrough(`${act.baseUrl}/chat/completions`, { Authorization: `Bearer ${act.apiKey}` }, body, res, signal)
    }
    // OpenAI 入站 → Anthropic 供应商
    const anthReq = openaiToAnthropicReq(body, act.model)
    const r = await axios.post(`${act.baseUrl}/v1/messages`, anthReq, {
      headers: { 'content-type': 'application/json', 'x-api-key': act.apiKey, 'anthropic-version': '2023-06-01' },
      responseType: stream ? 'stream' : 'json',
      timeout: 0,
      signal,
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
    if (signal.aborted || res.writableEnded) return
    return sendError(res, 502, (e as Error).message, 'openai')
  }
}

async function handleMessages(act: NonNullable<ReturnType<typeof activeProvider>>, req: http.IncomingMessage, res: http.ServerResponse, signal: AbortSignal): Promise<void> {
  let body: any
  try {
    body = await readBody(req)
  } catch (e) {
    return rejectBody(res, e, 'anthropic')
  }
  if (!body.model) body.model = act.model
  const stream = !!body.stream
  try {
    if (act.provider.protocol === 'anthropic') {
      return await passThrough(`${act.baseUrl}/v1/messages`, { 'x-api-key': act.apiKey, 'anthropic-version': '2023-06-01' }, body, res, signal)
    }
    // Anthropic 入站 → OpenAI 供应商
    const oReq = anthropicToOpenaiReq(body, act.model)
    const r = await axios.post(`${act.baseUrl}/chat/completions`, oReq, {
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${act.apiKey}` },
      responseType: stream ? 'stream' : 'json',
      timeout: 0,
      signal,
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
    if (signal.aborted || res.writableEnded) return
    return sendError(res, 502, (e as Error).message, 'anthropic')
  }
}

/** 同协议透传：直接管道上游响应（流式/非流式统一处理）；signal 用于客户端断开时中止上游 */
async function passThrough(url: string, headers: Record<string, string>, body: any, res: http.ServerResponse, signal: AbortSignal): Promise<void> {
  const r = await axios.post(url, body, {
    headers: { 'content-type': 'application/json', ...headers },
    responseType: 'stream',
    timeout: 0,
    signal,
    validateStatus: () => true
  })
  if (res.writableEnded) {
    // 客户端已断开，销毁上游流避免继续消耗
    try {
      r.data.destroy?.()
    } catch {
      // ignore
    }
    return
  }
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
