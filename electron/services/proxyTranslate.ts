/**
 * 转发网关的纯协议转换函数（OpenAI ↔ Anthropic）。
 * 独立成模块、不依赖 Electron，便于单元测试与复用。
 *
 * 能力说明（Alex-M1）：
 *  - 纯文本对话：双向完整支持（含流式 SSE）。
 *  - 工具调用：非流式请求/响应已补充 tools / tool_choice / tool_use / tool_result
 *    的双向映射（见下方各 *Req / *Resp 函数）。
 *  - 已知限制：流式（SSE）场景下的工具调用增量分片（OpenAI delta.tool_calls 与
 *    Anthropic input_json_delta）尚未做逐块拼装，流式仅保证纯文本正确。若客户端在流式
 *    下依赖工具调用，请改用非流式（README 与「项目开发文档」同处说明该边界）。
 */

/** OpenAI 停止原因 → Anthropic */
export function mapFinish(reason: string | null | undefined): string {
  if (reason === 'length') return 'max_tokens'
  if (reason === 'tool_calls') return 'tool_use'
  return 'end_turn'
}

/** Anthropic 停止原因 → OpenAI */
export function mapStop(reason: string | null | undefined): string {
  if (reason === 'max_tokens') return 'length'
  if (reason === 'tool_use') return 'tool_calls'
  return 'stop'
}

/** 安全解析 JSON 字符串为对象（工具调用 arguments 常为字符串） */
function safeParse(s: unknown): any {
  if (s == null) return {}
  if (typeof s === 'object') return s
  try {
    return JSON.parse(String(s))
  } catch {
    return {}
  }
}

/** 把任意 content 归一为纯文本（数组则拼接其中 text 部分） */
function contentToText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text ?? '' : ''))
      .join('')
  }
  return ''
}

/** OpenAI tools → Anthropic tools */
function openaiToolsToAnthropic(tools: any): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out: any[] = []
  for (const t of tools) {
    const fn = t?.function ?? t
    if (!fn?.name) continue
    out.push({ name: fn.name, description: fn.description ?? '', input_schema: fn.parameters ?? { type: 'object', properties: {} } })
  }
  return out.length ? out : undefined
}

/** Anthropic tools → OpenAI tools */
function anthropicToolsToOpenai(tools: any): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out = tools
    .filter((t: any) => t?.name)
    .map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } } }))
  return out.length ? out : undefined
}

/** OpenAI tool_choice → Anthropic tool_choice。
 * 注意：Anthropic 无 `none`；`none` 必须在调用方通过「不传 tools」实现，绝不能映射成 auto（否则工具仍可用）。 */
function openaiToolChoiceToAnthropic(tc: any): any {
  if (tc == null || tc === 'none') return undefined
  if (tc === 'auto') return { type: 'auto' }
  if (tc === 'required') return { type: 'any' }
  if (typeof tc === 'object' && tc.type === 'function' && tc.function?.name) return { type: 'tool', name: tc.function.name }
  return undefined
}

/** Anthropic tool_choice → OpenAI tool_choice */
function anthropicToolChoiceToOpenai(tc: any): any {
  if (!tc || typeof tc !== 'object') return undefined
  if (tc.type === 'auto') return 'auto'
  if (tc.type === 'any') return 'required'
  if (tc.type === 'none') return 'none'
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } }
  return undefined
}

