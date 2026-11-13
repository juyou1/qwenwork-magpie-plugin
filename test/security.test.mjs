import test from "node:test"
import assert from "node:assert/strict"
import { QwenWorkPlugin } from "../index.mjs"
import { chat } from "../src/chat.mjs"
import { QwenWorkError, redactSensitive } from "../src/errors.mjs"
import { readTextLimited } from "../src/transport.mjs"
import { aggregatePrepared, prepareOpenAiStream, readSseData, streamResponse } from "../src/sse.mjs"

const credential = {
  access_token: "at-security-test",
  refresh_token: "rt-security-test",
  expires_at: Date.now() + 3_600_000,
  uid: "security-test-user",
  machine_id: "11111111-2222-4333-8444-555555555555",
  region: "global",
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const frame = (delta, extra = {}) => `data:${JSON.stringify({ choices: [{ index: 0, delta, ...extra }] })}\n\n`
const sse = (text) => new Response(text, { headers: { "content-type": "text/event-stream" } })
const bytes = (text) => new TextEncoder().encode(text)

async function collect(iterable) {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}

function pendingStream(onCancel) {
  return new ReadableStream({
    pull() {},
    cancel(reason) { onCancel?.(reason) },
  })
}

test("错误、日志和 OAuth 展示统一脱敏且限制长度", async () => {
  const secrets = ["rt-leaked", "at-leaked", "oauth-code-leaked", "pkce-leaked", "cosy-leaked"]
  const original = JSON.stringify({
    refresh_token: secrets[0],
    access: secrets[1],
    url: `https://example.test/callback?code=${secrets[2]}&verifier=${secrets[3]}`,
    authorization: `Bearer ${secrets[4]}`,
    code: "rate_limit",
  })
  const redacted = redactSensitive(original)
  for (const secret of secrets) assert.equal(redacted.includes(secret), false)
  assert.equal(JSON.parse(redacted).code, "rate_limit")
  assert.equal(redactSensitive(JSON.stringify({ code: "oauth-code-leaked" })).includes("oauth-code-leaked"), false)
  assert.equal(JSON.parse(redactSensitive(JSON.stringify({ code: "14018" }))).code, "14018")
  assert.ok(new QwenWorkError("x".repeat(4000)).message.length <= 2000)

  const logs = []
  const plugin = await QwenWorkPlugin({
    client: { app: { log: (entry) => logs.push(entry) }, auth: { set: async () => {} } },
    fetch: async () => json({ message: "upstream failed refresh_token=rt-leaked access_token=at-leaked" }, 400),
  })
  const models = await plugin.provider.models({}, { auth: { access: "at-security-test", refresh: "rt-security-test", expires: Date.now() + 3_600_000 } })
  assert.ok(Object.keys(models).length > 0)
  const logText = logs.map((entry) => entry.message).join("\n")
  assert.ok(logs.length > 0)
  assert.equal(logText.includes("rt-leaked"), false)
  assert.equal(logText.includes("at-leaked"), false)
})

test("普通 JSON 响应按字节拒绝超限并取消 reader", async () => {
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(bytes("x".repeat(64))) },
    cancel() { cancelled = true },
  })
  await assert.rejects(readTextLimited(new Response(body), 32), (error) => error.code === "upstream_response_too_large")
  assert.equal(cancelled, true)

  const asyncBody = (async function* () { yield "x".repeat(64) })()
  await assert.rejects(readTextLimited({ body: asyncBody, headers: new Headers() }, 32), (error) => error.code === "upstream_response_too_large")
})

test("非 SSE 上游错误也经过有界读取和脱敏", async () => {
  const secret = "rt-non-sse-leaked"
  const response = await chat({
    credential,
    body: { model: "qwork-advanced", messages: [] },
    fetchFn: async () => new Response(JSON.stringify({ message: `failed refresh_token=${secret}` }), { status: 400, headers: { "content-type": "application/json" } }),
  })
  assert.equal(response.status, 400)
  const text = await response.text()
  assert.equal(text.includes(secret), false)
})

