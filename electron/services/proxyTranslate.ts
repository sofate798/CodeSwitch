/**
 * 转发网关的纯协议转换函数（OpenAI ↔ Anthropic）。
 * 独立成模块、不依赖 Electron，便于单元测试与复用。
 */

/** OpenAI 停止原因 → Anthropic */
export function mapFinish(reason: string | null | undefined): string {
  if (reason === 'length') return 'max_tokens'
  return 'end_turn'
}

/** Anthropic 停止原因 → OpenAI */
export function mapStop(reason: string | null | undefined): string {
  if (reason === 'max_tokens') return 'length'
  return 'stop'
}

/** OpenAI chat 请求 → Anthropic messages 请求 */
export function openaiToAnthropicReq(body: any, fallbackModel: string): any {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : []
  const systemParts: string[] = []
  const msgs: any[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    } else {
      msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
    }
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
  return req
}

/** Anthropic messages 请求 → OpenAI chat 请求 */
export function anthropicToOpenaiReq(body: any, fallbackModel: string): any {
  const msgs: any[] = []
  if (body.system) msgs.push({ role: 'system', content: typeof body.system === 'string' ? body.system : JSON.stringify(body.system) })
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    msgs.push({ role: m.role, content: m.content })
  }
  const req: any = { model: body.model || fallbackModel, messages: msgs, stream: !!body.stream }
  if (body.max_tokens) req.max_tokens = body.max_tokens
  if (typeof body.temperature === 'number') req.temperature = body.temperature
  if (typeof body.top_p === 'number') req.top_p = body.top_p
  if (body.stop_sequences) req.stop = body.stop_sequences
  return req
}

/** Anthropic 非流式响应 → OpenAI chat.completion */
export function anthropicRespToOpenai(r: any, model: string): any {
  const text = (r.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
  const inTok = r.usage?.input_tokens ?? 0
  const outTok = r.usage?.output_tokens ?? 0
  return {
    id: r.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: r.model || model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: mapStop(r.stop_reason) }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok }
  }
}

/** OpenAI chat.completion 响应 → Anthropic message */
export function openaiRespToAnthropic(r: any): any {
  const choice = r.choices?.[0]
  const text = choice?.message?.content ?? ''
  return {
    id: r.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: r.model,
    content: [{ type: 'text', text }],
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
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*'
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

/** 上游 Anthropic SSE → 下游 OpenAI SSE */
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

/** 上游 OpenAI SSE → 下游 Anthropic SSE */
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
