import { randomUUID } from "node:crypto"
import { DEFAULT_TOKEN_LIFETIME_MS, EXPIRY_LEAD_MS, regionOf } from "./constants.mjs"

const text = (value) => typeof value === "string" ? value.trim() : ""

function parsedAccess(value) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed.startsWith("{")) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === "object" ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 同时接受 magpie 标准 auth 记录、snake/camelCase 和嵌套账号导出。 */
export function normalizeCredential(input) {
  if (!input || typeof input !== "object") return undefined
  const nested = [input.credentials, input.account, input.token_info, input.data].find((value) => value && typeof value === "object" && !Array.isArray(value))
  const source = nested ? { ...input, ...nested } : input
  const token = ["access_token", "accessToken", "token", "device_token", "access"].map((key) => text(source[key])).find(Boolean)
  if (!token) return undefined
  const refresh = ["refresh_token", "refreshToken", "refresh"].map((key) => text(source[key])).find(Boolean) || ""
  const rawExpiry = ["expires_at", "expiresAt", "expiry", "expiry_at", "expiryAt", "expires"].map((key) => source[key]).find((value) => value !== undefined && value !== null && value !== "")
  return {
    access_token: token,
    refresh_token: refresh,
    expires_at: normalizeEpoch(rawExpiry),
    uid: text(source.uid ?? source.user_id ?? source.userId),
    nickname: text(source.nickname ?? source.user_name ?? source.userName ?? source.name),
    email: text(source.email),
    machine_id: text(source.machine_id ?? source.machineId) || randomUUID(),
    region: regionOf(source.region ?? source.provider_region),
  }
}

export function credentialOf(auth) {
  if (!auth || typeof auth !== "object") return undefined
  const packed = parsedAccess(auth.access)
  const source = packed ?? auth
  return normalizeCredential({
    ...source,
    ...(packed || text(source.access_token ?? source.accessToken ?? source.token ?? source.device_token ?? source.access) ? {} : { access_token: text(auth.access) }),
    refresh: auth.refresh ?? source.refresh,
    expires: auth.expires ?? source.expires,
    region: source.region ?? auth.region,
    uid: source.uid ?? auth.uid,
    nickname: source.nickname ?? auth.nickname,
    email: source.email ?? auth.email,
    machine_id: source.machine_id ?? source.machineId ?? auth.machine_id,
  })
}

function normalizeEpoch(value) {
  if (value instanceof Date) return value.getTime()
  if (value === undefined || value === null || value === "") return 0
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return number < 1e12 ? Math.floor(number * 1000) : Math.floor(number)
}

export function normalizeExpiry(value) {
  return normalizeEpoch(value)
}

export function nearExpiry(credential, leadMs = EXPIRY_LEAD_MS, now = Date.now()) {
  if (!credential?.access_token || !credential?.refresh_token) return false
  // 缺失 expires_at 的旧记录有一次强制续期机会；刷新响应会补上真实到期时间。
  if (!credential.expires_at) return true
  return credential.expires_at - now <= leadMs
}

export function expiryMs(credential) {
  return normalizeExpiry(credential?.expires_at) || Date.now() + DEFAULT_TOKEN_LIFETIME_MS
}

export function identityOf(credential) {
  return text(credential?.email) || text(credential?.uid)
}

export function accountLabelOf(credential) {
  return text(credential?.nickname) || text(credential?.email) || text(credential?.uid) || "QwenWork"
}

export function toStored(credential, previous = {}) {
  const stored = {
    ...previous,
    type: "oauth",
    access: credential.access_token,
    refresh: credential.refresh_token,
    expires: expiryMs(credential),
    accountId: identityOf(credential) || accountLabelOf(credential),
    uid: credential.uid || previous.uid || identityOf(credential),
    email: credential.email || previous.email || "",
    nickname: credential.nickname || previous.nickname || "",
    machine_id: credential.machine_id || previous.machine_id || randomUUID(),
    region: regionOf(credential.region ?? previous.region),
  }
  delete stored.access_token
  delete stored.accessToken
  delete stored.refresh_token
  delete stored.refreshToken
  delete stored.expires_at
  delete stored.expiresAt
  delete stored.user_id
  delete stored.user_name
  delete stored.machineId
  return stored
}

function grantExpiry(grant, now) {
  const absolute = normalizeExpiry(grant.expires_at ?? grant.expiresAt, now)
  if (absolute) return absolute
  const lifetime = Number(grant.expires_in ?? grant.expiresIn)
  if (Number.isFinite(lifetime) && lifetime > 0) {
    return now + (lifetime > 10_000_000 ? lifetime : lifetime * 1000)
  }
  return now + DEFAULT_TOKEN_LIFETIME_MS
}

/** deviceToken/poll 与 /refresh 的授权文档 → 统一凭据。 */
export function credentialFromGrant(grant, previous = {}, now = Date.now()) {
  if (!grant || typeof grant !== "object") throw new Error("QwenWork 授权响应不是对象")
  const accessToken = text(grant.token ?? grant.device_token ?? grant.access_token ?? grant.accessToken)
  if (!accessToken) throw new Error("QwenWork 授权响应缺少 token")
  return {
    access_token: accessToken,
    refresh_token: text(grant.refresh_token ?? grant.refreshToken ?? previous.refresh_token),
    expires_at: grantExpiry(grant, now),
    uid: text(grant.user_id ?? grant.uid ?? previous.uid),
    nickname: text(grant.user_name ?? grant.nickname ?? previous.nickname),
    email: text(grant.email ?? previous.email),
    machine_id: text(previous.machine_id ?? previous.machineId) || randomUUID(),
    region: regionOf(previous.region),
  }
}

export function applyUserInfo(credential, info) {
  if (!info || typeof info !== "object") return credential
  return {
    ...credential,
    uid: text(info.uid ?? info.id ?? info.user_id) || credential.uid,
    nickname: text(info.name ?? info.nickname ?? info.user_name) || credential.nickname,
    email: text(info.email) || credential.email,
  }
}
