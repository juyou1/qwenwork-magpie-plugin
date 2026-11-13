import test from "node:test"
import assert from "node:assert/strict"
import { createDecipheriv, createHash } from "node:crypto"
import { siteFor } from "../src/constants.mjs"
import { credentialOf, nearExpiry, toStored } from "../src/credential.mjs"
import { buildAuthorizeUrl, createPkcePair, refreshOnce, startDeviceLogin, _loginInternals } from "../src/login.mjs"
import { createCosySession, signedHeaders } from "../src/cosy.mjs"
import { buildChatBody } from "../src/payload.mjs"
import { qwenSseToOpenAi, readSseData } from "../src/sse.mjs"
import { chat } from "../src/chat.mjs"
import { fetchUsage, checkinOnce } from "../src/api.mjs"
import { QwenWorkPlugin } from "../index.mjs"

const machineId = "11111111-2222-4333-8444-555555555555"
const credential = { access_token: "at-test", refresh_token: "rt-test", expires_at: 2_000_000_000, uid: "u-test", nickname: "Old", email: "old@example.com", machine_id: machineId, region: "global" }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const wrap = (body, status = 200) => `data:${JSON.stringify({ headers: {}, body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue: status })}\n\n`
const stream = (text) => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } })
const chunk = (delta, extra = {}) => {
  const { usage, ...choiceExtra } = extra
  return { id: "upstream", choices: [{ index: 0, delta, ...choiceExtra }], ...(usage ? { usage } : {}) }
}

async function readChunks(response) {
  const chunks = []
  for await (const data of readSseData(response.body)) if (data !== "[DONE]") chunks.push(JSON.parse(data))
  return chunks
}

test("PKCE 和当前设备授权 URL 参数正确", () => {
  const pair = createPkcePair()
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(pair.challenge, createHash("sha256").update(pair.verifier).digest("base64url"))
  const url = new URL(buildAuthorizeUrl(siteFor("cn"), pair, "nonce-1", machineId))
  assert.equal(url.origin, "https://gateway.qwenwork.cn")
  assert.equal(url.pathname, "/device/selectAccounts")
  assert.equal(url.searchParams.get("challenge"), pair.challenge)
  assert.equal(url.searchParams.get("challenge_method"), "S256")
  assert.equal(url.searchParams.get("nonce"), "nonce-1")
  assert.equal(url.searchParams.get("machine_id"), machineId)
  assert.equal(url.searchParams.get("client_id"), siteFor("cn").clientId)
  assert.equal(url.searchParams.get("redirect_uri"), "qwenwork-cn://")
})

test("设备轮询处理 pending、授权 grant 和 userinfo，结束时释放登录名额", async () => {
  let polls = 0
  const fetchFn = async (input, init = {}) => {
    const url = new URL(input)
    if (url.pathname === "/api/v1/deviceToken/poll") {
      polls += 1
      assert.equal(init.method, "GET")
      assert.equal(url.searchParams.get("challenge_method"), "S256")
      if (polls === 1) return new Response("waiting", { status: 404 })
      return json({ token: "new-at", refresh_token: "new-rt", expires_in: 3600, user_id: "u-new" })
    }
    if (url.pathname === "/api/v1/userinfo") {
      assert.equal(init.headers.Authorization, "Bearer new-at")
      return json({ id: "u-new", name: "新用户", email: "new@example.com" })
    }
    throw new Error(`unexpected ${url}`)
  }
  const session = startDeviceLogin({ fetchFn, pollIntervalMs: 1, timeoutMs: 1000 })
  const result = await session.result
  assert.equal(polls, 2)
  assert.equal(result.uid, "u-new")
  assert.equal(result.nickname, "新用户")
  assert.equal(result.email, "new@example.com")
  assert.equal(result.machine_id.length, 36)
  assert.equal(_loginInternals.activeLogins.size, 0)
})

test("refresh 轮换并短期去重，终态错误分类为 auth", async () => {
  let calls = 0
  const fetchFn = async (_input, init) => {
    calls += 1
    assert.equal(JSON.parse(init.body).refresh_token, "rt-rotate")
    return json({ token: "at-rotated", refresh_token: "rt-next", expires_in: 7200 })
  }
  const old = { ...credential, refresh_token: "rt-rotate" }
  const [a, b] = await Promise.all([refreshOnce(old, { fetchFn }), refreshOnce(old, { fetchFn })])
  assert.equal(calls, 1)
  assert.equal(a.access_token, "at-rotated")
  assert.equal(a.refresh_token, "rt-next")
  assert.equal(b, a)
  const failed = await refreshOnce({ ...credential, refresh_token: "rt-terminal" }, {
    fetchFn: async () => json({ error: "invalid_grant", message: "session dead" }, 401),
  }).catch((error) => error)
  assert.equal(failed.kind, "auth")
})