/** OpenAI chat 请求 → Anthropic messages 请求（含 tools / tool_choice / tool_calls / tool 结果映射） */
export function openaiToAnthropicReq(body: any, fallbackModel: string): any {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : []
  const systemParts: string[] = []
  const msgs: any[] = []
  for (const m of messages) {
    const role = m.role
    if (role === 'system') {
      systemParts.push(contentToText(m.content))
      continue
    }
    if (role === 'assistant') {
      const blocks: any[] = []
      const text = contentToText(m.content)
      if (text) blocks.push({ type: 'text', text })
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        blocks.push({ type: 'tool_use', id: tc.id ?? `toolu_${Math.random().toString(36).slice(2)}`, name: tc.function?.name ?? '', input: safeParse(tc.function?.arguments) })
      }
      msgs.push({ role: 'assistant', content: blocks.length ? blocks : text })
      continue
    }
    if (role === 'tool') {
      // OpenAI 的 tool 结果 → Anthropic 的 user/tool_result
      msgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: contentToText(m.content) || (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')) }]
      })
      continue
    }
    // user（含多模态数组，仅取文本部分）
    msgs.push({ role: 'user', content: Array.isArray(m.content) ? contentToText(m.content) : m.content })
  }
  const req: any = {
    model: body.model || fallbackModel,
    messages: msgs,
    max_tokens: body.max_tokens ?? 4096,
    stream: !!body.stream
  }
  if (systemParts.length) req.system = systemParts.join('\n')
  if (typeof body.temperature === 'number') req.temperature = body.temperature
  if (typeof body.top_p === 'number') req.top_p = body.top_p
  if (body.stop) req.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  // tool_choice=none：Anthropic 无对应枚举，等价做法是不附带 tools（否则映射成 auto 会让模型仍可调工具）
  if (body.tool_choice !== 'none') {
    const tools = openaiToolsToAnthropic(body.tools)
    if (tools) req.tools = tools
    const tc = openaiToolChoiceToAnthropic(body.tool_choice)
    if (tc) req.tool_choice = tc
  }
  return req
}

/** Anthropic messages 请求 → OpenAI chat 请求（含 tools / tool_choice / tool_use / tool_result 映射） */
export function anthropicToOpenaiReq(body: any, fallbackModel: string): any {
  const msgs: any[] = []
  if (body.system) msgs.push({ role: 'system', content: contentToText(body.system) })
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    if (typeof m.content === 'string') {
      msgs.push({ role, content: m.content })
      continue
    }
    if (!Array.isArray(m.content)) {
      msgs.push({ role, content: '' })
      continue
    }
    if (role === 'assistant') {
      const text = contentToText(m.content)
      const toolCalls = m.content
        .filter((b: any) => b?.type === 'tool_use')
        .map((b: any) => ({ id: b.id ?? '', type: 'function', function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) } }))
      const msg: any = { role: 'assistant', content: text || null }
      if (toolCalls.length) msg.tool_calls = toolCalls
      msgs.push(msg)
      continue
    }
    // user：可能同时含 text 与 tool_result
    const toolResults = m.content.filter((b: any) => b?.type === 'tool_result')
    for (const tr of toolResults) {
      msgs.push({ role: 'tool', tool_call_id: tr.tool_use_id ?? '', content: contentToText(tr.content) || (typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? '')) })
    }
    const text = contentToText(m.content)
    if (text || toolResults.length === 0) msgs.push({ role: 'user', content: text })
  }
  const req: any = { model: body.model || fallbackModel, messages: msgs, stream: !!body.stream }
  if (body.max_tokens) req.max_tokens = body.max_tokens
  if (typeof body.temperature === 'number') req.temperature = body.temperature
  if (typeof body.top_p === 'number') req.top_p = body.top_p
  if (body.stop_sequences) req.stop = body.stop_sequences
  const tools = anthropicToolsToOpenai(body.tools)
  if (tools) req.tools = tools
  const tc = anthropicToolChoiceToOpenai(body.tool_choice)
  if (tc !== undefined) req.tool_choice = tc
  return req
}

/** Anthropic 非流式响应 → OpenAI chat.completion（含 tool_use → tool_calls） */
export function anthropicRespToOpenai(r: any, model: string): any {
  const blocks = Array.isArray(r.content) ? r.content : []
  const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
  const toolCalls = blocks
    .filter((b: any) => b.type === 'tool_use')
    .map((b: any) => ({ id: b.id ?? '', type: 'function', function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) } }))
  const message: any = { role: 'assistant', content: text || (toolCalls.length ? null : '') }
  if (toolCalls.length) message.tool_calls = toolCalls
  const inTok = r.usage?.input_tokens ?? 0
  const outTok = r.usage?.output_tokens ?? 0
  return {
    id: r.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: r.model || model,
    choices: [{ index: 0, message, finish_reason: mapStop(r.stop_reason) }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok }
  }
}

