// QwenWork 桌面端协议常量。数值与字段以 CLI2API 的 QwenWork 实现为准。
export const PROVIDER = "qwenwork"
export const PROVIDER_NAME = "QwenWork（千问办公）"
export const NPM = "@ai-sdk/openai-compatible"
export const PLACEHOLDER_BASE = "https://qwenwork.invalid/v1"

export const EXPIRY_LEAD_MS = 120_000
export const REQUEST_TIMEOUT_MS = 30_000
export const FIRST_MEANINGFUL_TIMEOUT_MS = 30_000
export const MAX_RESPONSE_BYTES = 1024 * 1024
export const MAX_SSE_EVENT_BYTES = 1024 * 1024
export const MAX_AGGREGATE_BYTES = 8 * 1024 * 1024
export const MAX_TOOL_CALLS = 128
export const SSE_IDLE_TIMEOUT_MS = 120_000
export const LOGIN_TIMEOUT_MS = 300_000
export const LOGIN_POLL_INTERVAL_MS = 2_000
export const MAX_ACTIVE_LOGINS = 3
export const DEFAULT_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

export const PATHS = Object.freeze({
  deviceAuth: "/device/selectAccounts",
  devicePoll: "/api/v1/deviceToken/poll",
  deviceRefresh: "/api/v1/deviceToken/refresh",
  userInfo: "/api/v1/userinfo",
  accountContext: "/api/v1/adapter/user/account-context?include=user,plan,quota",
  modelList: "/algo/api/v2/model/list",
  chat: "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common",
  chatPath: "/algo/api/v2/service/pro/sse/agent_chat_generation",
  checkinStatus: "/sash/api/v1/me/daily-check-in/status",
  checkinClaim: "/sash/api/v1/me/daily-check-in/claim",
  wallets: "/api/v1/adapter/user/wallets",
})

const SITES = Object.freeze({
  global: Object.freeze({
    region: "global",
    gateway: "https://gateway.qwenwork.ai",
    clientId: "cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a",
    redirectUri: "qwenwork://",
    appVersion: "1.0.4",
    build: "26090501",
    defaultModel: "qwork-advanced",
    infoRegion: "1",
  }),
  cn: Object.freeze({
    region: "cn",
    gateway: "https://gateway.qwenwork.cn",
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    redirectUri: "qwenwork-cn://",
    appVersion: "1.0.5",
    build: "26090901",
    defaultModel: "pro",
    infoRegion: "2",
  }),
})

export function siteFor(region = "global") {
  const key = String(region ?? "global").trim().toLowerCase() || "global"
  const site = SITES[key]
  if (!site) throw new Error(`QwenWork 未知站点：${key}（可选 global / cn）`)
  return site
}

export function regionOf(value) {
  return String(value ?? "global").trim().toLowerCase() === "cn" ? "cn" : "global"
}

export const COSY = Object.freeze({
  version: "1.1.18",
  clientType: "6",
  businessProduct: "qoder_work",
  businessType: "agent",
  scene: "qwork",
  machineOS: "x86_64_win32",
})

export const RSA_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc\n4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l\n6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17\nXcW+ML9FoCI6AOvOzwIDAQAB\n-----END PUBLIC KEY-----"