test("凭据兼容 snake、camel、嵌套和旧格式，并规范化毫秒到期时间", () => {
  for (const value of [
    { access_token: "a", refresh_token: "r", expires_at: 2_000_000_000_000 },
    { accessToken: "a", refreshToken: "r", expiresAt: 2_000_000_000 },
    { token: "a", refreshToken: "r", expiry: "2033-05-18T03:33:20Z" },
    { credentials: { device_token: "a", refresh_token: "r", expires_at: 2_000_000_000 }, data: { uid: "u" } },
  ]) {
    const result = credentialOf({ access: JSON.stringify(value) })
    assert.equal(result.access_token, "a")
    assert.equal(result.refresh_token, "r")
    assert.ok(result.expires_at > 1_000_000_000)
    assert.equal(result.machine_id.length, 36)
  }
  const legacy = credentialOf({ access: JSON.stringify({ access_token: "a", refresh_token: "r" }) })
  assert.equal(legacy.expires_at, 0)
  assert.equal(nearExpiry(legacy), true)
  assert.equal(nearExpiry({ ...legacy, refresh_token: "" }), false)
  const stored = toStored({ ...credential, expires_at: 2_000_000_000 })
  assert.equal(stored.refresh, credential.refresh_token)
  assert.equal(stored.expires, 2_000_000_000_000)
  assert.equal(stored.uid, credential.uid)
})

test("COSY 使用 RSA 包装临时 key、AES 身份和精确 MD5 签名串", () => {
  const site = siteFor("global")
  const session = createCosySession(credential, { tempKey: "0123456789abcdef" })
  assert.equal(session.cosyKey.length, 172)
  const decipher = createDecipheriv("aes-128-cbc", Buffer.from(session.tempKey), Buffer.from(session.tempKey))
  const identity = Buffer.concat([decipher.update(Buffer.from(session.info, "base64")), decipher.final()]).toString("utf8")
  assert.deepEqual(JSON.parse(identity), { aid: "u-test", email: "old@example.com", name: "Old", security_oauth_token: "at-test", uid: "u-test" })
  const now = new Date("2026-01-02T03:04:05Z")
  const body = "{\"x\":1}"
  const headers = signedHeaders({ site, credential, session, body, endpoint: `${site.gateway}/algo/api/v2/model/list?x=1`, now })
  const parts = headers.Authorization.split(".")
  assert.equal(parts[0], "Bearer COSY")
  const expected = createHash("md5").update(`${parts[1]}\n${session.cosyKey}\n${headers["Cosy-Date"]}\n${body}\n/api/v2/model/list`).digest("hex")
  assert.equal(parts[2], expected)
  assert.equal(headers["Cosy-Key"], session.cosyKey)
  assert.equal(headers["Cosy-MachineId"], machineId)
  assert.equal(headers["Accept-Encoding"], "identity")
  assert.equal(headers["X-Model-Key"], undefined)
})

test("chat payload 提升 system/developer、限制 max_tokens 并修正纯工具调用 content", () => {
  const body = buildChatBody({
    model: "qwork-advanced",
    max_tokens: 999999,
    messages: [
      { role: "system", content: "系统" },
      { role: "developer", content: [{ type: "text", text: "开发" }] },
      { role: "user", content: [{ type: "text", text: "问题" }, { type: "image_url", image_url: { url: "https://x/image" } }] },
      { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c", content: "结果" },
    ],
  }, "qwork-advanced", 8192)
  assert.equal(body.system, "系统\n\n开发")
  assert.equal(body.parameters.max_tokens, 8192)
  assert.equal(body.messages[1].content, "")
  assert.equal(body.messages[2].role, "tool")
  assert.equal(body.chat_context.extra.originalContent, "问题")
  assert.equal(body.stream, true)
  assert.equal(body.model_config.key, "qwork-advanced")
})

test("wrapped SSE 流式保留增量，非流式按 index 聚合 tool arguments", async () => {
  const upstream = [
    chunk({ role: "assistant", content: "Hel" }),
    chunk({ content: "lo", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "get_", arguments: "{\"a\":" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: "time", arguments: "1}" } }] }),
    chunk({}, { finish_reason: "tool_calls", usage: { prompt_tokens: 3, completion_tokens: 2 } }),
  ].map((item) => wrap(JSON.stringify(item))).join("") + "data: [DONE]\n\n"
  const result = await chat({ credential, body: { model: "qwork-advanced", stream: false, messages: [{ role: "user", content: "hi" }] }, fetchFn: async () => stream(upstream) })
  assert.equal(result.status, 200)
  const data = await result.json()
  assert.equal(data.choices[0].message.content, "Hello")
  assert.equal(data.choices[0].message.tool_calls[0].function.name, "get_time")
  assert.equal(data.choices[0].message.tool_calls[0].function.arguments, "{\"a\":1}")
  assert.equal(data.choices[0].message.tool_calls[0].index, undefined)
  assert.equal(data.usage.total_tokens, 5)

  const streamed = await chat({ credential, body: { model: "qwork-advanced", stream: true, messages: [] }, fetchFn: async () => stream(upstream) })
  const chunks = await readChunks(streamed)
  assert.equal(chunks.find((item) => item.choices[0].delta.content === "Hel").object, "chat.completion.chunk")
  assert.ok(chunks.some((item) => item.choices[0].delta.tool_calls))
  assert.ok(chunks.some((item) => item.choices[0].finish_reason === "tool_calls"))
})

