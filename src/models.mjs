import { NPM, PATHS, PLACEHOLDER_BASE, REQUEST_TIMEOUT_MS, siteFor } from "./constants.mjs"
import { asQwenWorkError, classifyError } from "./errors.mjs"
import { signedHeaders } from "./cosy.mjs"
import { fetchWithRetry, readTextLimited } from "./transport.mjs"

export function normalizeCatalogModel(raw) {
  if (!raw || typeof raw !== "object" || raw.enable === false) return undefined
  const id = String(raw.key ?? "").trim()
  if (!id) return undefined
  const context = Number(raw.max_input_tokens)
  const output = Number(raw.max_output_tokens)
  return {
    id,
    name: String(raw.display_name ?? "").trim() || id,
    contextWindow: Number.isFinite(context) && context > 0 ? context : 128_000,
    maxTokens: Number.isFinite(output) && output > 0 ? output : 8_192,
    supportsImage: raw.is_vl === true,
    reasoning: raw.is_reasoning === true,
    ...(typeof raw.credits === "string" && raw.credits.trim() ? { rate: raw.credits.trim() } : {}),
  }
}

export function parseModelCatalog(body) {
  const parsed = typeof body === "string" ? JSON.parse(body) : body
  if (!Array.isArray(parsed?.qwork)) throw new Error("QwenWork 模型目录缺少 qwork 数组")
  const entries = parsed.qwork.map(normalizeCatalogModel).filter(Boolean)
  if (entries.length === 0) throw new Error("QwenWork 模型目录没有可用模型")
  return entries
}

export function modelEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    api: { id: entry.id, url: PLACEHOLDER_BASE, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    ...(entry.rate ? { rate: entry.rate } : {}),
    limit: { context: entry.contextWindow, output: entry.maxTokens },
    capabilities: {
      temperature: true,
      reasoning: entry.reasoning === true,
      attachment: entry.supportsImage === true,
      toolcall: true,
      tool_call: true,
      input: { text: true, image: entry.supportsImage === true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
      maxTokens: entry.maxTokens,
    },
    variants: {},
    release_date: "",
  }
}

export function liveModels(entries) {
  return Object.fromEntries(entries.map((entry) => [entry.id, modelEntry(entry)]))
}

export function staticModels(region = "global") {
  const site = siteFor(region)
  return liveModels([normalizeCatalogModel({
    key: site.defaultModel,
    display_name: site.defaultModel,
    max_input_tokens: 128_000,
    max_output_tokens: 8_192,
    is_vl: true,
    is_reasoning: false,
  })])
}

export async function fetchCatalog(credential, { fetchFn = fetch, signal } = {}) {
  const site = siteFor(credential.region)
  const endpoint = `${site.gateway}${PATHS.modelList}`
  const response = await fetchWithRetry(() => fetchFn(endpoint, {
    method: "GET",
    headers: signedHeaders({ site, credential, endpoint, accept: "application/json" }),
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }))
  const text = await readTextLimited(response)
  if (!response.ok) throw asQwenWorkError(response.status, text)
  const classified = classifyError(200, text)
  if (classified) throw classified
  return parseModelCatalog(text)
}
