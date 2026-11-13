import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import { FIRST_MEANINGFUL_TIMEOUT_MS, MAX_AGGREGATE_BYTES, MAX_SSE_EVENT_BYTES, MAX_TOOL_CALLS, SSE_IDLE_TIMEOUT_MS } from "./constants.mjs"
import { asQwenWorkError, classifyError, errorObject, QwenWorkError } from "./errors.mjs"
import { anySignal } from "./transport.mjs"

const DONE = "data: [DONE]\n\n"
const dataLine = (value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`

function abortReason(signal) {
  return signal?.reason ?? new DOMException("Aborted", "AbortError")
}

function responseTooLarge(description = "上游响应") {
  return new QwenWorkError(`QwenWork ${description}超过大小限制`, {
    kind: "unavailable",
    status: 502,
    code: "upstream_response_too_large",
  })
}

function streamReader(stream) {
  if (typeof stream.getReader === "function") {
    const reader = stream.getReader()
    return {
      next: () => reader.read(),
      cancel: async (reason) => { await reader.cancel(reason) },
      release: () => { try { reader.releaseLock() } catch { /* 已释放 */ } },
    }
  }
  if (typeof stream[Symbol.asyncIterator] === "function") {
    const iterator = stream[Symbol.asyncIterator]()
    return {
      next: () => iterator.next(),
      cancel: async (reason) => { await iterator.return?.(reason) },
      release: () => {},
    }
  }
  throw new QwenWorkError("QwenWork 上游 SSE body 不可读取", { kind: "unavailable", status: 502, code: "upstream_body_unreadable" })
}

async function nextWithIdle(reader, signal, idleTimeoutMs) {
  if (signal?.aborted) throw abortReason(signal)
  let timer
  let onAbort
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal))
    signal?.addEventListener("abort", onAbort, { once: true })
    if (idleTimeoutMs > 0) {
      timer = setTimeout(() => reject(new QwenWorkError(`QwenWork 上游 ${Math.ceil(idleTimeoutMs / 1000)} 秒内没有返回数据`, {
        kind: "unavailable",
        status: 504,
        code: "upstream_idle_timeout",
      })), idleTimeoutMs)
    }
  })
  try {
    return await Promise.race([reader.next(), interrupted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

/** 按 SSE event 解析，限制单帧内存，并让等待数据时的超时/abort 取消底层 reader。 */
export async function* readSseData(stream, {
  signal,
  idleTimeoutMs = SSE_IDLE_TIMEOUT_MS,
  maxEventBytes = MAX_SSE_EVENT_BYTES,
} = {}) {
  if (!stream) return
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) throw new TypeError("maxEventBytes 必须是正整数")
  const reader = streamReader(stream)
  const decoder = new TextDecoder()
  let buffer = ""
  let bufferedBytes = 0
  let finished = false
  const drain = function* (final = false) {
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer)
      if (!match) break
      const event = buffer.slice(0, match.index)
      const eventBytes = Buffer.byteLength(event)
      if (eventBytes > maxEventBytes) throw responseTooLarge("SSE 事件")
      buffer = buffer.slice(match.index + match[0].length)
      bufferedBytes -= eventBytes + Buffer.byteLength(match[0])
      const lines = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, ""))
      if (lines.length) yield lines.join("\n")
    }
    if (bufferedBytes > maxEventBytes) throw responseTooLarge("未完成的 SSE 事件")
    if (final && buffer.trim()) {
      const lines = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, ""))
      if (lines.length) yield lines.join("\n")
      buffer = ""
      bufferedBytes = 0
    }
  }
  try {
    while (true) {
      const { done, value: chunk } = await nextWithIdle(reader, signal, idleTimeoutMs)
      if (done) break
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
      buffer += text
      bufferedBytes += Buffer.byteLength(text)
      yield* drain()
    }
    const text = decoder.decode()
    buffer += text
    bufferedBytes += Buffer.byteLength(text)
    finished = true
    yield* drain(true)
  } finally {
    if (!finished) {
      try { await reader.cancel(abortReason(signal)) } catch { /* 保留解析/超时错误 */ }
    }
    reader.release()
  }
}

function parseJson(value) {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) } catch { return value }
}

function meaningfulChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return false
  if (chunk.usage != null) return true
  if (!Array.isArray(chunk.choices)) return false
  return chunk.choices.some((choice) => {
    const delta = choice?.delta ?? choice?.message ?? {}
    return (typeof delta.content === "string" && delta.content.length > 0) ||
      (Array.isArray(delta.content) && delta.content.length > 0) ||
      (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) ||
      (typeof delta.reasoning === "string" && delta.reasoning.length > 0) ||
      (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) ||
      choice?.finish_reason != null
  })
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return usage
  const out = { ...usage }
  const prompt = Number(out.prompt_tokens)
  const completion = Number(out.completion_tokens)
  if (out.total_tokens == null && Number.isFinite(prompt) && Number.isFinite(completion)) out.total_tokens = prompt + completion
  return out
}

function decodeFrame(data) {
  if (data.trim() === "[DONE]") return { done: true }
  const outer = parseJson(data)
  if (typeof outer === "string") {
    const classified = classifyError(200, outer)
    if (classified) return { error: classified }
    return {}
  }
  if (!outer || typeof outer !== "object") return { error: new QwenWorkError("QwenWork 上游数据帧为空") }

  const wrapped = Object.hasOwn(outer, "body")
  const status = wrapped ? Number(outer.statusCodeValue) || 200 : 200
  let body = wrapped ? outer.body : outer
  if (typeof body === "string") {
    const trimmed = body.trim()
    if (!trimmed || trimmed === "null" || trimmed === "{}") return {}
    if (trimmed === "[DONE]") return { done: true }
    if (status < 300) {
      const classified = classifyError(200, trimmed)
      if (classified) return { error: classified }
    }
  }
  body = parseJson(body)
  if (status >= 300) return { error: asQwenWorkError(status, body) }
  if (body == null || (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)) return {}
  if (typeof body === "string") {
    const classified = classifyError(status, body)
    return classified ? { error: classified } : {}
  }
  if (!body || typeof body !== "object") return {}
  const classified = classifyError(status, body)
  if (classified) return { error: classified }
  if (body.error && typeof body.error === "object") {
    return { error: new QwenWorkError(String(body.error.message ?? "QwenWork 上游错误"), {
      kind: body.error.kind ?? body.error.type ?? "unavailable",
      status: Number(body.error.status) || 502,
      code: String(body.error.code ?? ""),
    }) }
  }
  return { chunk: body }
}

/**
 * 双层 SSE → OpenAI chunk。首个有效内容前抛错，让调用方仍能返回 HTTP 错误；
 * 已有内容后则发送 OpenAI error chunk + [DONE]，避免把半条回答变成网络重置。
 */
export async function* qwenSseToOpenAi(stream, {
  model = "qwork-advanced",
  signal,
  idleTimeoutMs = SSE_IDLE_TIMEOUT_MS,
  maxEventBytes = MAX_SSE_EVENT_BYTES,
} = {}) {
  const id = `chatcmpl-qwenwork-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  let sawMeaningful = false
  let sawFinish = false
  let sawTools = false
  let roleSent = false
  try {
    for await (const data of readSseData(stream, { signal, idleTimeoutMs, maxEventBytes })) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
    const frame = decodeFrame(data)
    if (!frame.error && !frame.done && !frame.chunk) continue
    if (frame.error) {
      if (!sawMeaningful) throw frame.error
      yield dataLine(errorObject(frame.error))
      yield DONE
      return
    }
    if (frame.done) {
      if (!sawMeaningful) throw new QwenWorkError("QwenWork 上游未返回有效内容", { kind: "unavailable", status: 502, code: "upstream_empty" })
      break
    }
    const raw = frame.chunk
    const meaningful = meaningfulChunk(raw)
    const choices = Array.isArray(raw.choices) ? raw.choices.map((choice, index) => {
      const delta = choice?.delta && typeof choice.delta === "object" ? { ...choice.delta } : choice?.message && typeof choice.message === "object" ? { ...choice.message } : {}
      if (meaningful && !roleSent && !delta.role) delta.role = "assistant"
      if (choice?.finish_reason != null) sawFinish = true
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) sawTools = true
      return { ...choice, index: Number.isInteger(choice?.index) ? choice.index : index, delta }
    }) : []
    if (meaningful) {
      sawMeaningful = true
      roleSent = true
    }
    const chunk = {
      ...raw,
      id: typeof raw.id === "string" && raw.id ? raw.id : id,
      object: "chat.completion.chunk",
      created: Number.isFinite(raw.created) ? raw.created : created,
      model: typeof raw.model === "string" && raw.model ? raw.model : model,
      choices,
      ...(raw.usage ? { usage: normalizeUsage(raw.usage) } : {}),
    }
    yield dataLine(chunk)
    }
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal)
    if (!sawMeaningful) throw error
    yield dataLine(errorObject(error))
    yield DONE
    return
  }
  if (!sawMeaningful) throw new QwenWorkError("QwenWork 上游连接结束但没有有效内容", { kind: "unavailable", status: 502, code: "upstream_empty" })
  if (!sawFinish) {
    yield dataLine({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: sawTools ? "tool_calls" : "stop" }],
    })
  }
  yield DONE
}

