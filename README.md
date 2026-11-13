# QwenWork（千问办公）Magpie 插件

把你自己或已获授权的 QwenWork 账号接入 [Magpie](https://usemagpie.ai/)，让 Magpie 及其客户端通过统一的 OpenAI-compatible provider 使用它。

> **非官方项目，仅限授权账号使用。**
>
> 本项目与阿里巴巴、通义千问、千问办公、Magpie 或 CLI2API 作者无隶属、合作、授权或背书关系。不得用于绕过订阅、额度、验证码、速率限制或其他服务控制；请只使用你本人拥有或已获得明确授权的账号。使用非官方客户端可能违反上游服务条款并带来账号风险，请阅读完整的 [免责声明](./DISCLAIMER.md) 和 [安全说明](./SECURITY.md)。

本插件使用官方设备授权登录、refresh token 轮换、COSY 请求签名和 `agent_chat_generation` 流式接口。它不是 QwenWork 或 Magpie 的官方插件，也不提供绕过订阅、额度、验证码或其他服务控制的功能。

## 安装

需要 Magpie 支持的 Bun 插件运行时；本地测试只需要 Node.js 18 或更新版本，无运行时 npm 依赖。

```sh
magpie plugin add ./qwenwork-magpie-plugin
magpie plugin login qwenwork
```

也可以在 Magpie 窗口的 **Plugins → Add a plugin** 中选择本目录，然后在 provider 行点击登录。登录时选择账号所属站点：

- **国际站**：`qwenwork.ai` / `gateway.qwenwork.ai`
- **中国站**：`qwenwork.cn` / `gateway.qwenwork.cn`

Magpie 会打开官方授权 URL。完成授权后，插件自动轮询设备授权结果，最长等待 5 分钟；不要把授权码、access token 或 refresh token 发到聊天中。

登录后检查：

```sh
magpie plugin
magpie provider test qwenwork
magpie quota
```

模型名称使用 `qwenwork/<模型 key>`。动态目录可用时，插件读取账号实际返回的 `qwork` 列表；目录不可用时会标记 fallback 并保留默认模型：

| 站点 | 默认模型 key | 调用名称 |
| --- | --- | --- |
| 国际站 | `qwork-advanced` | `qwenwork/qwork-advanced` |
| 中国站 | `pro` | `qwenwork/pro` |

模型 key 原样传给 QwenWork，不会把 `pro` 猜测映射成其他上游模型。动态目录的失败不会清空 Magpie 已有的模型列表。

## 凭据与安全

- 凭据由 Magpie 保存在其配置目录的 `plugin-auth.json`（通常权限为 `0600`），不是本插件单独写入的明文文件。
- 登录使用 `GET /api/v1/deviceToken/poll`，刷新使用 `POST /api/v1/deviceToken/refresh`，并读取官方 `userinfo` 补齐账号标识。
- access token 临近过期时软刷新；并发请求共享一次刷新，避免 refresh token 被重复消费。终态的 `invalid_grant` 等错误会标记需要重新登录。
- 每个 access token 使用独立的临时 AES 密钥生成 COSY 身份；密钥只在内存中缓存，token 轮换后重新生成。RSA 公钥随源码提供，私钥和 token 不写入日志。
- 进入错误响应、OAuth callback 和日志的文本会做常见凭据形态脱敏（token、授权码、PKCE verifier、Bearer、COSY key 等），并限制错误文本长度；日志不得记录请求体或授权参数。脱敏是展示层保护，不应把敏感值主动写入日志。
- 凭据只会发送到对应站点的官方 host。Magpie 配置中的 `https://qwenwork.invalid/v1` 是故意的 placeholder base URL，用来让 SDK 进入本插件的 `fetch` 适配器；不会向这个 placeholder 发起 DNS/HTTP 请求。
- 请仅使用自己拥有或明确获授权的账号。插件不会自动解决验证码；签到遇到验证码时会返回 `captcha`，请在官方客户端完成。

兼容读取 snake_case、camelCase、嵌套 `data`/`credential` 和部分旧格式凭据。保存时统一为 Magpie OAuth 字段：原始 `access`、`refresh`、毫秒级 `expires`，并保留 `uid`、`accountId`、`email`、`nickname`、`machine_id`、`region` 等元数据。旧格式有 refresh token 但缺少有效到期时间时，首次使用可尝试刷新一次；没有任何可用 refresh token 时不会伪造续期。

## 请求行为

- 使用当前桌面协议的 `request_id`、`session_id`、`chat_context`、`model_config` 等信封字段。
- system/developer 消息合并到 `system`，多轮消息和工具调用保留；纯工具调用的空 assistant content 会规范化为字符串。
- 上游按 SSE 请求；插件解析外层 `{headers, body, statusCodeValue}` 包装和常见平铺 chunk，保留增量文本与 `tool_calls` 分片。
- Magpie 请求非流式时，本地聚合成 OpenAI `chat.completion`；请求流式时输出 OpenAI chunk 和 `[DONE]`。
- 首段前的上游错误转换为 HTTP 错误；已有输出后的错误以 error chunk 加 `[DONE]` 结束，避免丢失已生成内容。
- 非 SSE 响应最多读取 1 MiB；SSE 单帧最多 1 MiB；首段预读和非流式聚合最多保留 8 MiB，工具调用最多 128 个。超限会拒绝并取消底层读取，不会先无界读完再截断。
- 首段有效内容等待上限为 30 秒；开始输出后没有总时长或总大小上限，流式正文可持续传输。任意上游数据（包括心跳）会重置 120 秒无数据空闲计时；这不是整个回答的总时长限制。客户端取消、空闲超时和超限都会联动取消底层流。
- 401/402/403、429、模型不可用、配额和服务不可用分别分类；聊天 POST 不对 429、500 或网络异常做通用自动重试，仅在尚未输出时允许明确认证错误触发一次刷新重试，不会在已产生输出后重放请求。
- `usage` 和 `checkin` 使用官方额度/签到端点，结果以 Magpie 的 quota/check-in 形状返回；接口不可用时报告错误或 inactive，不伪造额度。

## 本地测试

```sh
node --test test/*.test.mjs
# 或
npm test
```

测试完全使用 mock，不需要真实账号，也不会访问官方服务。覆盖 PKCE、设备轮询、凭据兼容与刷新去重、RSA/AES COSY、模型目录、请求信封、SSE 工具调用、错误帧、direct JSON、Magpie loader、usage 和签到，以及脱敏、响应/帧/聚合上限、空闲取消和聊天 POST 不重放。

## 参与贡献与安全

- 提交代码或 issue 前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。
- 遇到安装、兼容性或使用问题，请先看 [SUPPORT.md](./SUPPORT.md)。
- 不要在公开 issue、PR、日志或截图中提交真实 access token、refresh token、授权码、Cookie 或账号信息。
- 安全漏洞请通过 GitHub 的私密 Security Advisory 报告，不要先公开披露；具体方式见 [SECURITY.md](./SECURITY.md)。
- 公开使用和分发前，请阅读完整的 [DISCLAIMER.md](./DISCLAIMER.md)。

## 验证范围与许可

已进行语法检查和隔离 mock 测试；未在本环境中使用真实 QwenWork 账号做端到端联调，因此上游字段、额度或签到策略仍可能随服务端变化。发布前请在自己的 Magpie 沙箱中运行 `magpie plugin add`、`magpie plugin login` 和 `magpie provider test`。

安全边界和资源限制见 [SECURITY.md](./SECURITY.md)；完整免责声明见 [DISCLAIMER.md](./DISCLAIMER.md)；协议参考和许可见 [NOTICE](./NOTICE)。本包及参考代码按随附的 MIT License 分发。

[English README](./README_EN.md)
