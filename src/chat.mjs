import { PATHS, siteFor } from "./constants.mjs"
import { buildChatBody } from "./payload.mjs"
import { signedHeaders } from "./cosy.mjs"
import { asQwenWorkError, classifyError, errorResponse, QwenWorkError } from "./errors.mjs"
import { fetchWithRetry, readTextLimited } from "./transport.mjs"
import { aggregatePrepared, prepareOpenAiStream, streamResponse } from "./sse.mjs"

function modelLimit(entries, model) {
  const entry = Array.isArray(entries) ? entries.find((item) => item.id === model) : undefined
  return Number.isFinite(entry?.maxTokens) && entry.maxTokens > 0 ? entry.maxTokens : 0
}

async function requestUpstream({ site, credential, endpoint, encoded, model, signal, fetchFn }) {
  return fetchWithRetry(() => fetchFn(endpoint, {
    method: "POST",
    headers: signedHeaders({
      site,
      credential,
      body: encoded,
      endpoint,
      model,
      accept: "text/event-stream",
    }),
    body: encoded,
    signal,
  }), { retries: 0 }) // 聊天 POST 不做通用重试；只允许 chat() 在首段输出前进行一次认证刷新重试。
}

function directCompletionResponse(value, model, stream) {
  const id = value.id || `chatcmpl-qwenwork-${Date.now()}`
  const created = Number.isFinite(value.created) ? value.created : Math.floor(Date.now() / 1000)
  if (!stream) {
    return Response.json({ ...value, id, object: "chat.completion", created, model: value.model || model }, { status: 200 })
  }
  const choices = value.choices.map((choice, index) => ({
    index: Number.isInteger(choice?.index) ? choice.index : index,
    delta: choice?.delta ?? choice?.message ?? {},
    finish_reason: choice?.finish_reason ?? null,
  }))
  const chunk = { ...value, id, object: "chat.completion.chunk", created, model: value.model || model, choices }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  })
}

/**
 * Magpie SDK 的 OpenAI 请求在此接管。无论调用方 stream 与否，上游都按 SSE 请求；
 * 非流式在本地聚合，流式则保留 delta 与 tool_calls。
 */
export async function chat({ credential, body, signal, renew, fetchFn = fetch, catalogEntries = [] }) {
  const site = siteFor(credential.region)
  const model = String(body?.model ?? "").trim() || site.defaultModel
  const upstreamBody = buildChatBody(body ?? {}, model, modelLimit(catalogEntries, model))
  const encoded = JSON.stringify(upstreamBody)
  const endpoint = `${site.gateway}${PATHS.chat}`
  let activeCredential = credential
  let authRetried = false

  while (true) {
    try {
      const response = await requestUpstream({ site, credential: activeCredential, endpoint, encoded, model, signal, fetchFn })
      if (!response.ok) {
        const text = await readTextLimited(response)
        const error = asQwenWorkError(response.status, text)
        if (error.kind === "auth" && !authRetried && typeof renew === "function") {
          authRetried = true
          activeCredential = await renew()
          continue
        }
        return errorResponse(error)
      }
      const contentType = response.headers.get("content-type") ?? ""
      if (!/text\/event-stream/i.test(contentType)) {
        const text = await readTextLimited(response)
        let value
        try { value = JSON.parse(text) } catch {
          return errorResponse(new QwenWorkError("QwenWork 上游返回了非 SSE、非 JSON 响应", { kind: "unavailable", code: "upstream_invalid_content_type" }))
        }
        const classified = classifyError(200, value)
        if (classified) {
          if (classified.kind === "auth" && !authRetried && typeof renew === "function") {
            authRetried = true
            activeCredential = await renew()
            continue
          }
          return errorResponse(classified)
        }
        if (!value || !Array.isArray(value.choices)) {
          return errorResponse(new QwenWorkError("QwenWork 上游 JSON 响应缺少 choices", { kind: "unavailable", code: "upstream_invalid_json_completion" }))
        }
        return directCompletionResponse(value, model, body?.stream === true)
      }
      let prepared
      try {
        prepared = await prepareOpenAiStream(response.body, { model, signal })
      } catch (error) {
        if (error?.kind === "auth" && !authRetried && typeof renew === "function") {
          authRetried = true
          activeCredential = await renew()
          continue
        }
        throw error
      }
      return body?.stream === true ? streamResponse(prepared) : await aggregatePrepared(prepared, model)
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error
      return errorResponse(error instanceof QwenWorkError ? error : new QwenWorkError(String(error?.message ?? error), {
        kind: "unavailable",
        status: 502,
        code: "upstream_network_error",
        cause: error,
      }))
    }
  }
}