test("SSE 单帧和未完成帧都有字节上限", async () => {
  await assert.rejects(collect(readSseData(sse(`data:${"x".repeat(64)}\n\n`).body, { maxEventBytes: 32 })), (error) => error.code === "upstream_response_too_large")
  let cancelled = false
  const body = new ReadableStream({
    start(controller) { controller.enqueue(bytes(`data:${"x".repeat(64)}`)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(collect(readSseData(body, { maxEventBytes: 32 })), (error) => error.code === "upstream_response_too_large")
  assert.equal(cancelled, true)
})

test("SSE 空闲超时与首段超时都会取消底层 reader", async () => {
  let idleCancelled = false
  await assert.rejects(collect(readSseData(pendingStream(() => { idleCancelled = true }), { idleTimeoutMs: 20 })), (error) => error.code === "upstream_idle_timeout")
  assert.equal(idleCancelled, true)

  let firstCancelled = false
  await assert.rejects(prepareOpenAiStream(pendingStream(() => { firstCancelled = true }), { timeoutMs: 20, idleTimeoutMs: 1000 }), (error) => error.code === "upstream_first_chunk_timeout")
  assert.equal(firstCancelled, true)
})

test("首段输出后不被首段总超时误杀，后续分片仍能到达", async () => {
  let timer
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes(frame({ content: "first" })))
      timer = setTimeout(() => {
        controller.enqueue(bytes(`${frame({ content: "second" })}data:[DONE]\n\n`))
        controller.close()
      }, 35)
    },
    cancel() { clearTimeout(timer) },
  })
  const prepared = await prepareOpenAiStream(body, { timeoutMs: 5, idleTimeoutMs: 500 })
  const response = streamResponse(prepared)
  const text = await response.text()
  assert.match(text, /first/)
  assert.match(text, /second/)
  assert.match(text, /\[DONE\]/)
})

test("首段后读取错误以 error chunk 结束而不是静默重置", async () => {
  let cancelled = false
  const body = new ReadableStream({
    start(controller) { controller.enqueue(bytes(frame({ content: "partial" }))) },
    cancel() { cancelled = true },
  })
  const prepared = await prepareOpenAiStream(body, { timeoutMs: 100, idleTimeoutMs: 20 })
  const text = await streamResponse(prepared).text()
  assert.match(text, /upstream_idle_timeout/)
  assert.match(text, /\[DONE\]/)
  assert.equal(cancelled, true)
})

test("非流式正文、工具参数和工具数量均受聚合上限保护", async () => {
  const contentPrepared = await prepareOpenAiStream(sse(`${frame({ content: "x".repeat(20) })}${frame({ content: "y".repeat(20) })}data:[DONE]\n\n`).body)
  await assert.rejects(aggregatePrepared(contentPrepared, "qwork-advanced", { maxBytes: 32 }), (error) => error.code === "upstream_response_too_large")

  const toolPrepared = await prepareOpenAiStream(sse(`${frame({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "f", arguments: "x".repeat(64) } }] })}data:[DONE]\n\n`).body)
  await assert.rejects(aggregatePrepared(toolPrepared, "qwork-advanced", { maxBytes: 32 }), (error) => error.code === "upstream_response_too_large")

  const manyPrepared = await prepareOpenAiStream(sse(`${frame({ tool_calls: [
    { index: 0, id: "call-0", type: "function", function: { name: "a", arguments: "" } },
    { index: 1, id: "call-1", type: "function", function: { name: "b", arguments: "" } },
  ] })}data:[DONE]\n\n`).body)
  await assert.rejects(aggregatePrepared(manyPrepared, "qwork-advanced", { maxToolCalls: 1 }), (error) => error.code === "upstream_too_many_tool_calls")
})

test("聊天 POST 在 429、500 和网络异常时不自动重放", async () => {
  for (const scenario of ["429", "500", "network"]) {
    let calls = 0
    const response = await chat({
      credential,
      body: { model: "qwork-advanced", messages: [] },
      fetchFn: async () => {
        calls += 1
        if (scenario === "network") throw new Error("socket failed refresh_token=rt-network-leaked")
        return json({ message: scenario === "429" ? "slow down" : "server failed" }, Number(scenario))
      },
    })
    assert.equal(calls, 1, scenario)
    assert.equal(response.status, scenario === "network" ? 502 : Number(scenario))
    const text = await response.text()
    assert.equal(text.includes("rt-network-leaked"), false)
  }
})
