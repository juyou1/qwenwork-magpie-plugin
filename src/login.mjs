import { createHash, randomBytes, randomUUID } from "node:crypto"
import { LOGIN_POLL_INTERVAL_MS, LOGIN_TIMEOUT_MS, MAX_ACTIVE_LOGINS, PATHS, REQUEST_TIMEOUT_MS, siteFor } from "./constants.mjs"
import { applyUserInfo, credentialFromGrant } from "./credential.mjs"
import { asQwenWorkError, classifyError, QwenWorkError, redactSensitive } from "./errors.mjs"
import { plainHeaders } from "./cosy.mjs"
import { abortableDelay, readTextLimited, timeoutSignal } from "./transport.mjs"

const activeLogins = new Set()
const refreshFlights = new Map()
const REFRESH_REPLAY_TTL_MS = 5 * 60 * 1000

export function createPkcePair() {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

export function buildAuthorizeUrl(site, pkce, nonce, machineId) {
  const url = new URL(`${site.gateway}${PATHS.deviceAuth}`)
  const params = url.searchParams
  params.set("challenge", pkce.challenge)
  params.set("challenge_method", "S256")
  params.set("nonce", nonce)
  params.set("machine_id", machineId)
  params.set("client_id", site.clientId)
  params.set("redirect_uri", site.redirectUri)
  return url.toString()
}

function parseJson(text, description) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new QwenWorkError(`${description} 返回了无效 JSON`, { kind: "unavailable", cause: error })
  }
}

async function pollOnce(site, nonce, verifier, fetchFn, signal) {
  const url = new URL(`${site.gateway}${PATHS.devicePoll}`)
  url.searchParams.set("nonce", nonce)
  url.searchParams.set("verifier", verifier)
  url.searchParams.set("challenge_method", "S256")
  const response = await fetchFn(url, {
    method: "GET",
    headers: plainHeaders(site, ""),
    signal: timeoutSignal(signal, REQUEST_TIMEOUT_MS),
  })
  const text = await readTextLimited(response)
  if (response.status === 404 || response.status === 202) return undefined
  if (!response.ok) throw asQwenWorkError(response.status, text)
  const grant = parseJson(text, "设备授权轮询")
  const classified = classifyError(200, grant)
  if (classified) throw classified
  const token = String(grant?.token ?? grant?.device_token ?? "").trim()
  // 服务端在授权完成前也可能返回 200 空对象，继续等待而不是误判失败。
  return token ? grant : undefined
}

export async function fetchUserInfo(credential, { fetchFn = fetch, signal } = {}) {
  const site = siteFor(credential.region)
  const response = await fetchFn(`${site.gateway}${PATHS.userInfo}`, {
    headers: plainHeaders(site, credential.access_token),
    signal: timeoutSignal(signal, REQUEST_TIMEOUT_MS),
  })
  const text = await readTextLimited(response)
  if (!response.ok) throw asQwenWorkError(response.status, text)
  const info = parseJson(text, "userinfo")
  if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error("QwenWork userinfo 响应不是对象")
  return info
}

/** authorize 立即返回 URL；callback() 才等待轮询结果，符合 Magpie oauth 生命周期。 */
export function startDeviceLogin({
  region = "global",
  fetchFn = fetch,
  pollIntervalMs = LOGIN_POLL_INTERVAL_MS,
  timeoutMs = LOGIN_TIMEOUT_MS,
  onWarning,
} = {}) {
  if (activeLogins.size >= MAX_ACTIVE_LOGINS) throw new Error(`最多同时进行 ${MAX_ACTIVE_LOGINS} 个 QwenWork 登录，请先完成或取消一个`)
  const site = siteFor(region)
  const pkce = createPkcePair()
  const nonce = randomUUID()
  const machineId = randomUUID()
  const controller = new AbortController()
  const session = { url: buildAuthorizeUrl(site, pkce, nonce, machineId), state: nonce, region: site.region }
  activeLogins.add(session)

  const run = async () => {
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (controller.signal.aborted) throw new Error("QwenWork 登录已取消")
      if (Date.now() >= deadline) throw new Error("QwenWork 登录超时，请重新发起授权")
      const grant = await pollOnce(site, nonce, pkce.verifier, fetchFn, controller.signal)
      if (grant) {
        let credential = credentialFromGrant(grant, { machine_id: machineId, region: site.region })
        try {
          credential = applyUserInfo(credential, await fetchUserInfo(credential, { fetchFn, signal: controller.signal }))
        } catch (error) {
          onWarning?.(`userinfo 读取失败，暂用授权响应中的账号信息：${redactSensitive(error?.message ?? error)}`)
        }
        if (!credential.uid) throw new QwenWorkError("QwenWork 授权结果缺少用户身份，请重试", { kind: "auth", status: 401 })
        return credential
      }
      await abortableDelay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), controller.signal)
    }
  }

  session.result = run().finally(() => activeLogins.delete(session))
  // 用户可能只打开授权页而不执行 callback，提前挂拒处理器避免 unhandledRejection。
  session.result.catch(() => {})
  session.cancel = () => controller.abort(new DOMException("Login cancelled", "AbortError"))
  session.close = session.cancel
  return session
}

async function refreshCredential(credential, fetchFn) {
  if (!credential.refresh_token) throw new QwenWorkError("缺少 refresh_token，请重新登录", { kind: "auth", status: 401 })
  const site = siteFor(credential.region)
  const response = await fetchFn(`${site.gateway}${PATHS.deviceRefresh}`, {
    method: "POST",
    headers: plainHeaders(site, ""),
    body: JSON.stringify({ refresh_token: credential.refresh_token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await readTextLimited(response)
  if (!response.ok) throw asQwenWorkError(response.status, text)
  const grant = parseJson(text, "刷新凭据")
  const classified = classifyError(200, grant)
  if (classified) throw classified
  if (!String(grant?.refresh_token ?? "").trim()) throw new QwenWorkError("QwenWork 刷新响应缺少新的 refresh_token", { kind: "unavailable" })
  try {
    return credentialFromGrant(grant, credential)
  } catch (error) {
    throw new QwenWorkError(error.message, { kind: "unavailable", cause: error })
  }
}

/** refresh_token 单次使用：同 key 并发去重，并短期缓存轮换结果，防止旧调用方重放。 */
export function refreshOnce(credential, { fetchFn = fetch } = {}) {
  const key = credential.refresh_token
  if (!key) return Promise.reject(new QwenWorkError("缺少 refresh_token，请重新登录", { kind: "auth", status: 401 }))
  const existing = refreshFlights.get(key)
  if (existing) return existing
  const task = refreshCredential(credential, fetchFn)
  refreshFlights.set(key, task)
  task.catch(() => {
    if (refreshFlights.get(key) === task) refreshFlights.delete(key)
  })
  task.then(() => {
    const timer = setTimeout(() => {
      if (refreshFlights.get(key) === task) refreshFlights.delete(key)
    }, REFRESH_REPLAY_TTL_MS)
    timer.unref?.()
  }).catch(() => {})
  return task
}

export const _loginInternals = { activeLogins, refreshFlights }
