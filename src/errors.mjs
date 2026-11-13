const KIND_STATUS = {
  model_not_available: 400,
  quota: 402,
  auth: 401,
  rate_limit: 429,
  invalid_request: 400,
  unavailable: 502,
}

const MAX_ERROR_MESSAGE_CHARS = 2000
const REDACTED = "[REDACTED]"
// 仅用于错误展示；请求签名、刷新和持久化始终使用未经过此函数的原始值。
const SECRET_NAME = "(?:access[_-]?token|refresh[_-]?token|security_oauth_token|accessToken|refreshToken|api[_-]?key|apiKey|client[_-]?secret|authorization|proxy-authorization|cosy[_-]?key|access|refresh|token|verifier|nonce)"
const SECRET_ASSIGNMENT = new RegExp(`(\\b${SECRET_NAME}\\b["']?\\s*[=:]\\s*)(?![\\[{])("[^"]*"|'[^']*'|[^\\s,;&}]+)`, "gi")
const CODE_ASSIGNMENT = /(\bcode\b["']?\s*[=:]\s*)(?![\[{])("[^"]*"|'[^']*'|[^\s,;&}]+)/gi
const SAFE_CODE = /^(?:\d+|ok|success|true|false|invalid_grant|invalid_request|invalid_client|invalid_scope|invalid_token|expired_token|access_denied|authorization_pending|slow_down|unsupported_grant_type|server_error|temporarily_unavailable|quota|auth|rate_limit|model_not_available|invalid_request_error|unavailable|captcha|pending|claimable|upstream_[a-z0-9_]+)$/i
const SECRET_QUERY = /([?&](?:access_token|refresh_token|token|code|verifier|nonce|client_secret)=)[^&\s"'}\]]*/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi

function maskedAssignment(prefix, secret) {
  if (secret.startsWith('"')) return `${prefix}"${REDACTED}"`
  if (secret.startsWith("'")) return `${prefix}'${REDACTED}'`
  return `${prefix}${REDACTED}`
}

/** 在日志、HTTP 错误和 OAuth callback 展示前移除常见凭据形态。 */
export function redactSensitive(value) {
  let text = String(value ?? "")
  text = text.replace(PRIVATE_KEY, REDACTED)
  text = text.replace(SECRET_QUERY, `$1${REDACTED}`)
  text = text.replace(BEARER, `Bearer ${REDACTED}`)
  text = text.replace(SECRET_ASSIGNMENT, (_match, prefix, secret) => maskedAssignment(prefix, secret))
  // code 既可能是 OAuth 授权码，也可能是可公开展示的业务错误码；白名单以外的值按秘密处理。
  text = text.replace(CODE_ASSIGNMENT, (match, prefix, secret) => {
    const raw = secret.startsWith('"') || secret.startsWith("'") ? secret.slice(1, -1) : secret
    return SAFE_CODE.test(raw) ? match : maskedAssignment(prefix, secret)
  })
  text = text.replace(JWT, REDACTED)
  if (text.length > MAX_ERROR_MESSAGE_CHARS) return `${text.slice(0, MAX_ERROR_MESSAGE_CHARS - 14)}…[truncated]`
  return text
}

export class QwenWorkError extends Error {
  constructor(message, { kind = "unavailable", status, code = "", cause } = {}) {
    super(redactSensitive(message || "QwenWork 上游请求失败"), { cause })
    this.name = "QwenWorkError"
    this.kind = kind
    this.status = status ?? KIND_STATUS[kind] ?? 502
    this.code = redactSensitive(code).slice(0, 128)
  }
}

function scalarCode(value) {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

export function errorParts(body) {
  if (body && typeof body === "object") {
    const nested = body.error && typeof body.error === "object" ? body.error : undefined
    return {
      message: String(body.message ?? body.msg ?? nested?.message ?? "").trim() || JSON.stringify(body),
      code: scalarCode(body.code ?? nested?.code),
    }
  }
  const raw = String(body ?? "").trim()
  if (!raw) return { message: "", code: "" }
  try {
    return errorParts(JSON.parse(raw))
  } catch {
    return { message: raw, code: "" }
  }
}

/** 文本与 body code 优先于 HTTP 状态：网关会把 14018 放进 200 帧。 */
export function classifyError(status, body) {
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === "object") return classifyError(status, parsed)
    } catch { /* 普通文本错误继续按文本分类 */ }
  }
  if (status >= 200 && status < 300 && body && typeof body === "object" && !body.error && body.code == null && body.message == null && body.msg == null) return undefined
  const { message, code } = errorParts(body)
  // 业务 envelope 的成功码不能被 data.quota / data.credits 等正常字段误判为错误。
  if (status >= 200 && status < 300 && ["0", "ok", "success", "true"].includes(code.toLowerCase())) return undefined
  const lower = `${message} ${code}`.toLowerCase()
  let kind = ""
  if (lower.includes("model is not available")) kind = "model_not_available"
  else if (code === "401" || code === "403") kind = "auth"
  else if (code === "402") kind = "quota"
  else if (code === "429") kind = "rate_limit"
  else if (status === 402 || code === "14018" || /quota|insufficient credit|积分不足|额度/i.test(lower)) kind = "quota"
  else if (status === 401 || status === 403) kind = "auth"
  else if (status === 429) kind = "rate_limit"
  else if ([400, 413, 422].includes(status)) kind = "invalid_request"
  else if (status >= 500 || status === 404) kind = "unavailable"
  if (!kind) return undefined
  const normalizedStatus = kind === "quota" ? 402
    : kind === "rate_limit" ? 429
      : kind === "auth" ? ([401, 403].includes(status) ? status : 401)
        : status >= 400 ? status : KIND_STATUS[kind]
  return new QwenWorkError(message || `QwenWork 上游状态 ${normalizedStatus}`, {
    kind,
    status: normalizedStatus,
    code,
  })
}

export function asQwenWorkError(status, body, fallback = "unavailable") {
  return classifyError(status, body) ?? new QwenWorkError(errorParts(body).message || `QwenWork HTTP ${status}`, {
    kind: fallback,
    status: status >= 400 ? status : KIND_STATUS[fallback],
  })
}

export function errorObject(error) {
  const classified = error instanceof QwenWorkError ? error : new QwenWorkError(String(error?.message ?? error))
  return {
    error: {
      message: classified.message,
      type: classified.kind,
      kind: classified.kind,
      status: classified.status,
      ...(classified.code ? { code: classified.code } : {}),
    },
  }
}

export function errorResponse(error) {
  const classified = error instanceof QwenWorkError ? error : new QwenWorkError(String(error?.message ?? error))
  return Response.json(errorObject(classified), { status: classified.status })
}

export function isTerminalRefreshError(error) {
  return error instanceof QwenWorkError && error.kind === "auth"
}
