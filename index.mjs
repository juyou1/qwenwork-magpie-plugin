// QwenWork（千问办公）· Magpie 供应商插件
// 登录：官方设备授权 URL + PKCE S256 + deviceToken/poll；请求：COSY 签名 + agent_chat_generation。
// 协议移植参考 CLI2API（MIT），来源与再分发说明见 README 和 NOTICE。
import { EXPIRY_LEAD_MS, NPM, PLACEHOLDER_BASE, PROVIDER, PROVIDER_NAME, regionOf } from "./src/constants.mjs"
import { accountLabelOf, credentialOf, expiryMs, identityOf, nearExpiry, toStored } from "./src/credential.mjs"
import { isTerminalRefreshError, redactSensitive } from "./src/errors.mjs"
import { refreshOnce, startDeviceLogin } from "./src/login.mjs"
import { fetchCatalog, liveModels, staticModels } from "./src/models.mjs"
import { chat } from "./src/chat.mjs"
import { checkinOnce, fetchUsage } from "./src/api.mjs"

const ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMTgxODI0Ii8+PHBhdGggZD0iTTMwIDM2aDY4djQ0SDU2TDMwIDk2eiIgZmlsbD0iIzY2NmVmMiIvPjxjaXJjbGUgY3g9IjUyIiBjeT0iNTgiIHI9IjUiIGZpbGw9IndoaXRlIi8+PGNpcmNsZSBjeD0iNzAiIGN5PSI1OCIgcj0iNSIgZmlsbD0id2hpdGUiLz48L3N2Zz4="
const catalogCache = new Map()
const keyOf = (credential) => `${credential.region}:${credential.uid || credential.email || credential.refresh_token || credential.access_token.slice(0, 24)}`
const fallbackModels = (models) => Object.defineProperty(models, Symbol.for("magpie.fellBack"), { value: true })

