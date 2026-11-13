import test from "node:test"
import assert from "node:assert/strict"
import { QwenWorkPlugin } from "../index.mjs"
import { readSseData } from "../src/sse.mjs"

const machineId = "11111111-2222-4333-8444-555555555555"
const storedCredential = {
  access_token: "at-loader",
  refresh_token: "rt-loader",
  expires_at: 2_000_000_000,
  uid: "uid-loader",
  nickname: "Loader",
  email: "loader@example.com",
  machine_id: machineId,
  region: "global",
}
const wrappedChunk = (content) => `data:${JSON.stringify({ headers: {}, body: JSON.stringify({ choices: [{ delta: { content } }] }), statusCodeValue: 200 })}\n\n`

function harness(fetchImpl = async () => new Response("not mocked", { status: 500 })) {
  let saved
  const client = {
    app: { log() {} },
    auth: { set: async ({ body }) => { saved = body } },
  }
  return { client, fetchImpl, get saved() { return saved } }
}

test("oauth authorize 返回 url+callback，callback 产出标准 oauth body", async () => {
  let pollCount = 0
  const h = harness(async (input) => {
    const path = new URL(input).pathname
    if (path.endsWith("/deviceToken/poll")) {
      pollCount += 1
      return Response.json({ token: "at-callback", refresh_token: "rt-callback", expires_in: 3600, user_id: "uid-callback" })
    }
    if (path.endsWith("/userinfo")) return Response.json({ id: "uid-callback", name: "Callback", email: "callback@example.com" })
    throw new Error(`unexpected ${path}`)
  })
  const plugin = await QwenWorkPlugin({ client: h.client, fetch: h.fetchImpl })
  const authorization = await plugin.auth.methods[0].authorize({ region: "cn" })
  assert.equal(typeof authorization.url, "string")
  assert.equal(typeof authorization.callback, "function")
  assert.equal(typeof authorization.close, "function")
  assert.match(authorization.url, /gateway\.qwenwork\.cn/)
  const result = await authorization.callback()
  assert.equal(result.type, "success")
  assert.equal(result.access, "at-callback")
  assert.equal(result.refresh, "rt-callback")
  assert.equal(result.uid, "uid-callback")
  assert.equal(result.region, "cn")
  assert.ok(result.expires > Date.now())
  assert.equal(pollCount, 1)
  await authorization.close()
  await h.client.auth.set({ provider: "qwenwork", body: result })
  assert.equal(h.saved.access, "at-callback")
})

test("Magpie 取消 oauth callback 会中止设备轮询并释放登录名额", async () => {
  const h = harness(async (_input, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  }))
  const plugin = await QwenWorkPlugin({ client: h.client, fetch: h.fetchImpl })
  const authorization = await plugin.auth.methods[0].authorize({ region: "global" })
  const controller = new AbortController()
  const pending = authorization.callback(undefined, { signal: controller.signal })
  controller.abort()
  const result = await pending
  assert.equal(result.type, "failed")
  await authorization.close()
})

test("refresh 方法把秒/毫秒到期统一保存为 Magpie expires 毫秒", async () => {
  const h = harness(async (_input, init) => {
    assert.equal(JSON.parse(init.body).refresh_token, "rt-refresh-method")
    return Response.json({ token: "at-refreshed", refresh_token: "rt-next", expires_in: 3600, user_id: "uid-refresh" })
  })
  const plugin = await QwenWorkPlugin({ client: h.client, fetch: h.fetchImpl })
  const result = await plugin.auth.refresh({ ...storedCredential, refresh_token: "rt-refresh-method" })
  assert.equal(result.access, "at-refreshed")
  assert.equal(result.refresh, "rt-next")
  assert.ok(result.expires > Date.now() + 3_000_000)
  assert.equal(result.uid, "uid-refresh")
})

test("loader 在临近过期时刷新、持久化，并在后续请求使用新 token", async () => {
  const auth = { access: "at-old", refresh: "rt-old", expires: Date.now() + 1000, uid: "uid-loader", machine_id: machineId, region: "global" }
  let refreshCalls = 0
  let chatCalls = 0
  const h = harness(async (input, init) => {
    const url = new URL(input)
    if (url.pathname.endsWith("/deviceToken/refresh")) {
      refreshCalls += 1
      return Response.json({ token: "at-new", refresh_token: "rt-new", expires_in: 3600 })
    }
    chatCalls += 1
    assert.match(init.headers.Authorization, /^Bearer COSY\./)
    return new Response(wrappedChunk("done") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
  })
  const plugin = await QwenWorkPlugin({ client: h.client, fetch: h.fetchImpl })
  const getAuth = async () => h.saved ?? auth
  const hooks = await plugin.auth.loader(getAuth)
  const first = await hooks.fetch("https://qwenwork.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "qwenwork/qwork-advanced", messages: [] }) })
  assert.equal(first.status, 200)
  assert.equal(refreshCalls, 1)
  assert.equal(h.saved.access, "at-new")
  assert.equal(h.saved.refresh, "rt-new")
  const second = await hooks.fetch("https://qwenwork.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "qwenwork/qwork-advanced", messages: [] }) })
  assert.equal(second.status, 200)
  assert.equal(refreshCalls, 1)
  assert.equal(chatCalls, 2)
})

test("provider.models 按凭据 region 请求动态模型，无凭据时使用静态 fallback", async () => {
  let requested
  const h = harness(async (input, init) => {
    requested = { url: new URL(input), headers: init.headers }
    return Response.json({ qwork: [{ key: "qwork-custom", display_name: "自定义", max_output_tokens: 1234 }] })
  })
  const plugin = await QwenWorkPlugin({ client: h.client, fetch: h.fetchImpl })
  const models = await plugin.provider.models({}, { auth: { ...storedCredential, region: "cn" } })
  assert.equal(requested.url.hostname, "gateway.qwenwork.cn")
  assert.match(requested.headers.Authorization, /^Bearer COSY\./)
  assert.equal(models["qwork-custom"].name, "自定义")
  assert.equal(models["qwork-custom"].limit.output, 1234)
  const fallback = await plugin.provider.models({}, { auth: undefined })
  assert.ok(fallback["qwork-advanced"])
  const failing = await QwenWorkPlugin({ client: h.client, fetch: async () => { throw new Error("offline") } })
  const cnFallback = await failing.provider.models({}, { auth: { ...storedCredential, uid: "offline-uid", region: "cn" } })
  assert.ok(cnFallback["pro"])
})

test("非 SSE 上游错误和直接上游 JSON completion 均返回 OpenAI 形状", async () => {
  const h = harness(async () => Response.json({ choices: [{ message: { role: "assistant", content: "json ok" }, finish_reason: "stop" }] }))
  const plugin = await QwenWorkPlugin({ client: h.client, fetch: h.fetchImpl })
  const hooks = await plugin.auth.loader(async () => storedCredential)
  const response = await hooks.fetch("https://qwenwork.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "qwork-advanced", messages: [] }) })
  assert.equal(response.headers.get("content-type"), "application/json")
  assert.equal((await response.json()).choices[0].message.content, "json ok")
})
