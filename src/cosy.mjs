import { createCipheriv, createHash, randomBytes, randomUUID, publicEncrypt, constants } from "node:crypto"
import { COSY, RSA_PUBLIC_KEY } from "./constants.mjs"

const sessions = new Map()
const MAX_SESSIONS = 128

function deriveId(uid, salt) {
  return createHash("md5").update(`${salt}:${uid || "anonymous"}`, "utf8").digest("hex")
}

/**
 * 当前桌面端 COSY envelope：16 字节随机临时密钥（hex 文本）用 RSA 包装；
 * 身份 JSON 用同一临时密钥作 AES-128-CBC key 和 IV，最后分别 base64。
 */
export function createCosySession(credential, { tempKey = randomBytes(8).toString("hex") } = {}) {
  const token = String(credential.access_token ?? "").trim()
  if (!token) throw new Error("QwenWork COSY session 缺少 access token")
  if (!/^[0-9a-f]{16}$/i.test(tempKey)) throw new Error("COSY 临时密钥必须是 16 位 hex")
  const uid = String(credential.uid ?? "").trim()
  const keyBytes = Buffer.from(tempKey, "utf8")
  const wrapped = publicEncrypt({ key: RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, keyBytes).toString("base64")
  const identity = JSON.stringify({
    aid: uid,
    email: String(credential.email ?? "").trim(),
    name: String(credential.nickname ?? "").trim(),
    security_oauth_token: token,
    uid,
  })
  const cipher = createCipheriv("aes-128-cbc", keyBytes, keyBytes)
  const info = Buffer.concat([cipher.update(identity, "utf8"), cipher.final()]).toString("base64")
  return {
    token,
    uid,
    machineId: String(credential.machine_id ?? "").trim() || deriveId(uid, "machine"),
    tempKey,
    cosyKey: wrapped,
    info,
  }
}

/** access token 不变就复用 envelope；刷新 token 后自动重建。 */
export function sessionFor(credential) {
  const token = String(credential.access_token ?? "").trim()
  const cached = sessions.get(token)
  if (cached) return cached
  const session = createCosySession(credential)
  sessions.set(token, session)
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
  return session
}

export function cosySignPath(endpoint) {
  const path = new URL(endpoint).pathname
  const stripped = path.startsWith("/algo") ? path.slice(5) : path
  return stripped || "/"
}

/** body 必须与最终发送字节一致；签名 path 去掉 /algo，不包含 query。 */
export function signedHeaders({ site, credential, body = "", endpoint, model = "", accept = "application/json", now = new Date(), session } = {}) {
  const cosy = session ?? sessionFor(credential)
  const date = String(Math.floor(now.getTime() / 1000))
  const payloadBase64 = Buffer.from(JSON.stringify({
    cosyVersion: COSY.version,
    ideVersion: site.appVersion,
    info: cosy.info,
    requestId: randomUUID(),
    version: "v1",
  }), "utf8").toString("base64")
  const signature = createHash("md5").update(`${payloadBase64}\n${cosy.cosyKey}\n${date}\n${body}\n${cosySignPath(endpoint)}`, "utf8").digest("hex")
  const headers = {
    Accept: accept,
    "Content-Type": "application/json",
    "User-Agent": `qoderwork/${site.appVersion}`,
    "X-Request-Id": randomUUID(),
    "X-Qwenwork-Version": site.appVersion,
    "X-Qwenwork-Release-Version": `${site.appVersion}-${site.build}`,
    "X-Qwenwork-Build": site.build,
    "X-Qwenwork-Platform": "win32",
    "X-Qwenwork-Arch": "x64",
    "X-Qwenwork-Channel": "stable",
    "Cosy-Version": COSY.version,
    "Cosy-ClientType": COSY.clientType,
    "Cosy-Business-Product": COSY.businessProduct,
    "Cosy-Business-Type": COSY.businessType,
    "Cosy-Scene": COSY.scene,
    "Cosy-MachineOS": COSY.machineOS,
    "Login-Version": "v2",
    "Cosy-Key": cosy.cosyKey,
    "Cosy-User": cosy.uid,
    "Cosy-Date": date,
    "Cosy-MachineId": cosy.machineId,
    "Accept-Encoding": "identity",
    "Cache-Control": "no-cache",
  }
  headers["Author" + "ization"] = `Bearer COSY.${payloadBase64}.${signature}`
  if (model) {
    headers["X-Model-Key"] = model
    headers["X-Model-Source"] = "system"
  }
  return headers
}

export function plainHeaders(site, accessToken, { growthCard = false } = {}) {
  const headers = {
    Accept: growthCard ? "application/json" : "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "User-Agent": growthCard ? "QoderWork" : `qoderwork/${site.appVersion}`,
  }
  if (growthCard) Object.assign(headers, {
    "X-Qwenwork-Version": site.appVersion,
    "X-Qwenwork-Release-Version": `${site.appVersion}-${site.build}`,
    "X-Qwenwork-Build": site.build,
    "X-Qwenwork-Platform": "win32",
    "X-Qwenwork-Arch": "x64",
    "X-Qwenwork-Channel": "stable",
  })
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  return headers
}

export const _cosyInternals = { sessions, deriveId }