export const QwenWorkPlugin = async ({ client, fetch: fetchOverride } = {}) => {
  const fetchFn = typeof fetchOverride === "function" ? fetchOverride : fetch
  const log = (message, level = "info") => {
    try { client?.app?.log?.({ service: PROVIDER, level, message: redactSensitive(message).slice(0, 500) }) } catch { /* 无日志通道 */ }
  }

  const saveAuth = async (credential, previous) => {
    if (typeof client?.auth?.set !== "function") return false
    try {
      await client.auth.set({ path: { id: PROVIDER }, body: toStored(credential, previous) })
      return true
    } catch (error) {
      log(`凭据写回失败：${error?.message ?? error}`, "warn")
      return false
    }
  }

  const renew = async (current, previous) => {
    const next = await refreshOnce(current, { fetchFn })
    await saveAuth(next, previous)
    return next
  }

  const startLogin = (region) => {
    const session = startDeviceLogin({
      region,
      fetchFn,
      onWarning: (message) => log(message, "warn"),
    })
    return {
      url: session.url,
      opened: false,
      method: "auto",
      instructions: "请在新打开的 QwenWork 官方页面完成登录并授权；插件会自动轮询结果，最长等待 5 分钟。",
      callback: async (_code, { signal } = {}) => {
        const cancel = () => session.cancel()
        if (signal?.aborted) cancel()
        else signal?.addEventListener("abort", cancel, { once: true })
        try {
          const credential = await session.result
          return {
            type: "success",
            access: credential.access_token,
            refresh: credential.refresh_token,
            expires: expiryMs(credential),
            accountId: identityOf(credential) || accountLabelOf(credential),
            uid: credential.uid || identityOf(credential),
            email: credential.email,
            nickname: credential.nickname,
            machine_id: credential.machine_id,
            region: credential.region,
          }
        } catch (error) {
          return { type: "failed", error: redactSensitive(error?.message ?? error).slice(0, 500) }
        } finally {
          signal?.removeEventListener("abort", cancel)
        }
      },
      close: session.cancel,
    }
  }

  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: NPM,
        api: PLACEHOLDER_BASE,
        models: staticModels("global"),
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency: 3,
      refreshLead: EXPIRY_LEAD_MS,
      methods: [{
        type: "oauth",
        label: "网页登录 QwenWork（国内 / 国际站）",
        prompts: [{
          type: "select",
          key: "region",
          message: "账号所属站点",
          options: [
            { label: "国际站（qwenwork.ai）", value: "global" },
            { label: "中国站（qwenwork.cn）", value: "cn" },
          ],
        }],
        async authorize(inputs) {
          return startLogin(regionOf(inputs?.region))
        },
      }],

      async refresh(auth) {
        const credential = credentialOf(auth)
        if (!credential?.refresh_token) return undefined
        try {
          const next = await renew(credential, auth)
          return {
            access: next.access_token,
            refresh: next.refresh_token,
            expires: expiryMs(next),
            uid: next.uid || identityOf(next),
            accountId: identityOf(next) || accountLabelOf(next),
            email: next.email,
            nickname: next.nickname,
            machine_id: next.machine_id,
            region: next.region,
          }
        } catch (error) {
          if (isTerminalRefreshError(error)) throw Object.assign(new Error("QwenWork 登录已失效，请重新登录"), { signIn: "expired" })
          throw error
        }
      },

      async loader(getAuth) {
        const auth = await getAuth()
        const initial = credentialOf(auth)
        if (!initial) return {}
        return {
          baseURL: PLACEHOLDER_BASE,
          apiKey: "",
          fetch: async (input, init) => {
            const fresh = await getAuth()
            let current = credentialOf(fresh) ?? initial
            if (nearExpiry(current)) {
              try { current = await renew(current, fresh) } catch (error) { log(`临期软续期失败，沿用原凭据：${error?.message ?? error}`, "warn") }
            }
            let body
            if (typeof init?.body === "string") {
              try { body = JSON.parse(init.body) } catch { return Response.json({ error: { type: "invalid_request_error", message: "请求体不是 JSON" } }, { status: 400 }) }
            }
            if (!body || typeof body.model !== "string" || !body.model.trim()) {
              return Response.json({ error: { type: "invalid_request_error", message: "请求缺少 model" } }, { status: 400 })
            }
            body = { ...body, model: body.model.trim().replace(/^qwenwork[/:]/i, "") }
            return chat({
              credential: current,
              body,
              signal: init?.signal,
              catalogEntries: catalogCache.get(keyOf(current)) ?? [],
              fetchFn,
              renew: () => renew(current, fresh),
            })
          },
        }
      },

      async usage(getAuth) {
        const credential = credentialOf(await getAuth())
        if (!credential) return { error: "未登录", windows: [] }
        try {
          return await fetchUsage(credential, { fetchFn })
        } catch (error) {
          return {
            error: redactSensitive(error?.message ?? error).slice(0, 300),
            windows: [],
            ...(error?.kind === "auth" ? { signIn: "expired" } : {}),
          }
        }
      },

      async checkin(getAuth) {
        const credential = credentialOf(await getAuth())
        if (!credential) return { outcome: "inactive", message: "未登录 QwenWork" }
        try {
          return await checkinOnce(credential, { fetchFn })
        } catch (error) {
          return { outcome: "failed", message: redactSensitive(error?.message ?? error).slice(0, 300) }
        }
      },
    },

    provider: {
      id: PROVIDER,
      name: PROVIDER_NAME,
      async models(provider, { auth } = {}) {
        const credential = credentialOf(auth)
        const fallback = staticModels(credential?.region ?? "global")
        if (!credential) return fallbackModels(fallback)
        const key = keyOf(credential)
        try {
          const entries = await fetchCatalog(credential, { fetchFn })
          catalogCache.set(key, entries)
          return liveModels(entries)
        } catch (error) {
          if (error?.kind === "auth") throw Object.assign(new Error("QwenWork 登录已失效，请重新登录"), { signIn: "expired" })
          log(`动态模型目录失败，使用缓存或默认模型：${error?.message ?? error}`, "warn")
          const cached = catalogCache.get(key)
          return fallbackModels(cached?.length ? liveModels(cached) : fallback)
        }
      },
    },
  }
}

export default QwenWorkPlugin

export const _internal = {
  PROVIDER,
  regionOf,
  keyOf,
  catalogCache,
  staticModels,
}
