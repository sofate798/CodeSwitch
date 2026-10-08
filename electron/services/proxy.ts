import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
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
 *    API 路由要求 Authorization: Bearer <token>、x-codeswitch-token 头、x-api-key 头或 ?token=；
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

/**
 * 启停串行化：startProxyNow 内部先 await 关闭旧实例再 listen，两次 configure（如快速开关、改端口）交错时，
 * 后者可能在前者 listen 成功前就进入；两个 listen 竞争同一端口，失败方会把已在监听的实例引用冲掉，
 * 留下一个状态显示“未运行”、却再也关不掉的孤儿服务。所有对外入口都排进同一条链。
 */
let lifecycle: Promise<unknown> = Promise.resolve()
function serialLifecycle<T>(task: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(task, task)
  lifecycle = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function startProxyNow(port: number): Promise<OpResult<ProxyStatus>> {
  await stopProxyNow()
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
      if (server === srv) server = null
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

export function stopProxy(): Promise<OpResult<ProxyStatus>> {
  return serialLifecycle(stopProxyNow)
}

async function stopProxyNow(): Promise<OpResult<ProxyStatus>> {
  // 上一次启动失败的诊断（如端口占用）只描述那次尝试；停用后仍挂在状态里会让“已停止”的网关显示报错
  lastError = undefined
  if (server) {
    const s = server
    server = null
    // server.close() 会等到所有连接结束才回调；网关常留着客户端的 keep-alive / 长连接 SSE
    // （尤其“重启应用”“重置全部数据”等要 await stopProxy() 的路径），不强制断开就会把
    // 退出/重启流程挂住。故先断空闲连接、再给短暂宽限，最后强制断开全部连接。
    s.closeIdleConnections?.()
    await new Promise<void>((r) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        r()
      }
      const timer = setTimeout(() => {
        s.closeAllConnections?.()
        done()
      }, 1000)
      s.close(() => done())
    })
  }
  return { ok: true, code: 'msg.proxy.stopped', data: proxyStatus() }
}

/** 应用配置：写入 store，并按 enabled 决定启停（端口变化会重启） */
export function configureProxy(patch: Partial<ProxyConfig>): Promise<OpResult<ProxyStatus>> {
  return serialLifecycle(() => configureProxyNow(patch))
}

async function configureProxyNow(patch: Partial<ProxyConfig>): Promise<OpResult<ProxyStatus>> {
  // 渲染层入参不可信：非法值落盘后每次启动都会自启失败（字符串端口甚至会被 listen 当成命名管道），故按键白名单收口
  const p = patch ?? {}
  const clean: Partial<ProxyConfig> = {}
  if (typeof p.enabled === 'boolean') clean.enabled = p.enabled
  if (Number.isInteger(p.port) && p.port! >= 1024 && p.port! <= 65535) clean.port = p.port
  if (p.providerId === null || typeof p.providerId === 'string') clean.providerId = p.providerId
  const prev = cfg()
  const next: ProxyConfig = { ...prev, ...clean }
  store.set('proxy', next)
  // 只换转发目标时无需重启：handle 每个请求都实时读取目标；重启会掐断进行中的流式响应
  if (next.enabled && server?.listening && prev.port === next.port) {
    return { ok: true, code: 'msg.proxy.started', args: { port: next.port }, data: proxyStatus() }
  }
  if (next.enabled) return startProxyNow(next.port)
  await stopProxyNow()
  return { ok: true, code: 'msg.proxy.stopped', data: proxyStatus() }
}

