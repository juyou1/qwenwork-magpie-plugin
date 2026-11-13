import { PATHS, REQUEST_TIMEOUT_MS, siteFor } from "./constants.mjs"
import { asQwenWorkError, classifyError, QwenWorkError } from "./errors.mjs"
import { plainHeaders } from "./cosy.mjs"
import { readTextLimited, timeoutSignal } from "./transport.mjs"

async function requestJson(credential, path, { fetchFn = fetch, method = "GET", body, growthCard = false, signal } = {}) {
  const site = siteFor(credential.region)
  const response = await fetchFn(`${site.gateway}${path}`, {
    method,
    headers: plainHeaders(site, credential.access_token, { growthCard }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: timeoutSignal(signal, REQUEST_TIMEOUT_MS),
  })
  const text = await readTextLimited(response)
  if (!response.ok) throw asQwenWorkError(response.status, text)
  let document
  try { document = JSON.parse(text) } catch (error) {
    throw new QwenWorkError("QwenWork 返回了无效 JSON", { kind: "unavailable", cause: error })
  }
  const classified = classifyError(200, document)
  if (classified) throw classified
  const code = String(document?.code ?? "").toLowerCase()
  if (code && !["ok", "0", "success"].includes(code)) throw new QwenWorkError(String(document?.message ?? `QwenWork 业务错误 ${code}`), { kind: "unavailable", code })
  return document
}

export async function fetchAccountContext(credential, options = {}) {
  const document = await requestJson(credential, PATHS.accountContext, options)
  if (!document?.data || typeof document.data !== "object") throw new QwenWorkError("QwenWork account-context 缺少 data")
  return document.data
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function isoTime(value) {
  if (value == null || value === "") return undefined
  const number = Number(value)
  const date = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))
    ? new Date(number < 1e12 ? number * 1000 : number)
    : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export async function fetchUsage(credential, options = {}) {
  const data = await fetchAccountContext(credential, options)
  const quota = data.quota
  if (!quota || typeof quota !== "object") throw new QwenWorkError("QwenWork account-context 未包含 quota")
  const total = finite(quota.total)
  const remaining = finite(quota.remaining)
  const usedValue = finite(quota.used) ?? (total !== undefined && remaining !== undefined ? total - remaining : undefined)
  if (usedValue === undefined && remaining === undefined) throw new QwenWorkError("QwenWork quota 缺少 used / remaining")
  const used = usedValue ?? 0
  const percent = total !== undefined && total > 0
    ? Math.max(0, Math.min(100, Math.round((used / total) * 100)))
    : remaining !== undefined && remaining <= 0 ? 100 : 0
  const display = total !== undefined && remaining !== undefined
    ? `剩余 ${remaining} / ${total} 积分`
    : remaining !== undefined ? `剩余 ${remaining} 积分` : `已用 ${used} 积分`
  const reset = isoTime(quota.resets_at ?? quota.reset_at ?? quota.expires_at)
  return {
    plan: String(data.plan?.name ?? data.plan?.plan_name ?? "QwenWork"),
    windows: [{
      name: "QwenWork 积分",
      used: percent,
      ...(total !== undefined && total > 0 ? { amount: used, limit: total, unit: "积分" } : {}),
      display,
      ...(reset ? { resetsAt: reset } : {}),
    }],
  }
}

const CHECKIN_CLAIMABLE = "CLAIMABLE"
const CHECKIN_CLAIMED = "CLAIMED_TODAY"
const CHECKIN_INACTIVE = new Set(["DISABLED", "NOT_STARTED", "ENDED"])
const checkinFlights = new Map()

function captchaResult(value) {
  let text = ""
  try { text = typeof value === "string" ? value : `${value?.message ?? ""} ${JSON.stringify(value)}` } catch { text = String(value) }
  if (!/captcha|验证码|人机验证|滑块/i.test(text)) return undefined
  return { outcome: "captcha", message: "需要验证码/人机验证，请在 QwenWork 官方页面手动完成后再试；插件不会自动绕过。" }
}

function rewardText(value) {
  const reward = finite(value)
  return reward !== undefined && reward > 0 ? ` +${reward} 积分` : ""
}

async function fallbackCheckin(credential, options) {
  if (credential.region === "cn") {
    try {
      const document = await requestJson(credential, PATHS.wallets, { ...options, growthCard: true })
      const daily = finite(document?.data?.daily_credits?.total_balance)
      if (daily !== undefined && daily > 0) return { outcome: "done", credit: daily, message: `每日免费积分已到账 +${daily}（每日 0 点刷新）` }
      return { outcome: "inactive", message: "今日每日免费积分尚未到账（每日 0 点刷新）" }
    } catch (error) {
      if (error?.status === 404 || error?.status === 405) return { outcome: "inactive", message: "签到接口未开放；每日登录奖励由服务端自动发放" }
      throw error
    }
  }
  try {
    const data = await fetchAccountContext(credential, options)
    const remaining = finite(data.quota?.remaining)
    return { outcome: "inactive", message: `签到接口未开放；每日登录奖励由服务端自动发放${remaining === undefined ? "" : `，当前剩余额度 ${remaining}`}` }
  } catch {
    return { outcome: "inactive", message: "签到接口未开放；每日登录奖励由服务端自动发放" }
  }
}

async function checkinCredential(credential, options = {}) {
  let document
  try {
    document = await requestJson(credential, PATHS.checkinStatus, { ...options, growthCard: true })
  } catch (error) {
    if ([404, 405, 501].includes(error?.status)) return fallbackCheckin(credential, options)
    throw error
  }
  const data = document?.data ?? {}
  const statusCaptcha = captchaResult(document)
  if (statusCaptcha) return statusCaptcha
  const status = String(data.status ?? "").trim().toUpperCase()
  if (status === CHECKIN_CLAIMABLE) {
    const claim = await requestJson(credential, PATHS.checkinClaim, { ...options, method: "POST", growthCard: true })
    const claimCaptcha = captchaResult(claim)
    if (claimCaptcha) return claimCaptcha
    const result = String(claim?.data?.result ?? "").trim().toUpperCase()
    const reward = finite(claim?.data?.rewardCredits)
    if (result === "CLAIMED") return { outcome: "claimed", ...(reward !== undefined ? { credit: reward } : {}), message: `签到成功${rewardText(reward)}` }
    if (result === "ALREADY_CLAIMED") return { outcome: "done", message: "今日已签到" }
    throw new QwenWorkError(`QwenWork 签到返回未知结果：${result || "(空)"}`)
  }
  if (status === CHECKIN_CLAIMED) {
    const reward = finite(data.rewardCredits)
    const streak = finite(data.currentStreakDays)
    return {
      outcome: "done",
      ...(reward !== undefined ? { credit: reward } : {}),
      ...(streak !== undefined ? { streak } : {}),
      message: `今日已签到${rewardText(reward)}${streak > 0 ? `（连签 ${streak} 天）` : ""}`,
    }
  }
  if (CHECKIN_INACTIVE.has(status)) {
    const messages = { DISABLED: "签到活动未开放", NOT_STARTED: "签到活动未开始", ENDED: "签到活动已结束" }
    return { outcome: "inactive", message: messages[status] }
  }
  return { outcome: "inactive", message: `签到活动状态未知${status ? `：${status}` : ""}` }
}

/** 并发签到共用同一状态/领取请求，短缓存避免重复领取。 */
export function checkinOnce(credential, options = {}) {
  const key = `${credential.region}:${credential.uid || credential.email || credential.access_token.slice(0, 16)}`
  const existing = checkinFlights.get(key)
  if (existing) return existing
  const task = checkinCredential(credential, options).catch((error) => {
    const captcha = captchaResult(error)
    if (captcha) return captcha
    throw error
  })
  checkinFlights.set(key, task)
  task.catch(() => { if (checkinFlights.get(key) === task) checkinFlights.delete(key) })
  task.then(() => {
    const timer = setTimeout(() => { if (checkinFlights.get(key) === task) checkinFlights.delete(key) }, 30_000)
    timer.unref?.()
  }).catch(() => {})
  return task
}

export const _apiInternals = { checkinFlights, isoTime }