test("截断流合成终止原因，usage-only 帧不被误判为空响应", async () => {
  const truncated = wrap(JSON.stringify(chunk({ content: "partial" })))
  const streamed = await chat({ credential, body: { model: "qwork-advanced", stream: true, messages: [] }, fetchFn: async () => stream(truncated) })
  const chunks = await readChunks(streamed)
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop")

  const nonStream = await chat({ credential, body: { model: "qwork-advanced", stream: false, messages: [] }, fetchFn: async () => stream(truncated) })
  assert.equal((await nonStream.json()).choices[0].finish_reason, "stop")

  const usageOnly = wrap(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 } })) + "data: [DONE]\\n\\n"
  const usageResponse = await chat({ credential, body: { model: "qwork-advanced", stream: false, messages: [] }, fetchFn: async () => stream(usageOnly) })
  const usageData = await usageResponse.json()
  assert.equal(usageData.choices[0].finish_reason, "stop")
  assert.equal(usageData.usage.total_tokens, 3)
})

test("错误帧在首段前变成 HTTP 错误，已有内容后变成 error chunk + DONE", async () => {
  const errorFrame = wrap(JSON.stringify({ code: "401", message: "session dead" }))
  const early = await chat({ credential, body: { model: "qwork-advanced", stream: true, messages: [] }, fetchFn: async () => stream(errorFrame) })
  assert.equal(early.status, 401)
  const late = await chat({ credential, body: { model: "qwork-advanced", stream: true, messages: [] }, fetchFn: async () => stream(wrap(JSON.stringify(chunk({ content: "ok" }))) + wrap(JSON.stringify({ code: "14018", message: "insufficient quota" })) + "data: [DONE]\n\n") })
  assert.equal(late.status, 200)
  const text = await late.text()
  assert.match(text, /"error"/)
  assert.match(text, /\[DONE\]/)
})

test("额度、CLAIMABLE 签到和 CN 签到接口回退", async () => {
  const usage = await fetchUsage(credential, { fetchFn: async () => json({ code: "ok", data: { plan: { name: "Pro" }, quota: { total: 100, used: 25, remaining: 75 } } }) })
  assert.equal(usage.plan, "Pro")
  assert.equal(usage.windows[0].used, 25)
  assert.equal(usage.windows[0].amount, 25)
  let claimCalls = 0
  const claimed = await checkinOnce({ ...credential, uid: "checkin-1" }, { fetchFn: async (_input, init) => {
    if (init.method === "POST") { claimCalls += 1; return json({ code: "ok", data: { result: "CLAIMED", rewardCredits: 3 } }) }
    return json({ code: "ok", data: { status: "CLAIMABLE" } })
  } })
  assert.equal(claimed.outcome, "claimed")
  assert.equal(claimed.credit, 3)
  assert.equal(claimCalls, 1)
  const fallback = await checkinOnce({ ...credential, region: "cn", uid: "checkin-2" }, { fetchFn: async (input) => {
    if (new URL(input).pathname.includes("wallets")) return json({ code: "ok", data: { daily_credits: { total_balance: 5 } } })
    return new Response("not found", { status: 404 })
  } })
  assert.equal(fallback.outcome, "done")
  assert.equal(fallback.credit, 5)
  const captcha = await checkinOnce({ ...credential, uid: "checkin-captcha" }, {
    fetchFn: async () => json({ code: "ok", data: { status: "CAPTCHA", challenge: "manual" } }),
  })
  assert.equal(captcha.outcome, "captcha")
})

test("Magpie config/auth/loader 使用既有钩子，SDK 请求被转换为上游 SSE", async () => {
  let saved
  const client = { app: { log() {} }, auth: { set: async ({ body }) => { saved = body } } }
  const plugin = await QwenWorkPlugin({ client })
  const config = {}
  await plugin.config(config)
  assert.equal(config.provider.qwenwork.npm, "@ai-sdk/openai-compatible")
  let upstreamBody
  const injected = await QwenWorkPlugin({ client, fetch: async (_input, init) => { upstreamBody = JSON.parse(init.body); return stream(wrap(JSON.stringify(chunk({ content: "ok" }))) + "data: [DONE]\n\n") } })
  const injectedHooks = await injected.auth.loader(async () => ({ access: JSON.stringify(credential), expires: 2_000_000_000_000 }))
  const result = await injectedHooks.fetch("https://qwenwork.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "qwenwork/qwork-advanced", messages: [] }) })
  assert.equal((await result.json()).choices[0].message.content, "ok")
  assert.equal(upstreamBody.model_config.key, "qwork-advanced")
})
