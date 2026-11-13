import { Buffer } from "node:buffer"
import { MAX_RESPONSE_BYTES } from "./constants.mjs"
import { QwenWorkError } from "./errors.mjs"

export async function fetchWithRetry(doFetch, {
  retries = 2,
  retryDelayMs = 1_000,
  shouldRetry = () => true,
  onRetry,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await doFetch(attempt)
      const retryable = response.status >= 500 || response.status === 429
      if (retryable && attempt < retries && shouldRetry(response, undefined)) {
        try { await response.body?.cancel() } catch { /* 已经消费或关闭 */ }
        onRetry?.(attempt + 1, response.status)
        await sleep(retryDelayMs)
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (error?.name === "AbortError" || error?.name === "TimeoutError" || attempt >= retries || !shouldRetry(undefined, error)) throw error
      onRetry?.(attempt + 1, error)
      await sleep(retryDelayMs)
    }
  }
  throw lastError
}

function responseTooLarge(maxBytes) {
  return new QwenWorkError(`QwenWork 上游响应超过 ${maxBytes} 字节限制`, {
    kind: "unavailable",
    status: 502,
    code: "upstream_response_too_large",
  })
}

/**
 * 在解码和字符串聚合之前限制响应字节数；超限必须取消流，而不是读完后截断。
 * Fetch 规范中的空 body（例如 204）直接视为空文本。
 */
export async function readTextLimited(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes 必须是正整数")
  const body = response?.body
  if (!body) return ""
  const declared = Number(response.headers?.get?.("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await body.cancel?.() } catch { /* 已关闭或已锁定 */ }
    throw responseTooLarge(maxBytes)
  }
  const decoder = new TextDecoder()
  let total = 0
  let text = ""
  const append = (chunk) => {
    if (chunk == null) return
    const isString = typeof chunk === "string"
    total += isString ? Buffer.byteLength(chunk) : chunk.byteLength
    if (total > maxBytes) throw responseTooLarge(maxBytes)
    text += isString ? chunk : decoder.decode(chunk, { stream: true })
  }
  const finish = () => {
    text += decoder.decode()
    return text
  }
  if (typeof body.getReader === "function") {
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        append(value)
      }
      return finish()
    } catch (error) {
      try { await reader.cancel(error) } catch { /* 保留原始错误 */ }
      throw error
    } finally {
      try { reader.releaseLock() } catch { /* reader 已释放 */ }
    }
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const iterator = body[Symbol.asyncIterator]()
    try {
      while (true) {
        const { done, value } = await iterator.next()
        if (done) break
        append(value)
      }
      return finish()
    } catch (error) {
      try { await iterator.return?.(error) } catch { /* 保留原始错误 */ }
      throw error
    }
  }
  try { await body.cancel?.() } catch { /* 忽略不支持取消的自定义 body */ }
  throw new QwenWorkError("QwenWork 上游响应 body 不可读取", { kind: "unavailable", status: 502, code: "upstream_body_unreadable" })
}

export function anySignal(signals) {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals)
  // Node 18.0–18.16 没有 AbortSignal.any；保留同样的取消原因并及时解绑。
  const controller = new AbortController()
  const listeners = []
  const cleanup = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener)
    listeners.length = 0
  }
  // 先挂清理监听，覆盖“某个输入 signal 在循环中已 abort”的情况。
  controller.signal.addEventListener("abort", cleanup, { once: true })
  for (const signal of signals) {
    if (controller.signal.aborted) break
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const listener = () => controller.abort(signal.reason)
    signal.addEventListener("abort", listener, { once: true })
    listeners.push([signal, listener])
  }
  return controller.signal
}

export function timeoutSignal(parent, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parent ? anySignal([parent, timeout]) : timeout
}

export function abortableDelay(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", aborted)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
    if (signal?.aborted) aborted()
    else signal?.addEventListener("abort", aborted, { once: true })
  })
}