/** OpenAI chat.completion 响应 → Anthropic message（含 tool_calls → tool_use） */
export function openaiRespToAnthropic(r: any): any {
  const choice = r.choices?.[0]
  const msg = choice?.message ?? {}
  const text = msg.content ?? ''
  const content: any[] = []
  if (text) content.push({ type: 'text', text })
  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    content.push({ type: 'tool_use', id: tc.id ?? `toolu_${Math.random().toString(36).slice(2)}`, name: tc.function?.name ?? '', input: safeParse(tc.function?.arguments) })
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return {
    id: r.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: r.model,
    content,
    stop_reason: mapFinish(choice?.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: r.usage?.prompt_tokens ?? 0, output_tokens: r.usage?.completion_tokens ?? 0 }
  }
}

/** 组装一条 OpenAI 流式分片（SSE data 行） */
export function openaiChunk(delta: any, model: string, id: string): string {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }]
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 组装一条 Anthropic 流式事件（SSE event+data 行） */
export function anthEvent(name: string, data: any): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * 流式 SSE 转换所需的最小响应/流接口（结构化，便于脱离 Electron 单测）。
 * http.ServerResponse 与 Node Readable 均结构化兼容。
 */
export interface SseResponse {
  writeHead(status: number, headers: Record<string, string>): unknown
  write(chunk: string): unknown
  end(): unknown
  writableEnded: boolean
}
export interface SseStream {
  setEncoding(enc: string): unknown
  on(ev: string, cb: (...args: any[]) => void): unknown
}

export function sseSetup(res: SseResponse): void {
  // 不写 Access-Control-Allow-Origin：受控 CORS 已由 proxy.ts 的 applyCors 按本机 Origin 回显，
  // 若此处补 '*' 会覆盖那道收紧（writeHead 的同名头优先级高于 setHeader），等于把 SSE 响应又放开到任意站点。
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
}

/** 逐行解析 SSE 流，回调每条 data 载荷 */
export function consumeSSE(stream: SseStream, onData: (payload: string) => void, onEnd: () => void): void {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (ch: string) => {
    buf += ch
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (line.startsWith('data:')) {
        const d = line.slice(5).trim()
        if (d) onData(d)
      }
    }
  })
  stream.on('end', onEnd)
  stream.on('error', onEnd)
}

/** 上游 Anthropic SSE → 下游 OpenAI SSE（纯文本；流式工具调用增量未映射，见文件头限制说明） */
export function anthropicStreamToOpenai(stream: SseStream, res: SseResponse, model: string): void {
  sseSetup(res)
  const id = `chatcmpl-${Date.now()}`
  res.write(openaiChunk({ role: 'assistant', content: '' }, model, id))
  consumeSSE(
    stream,
    (d) => {
      let ev: any
      try {
        ev = JSON.parse(d)
      } catch {
        return
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        res.write(openaiChunk({ content: ev.delta.text }, model, id))
      } else if (ev.type === 'message_stop') {
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }
    },
    () => {
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }
  )
}

/** 上游 OpenAI SSE → 下游 Anthropic SSE（纯文本；流式工具调用增量未映射，见文件头限制说明） */
export function openaiStreamToAnthropic(stream: SseStream, res: SseResponse, model: string): void {
  sseSetup(res)
  const id = `msg_${Date.now()}`
  res.write(
    anthEvent('message_start', {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
    })
  )
  res.write(anthEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  let done = false
  const finish = () => {
    if (done || res.writableEnded) return
    done = true
    res.write(anthEvent('content_block_stop', { type: 'content_block_stop', index: 0 }))
    res.write(anthEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }))
    res.write(anthEvent('message_stop', { type: 'message_stop' }))
    res.end()
  }
  consumeSSE(
    stream,
    (d) => {
      if (d === '[DONE]') return finish()
      let ev: any
      try {
        ev = JSON.parse(d)
      } catch {
        return
      }
      const delta = ev.choices?.[0]?.delta?.content
      if (delta) res.write(anthEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } }))
      if (ev.choices?.[0]?.finish_reason) finish()
    },
    finish
  )
}