function meaningfulSse(text) {
  if (!text.startsWith("data:") || text.includes("[DONE]")) return false
  try { return meaningfulChunk(JSON.parse(text.slice(5).trim())) } catch { return false }
}

/** 预读只限制“等首段有效内容”的 30 秒；开始输出后不再设置总时长。 */
export async function prepareOpenAiStream(stream, {
  model,
  signal,
  timeoutMs = FIRST_MEANINGFUL_TIMEOUT_MS,
  idleTimeoutMs = SSE_IDLE_TIMEOUT_MS,
  maxEventBytes = MAX_SSE_EVENT_BYTES,
  maxBufferedBytes = MAX_AGGREGATE_BYTES,
} = {}) {
  const controller = new AbortController()
  const linkedSignal = anySignal([signal, controller.signal].filter(Boolean))
  const iterator = qwenSseToOpenAi(stream, { model, signal: linkedSignal, idleTimeoutMs, maxEventBytes })[Symbol.asyncIterator]()
  const buffered = []
  let bufferedBytes = 0
  let closed = false
  const cancel = async (reason) => {
    if (closed) return
    closed = true
    const cause = reason instanceof Error ? reason : new DOMException("Aborted", "AbortError")
    if (!controller.signal.aborted) controller.abort(cause)
    try { await iterator.return?.(cause) } catch { /* 保留触发取消的原始错误 */ }
  }
  const prepared = { iterator, buffered, cancel }
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs) })
  try {
    while (true) {
      const result = await Promise.race([iterator.next(), timeout])
      if (result === "timeout") throw new QwenWorkError(`QwenWork 上游 ${Math.ceil(timeoutMs / 1000)} 秒内没有返回有效内容`, { kind: "unavailable", status: 504, code: "upstream_first_chunk_timeout" })
      if (result.done) break
      const size = Buffer.byteLength(result.value)
      if (bufferedBytes + size > maxBufferedBytes) throw responseTooLarge("首段预读数据")
      bufferedBytes += size
      buffered.push(result.value)
      if (meaningfulSse(result.value)) return prepared
    }
    throw new QwenWorkError("QwenWork 上游空响应", { kind: "unavailable", status: 502, code: "upstream_empty" })
  } catch (error) {
    await cancel(error)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function* replayPrepared(prepared) {
  try {
    for (const chunk of prepared.buffered) yield chunk
    while (true) {
      const result = await prepared.iterator.next()
      if (result.done) return
      yield result.value
    }
  } finally {
    await prepared.cancel?.()
  }
}

export function streamResponse(prepared) {
  const iterable = replayPrepared(prepared)
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const result = await iterable.next()
        if (result.done) controller.close()
        else controller.enqueue(new TextEncoder().encode(result.value))
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      await iterable.return?.(reason)
      await prepared.cancel?.(reason)
    },
  })
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" },
  })
}

