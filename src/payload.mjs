import { randomUUID } from "node:crypto"

export function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : String(content)
  return content.map((part) => {
    if (typeof part === "string") return part
    if (part?.type === "text" || part?.type === "input_text") return part.text ?? ""
    return ""
  }).join("")
}

function messageContent(message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0 && message.content == null) return ""
  return message.content ?? ""
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined
}

/** OpenAI Chat Completions → QwenWork agent_chat_generation 明文信封。 */
export function buildChatBody(request, modelKey, maxOutput = 0) {
  const systemParts = []
  const messages = []
  let lastUser = ""
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    if (message.role === "system" || message.role === "developer") {
      const text = contentText(message.content).trim()
      if (text) systemParts.push(text)
      continue
    }
    const item = { role: message.role, content: messageContent(message) }
    if (message.name) item.name = message.name
    if (message.tool_call_id) item.tool_call_id = message.tool_call_id
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) item.tool_calls = message.tool_calls
    if (message.role === "user") lastUser = contentText(message.content)
    messages.push(item)
  }
  if (messages.length === 0) messages.push({ role: "user", content: "ping" })
  if (!lastUser.trim()) lastUser = "ping"

  let maxTokens = positiveInteger(request.max_completion_tokens) ?? positiveInteger(request.max_tokens) ?? 32_000
  if (maxOutput > 0) maxTokens = Math.min(maxTokens, maxOutput)
  const parameters = { max_tokens: maxTokens }
  for (const key of ["temperature", "top_p", "stop"]) {
    if (request[key] !== undefined && request[key] !== null) parameters[key] = request[key]
  }
  const requestId = randomUUID()
  return {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: randomUUID(),
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      text: lastUser,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: false },
        originalContent: lastUser,
      },
      chatPrompt: "",
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    task_id: "common",
    session_type: "qoder_work",
    aliyun_user_type: "",
    model_config: {
      key: modelKey,
      display_name: modelKey,
      model: "",
      format: "openai",
      is_vl: true,
      is_reasoning: false,
      api_key: "",
      url: "",
      source: "system",
      max_input_tokens: 180_000,
    },
    system: systemParts.join("\n\n"),
    messages,
    tools: request.tool_choice === "none" ? [] : (Array.isArray(request.tools) ? request.tools : []),
    parameters,
    business: {
      product: "qoder_work",
      type: "agent",
      version: "1",
      feature_switches: {},
    },
  }
}