/** app 启动时调用：仅在用户曾启用过时自动拉起 */
export async function autoStartProxy(): Promise<void> {
  await serialLifecycle(async () => {
    const c = cfg()
    if (c.enabled) await startProxyNow(c.port)
  })
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

/**
 * token 鉴权：Bearer / x-codeswitch-token / x-api-key / ?token= 四种携带方式。
 * x-api-key 为 Anthropic 客户端唯一自带的鉴权头（Claude Code 等只会把它写进该头），
 * 否则把网关地址填进 ANTHROPIC_BASE_URL 会必然 401，跨协议接入通路走不通。
 * 仅在本机监听 + Host 校验 + 随机 token 前提下接受，上游请求另有真实 Key，不回透。
 */
function isAuthed(req: http.IncomingMessage, url: URL | null): boolean {
  const token = store.get('proxyToken')
  if (!token) return true // 理论上启动时已生成；无 token 时不阻断
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && timingSafeEqualToken(auth.slice(7).trim(), token)) return true
  const x = req.headers['x-codeswitch-token']
  if (typeof x === 'string' && timingSafeEqualToken(x.trim(), token)) return true
  const ak = req.headers['x-api-key']
  if (typeof ak === 'string' && timingSafeEqualToken(ak.trim(), token)) return true
  if (url && timingSafeEqualToken(url.searchParams.get('token') ?? '', token)) return true
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
    // 关键：按原始 Buffer 收集、仅在末尾一次性 concat + toString('utf8') 解码。
    // 切勿在 data 事件里 `data += c`：那会把每个 chunk 独立按 utf8 解码，一个多字节
    // 字符（中文/emoji）跨 TCP chunk 边界时会产生乱码，污染转发出去的请求体（中文 prompt 极常见）。
    // 同时保留 c.length 的字节计数语义（Buffer.length = 字节数，与 setEncoding('utf8') 不同）。
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      if (tooLarge) return // 超限后不再缓冲，仅丢弃后续 chunk（内存已封顶）
      size += c.length
      if (size > MAX_BODY_BYTES) {
        // 不销毁 socket：立即 reject 让 handler 回 413，响应先于连接关闭送达调用方
        tooLarge = true
        chunks.length = 0
        reject(new MaxBodySizeError())
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooLarge) return
      const data = Buffer.concat(chunks).toString('utf8')
      if (!data) return resolve({})
      try {
        const parsed = JSON.parse(data)
        // 只接受对象体：数组/字符串/数字/null 等合法 JSON 但不是合法的 chat 请求体，
        // 若原样放行，下游 `if (!body.model)` 会在 null/primitive 上抹属性抛 TypeError（回 500）。
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) reject(new TypeError('body must be a JSON object'))
        else resolve(parsed)
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

/**
 * token 比对：长度相同才逐字节比，交给 timingSafeEqual（长度不等会抛错，先挡掉）。
 * 本机回环接口下定时侧信道价值极低，但四种携带方式共用一条路径后统一加密比对更严谨。
 */
function timingSafeEqualToken(given: string, expected: string): boolean {
  if (!given || given.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'))
  } catch {
    return false
  }
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
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-codeswitch-token, x-api-key, anthropic-version')
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

  // 入站即 Anthropic 路由时错误体也须是 Anthropic 形状，否则 Claude Code 等客户端只能报“无法解析响应”，看不到真实原因
  const fmt: 'openai' | 'anthropic' = pathname.endsWith('/messages') ? 'anthropic' : 'openai'

  // API 路由需鉴权
  if (!isAuthed(req, url)) return sendError(res, 401, 'invalid or missing access token', fmt)

  const act = activeProvider()
  if (!act) {
    // 密钥不可用/解析失败 -> 502 + 非敏感文案；未选择供应商 -> 503
    if (lastActiveError) return sendError(res, 502, lastActiveError, fmt)
    return sendError(res, 503, 'no target provider selected in CodeSwitch', fmt)
  }

  const ac = new AbortController()
  wireAbort(req, res, ac)

  if (pathname.endsWith('/models')) return handleModels(act, res, ac.signal)
  if (pathname.endsWith('/chat/completions')) return handleChatCompletions(act, req, res, ac.signal)
  if (pathname.endsWith('/messages')) return handleMessages(act, req, res, ac.signal)
  return sendError(res, 404, `unknown route: ${pathname}`, 'openai')
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
      // 同协议透传须带上客户端的版本/beta 头：Claude Code 等请求体里的 beta 字段离开对应头会被上游 400
      const headers: Record<string, string> = { 'x-api-key': act.apiKey, 'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01') }
      const beta = req.headers['anthropic-beta']
      if (beta) headers['anthropic-beta'] = String(beta)
      return await passThrough(`${act.baseUrl}/v1/messages`, headers, body, res, signal)
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
  sendError(res, r.status || 502, text.slice(0, 800) || `upstream returned ${r.status}`, format)
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