function chunkFromSse(text) {
  if (!text.startsWith("data:") || text.includes("[DONE]")) return undefined
  try { return JSON.parse(text.slice(5).trim()) } catch { return undefined }
}

export async function aggregatePrepared(prepared, fallbackModel, {
  maxBytes = MAX_AGGREGATE_BYTES,
  maxToolCalls = MAX_TOOL_CALLS,
} = {}) {
  let id = `chatcmpl-qwenwork-${randomUUID()}`
  let created = Math.floor(Date.now() / 1000)
  let model = fallbackModel
  let content = ""
  let reasoning = ""
  let finishReason = null
  let usage
  let accumulatedBytes = 0
  const tools = new Map()
  const append = (current, value) => {
    if (!value) return current
    const text = String(value)
    accumulatedBytes += Buffer.byteLength(text)
    if (accumulatedBytes > maxBytes) throw responseTooLarge("非流式聚合内容")
    return current + text
  }
  for await (const event of replayPrepared(prepared)) {
    const chunk = chunkFromSse(event)
    if (!chunk) continue
    if (chunk.error) throw new QwenWorkError(chunk.error.message, {
      kind: chunk.error.kind ?? chunk.error.type,
      status: chunk.error.status,
      code: chunk.error.code,
    })
    if (chunk.id) id = chunk.id
    if (chunk.created) created = chunk.created
    if (chunk.model) model = chunk.model
    if (chunk.usage) usage = normalizeUsage(chunk.usage)
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (typeof delta.content === "string") content = append(content, delta.content)
    else if (Array.isArray(delta.content)) content = append(content, delta.content.map((part) => part?.text ?? "").join(""))
    if (typeof delta.reasoning_content === "string") reasoning = append(reasoning, delta.reasoning_content)
    else if (typeof delta.reasoning === "string") reasoning = append(reasoning, delta.reasoning)
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isInteger(call.index) ? call.index : 0
      if (!tools.has(index) && tools.size >= maxToolCalls) {
        throw new QwenWorkError("QwenWork 上游工具调用数量超过限制", { kind: "unavailable", status: 502, code: "upstream_too_many_tool_calls" })
      }
      const previous = tools.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } }
      if (call.id) previous.id = append("", call.id)
      if (call.type) previous.type = append("", call.type)
      if (call.function?.name) previous.function.name = append(previous.function.name, call.function.name)
      if (typeof call.function?.arguments === "string") previous.function.arguments = append(previous.function.arguments, call.function.arguments)
      tools.set(index, previous)
    }
    if (choice.finish_reason != null) finishReason = choice.finish_reason
  }
  const toolCalls = [...tools.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
  const message = {
    role: "assistant",
    content: content || (toolCalls.length ? null : ""),
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  }
  return Response.json({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? (toolCalls.length ? "tool_calls" : "stop") }],
    ...(usage ? { usage } : {}),
  })
}
