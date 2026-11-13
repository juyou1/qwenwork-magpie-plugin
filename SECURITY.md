# 安全说明

本插件只用于自己拥有或明确获授权的 QwenWork 账号，通过官方设备授权和对应站点的官方 host 工作。它不是服务控制、验证码、额度或订阅限制的绕过工具。完整使用风险见 [DISCLAIMER.md](./DISCLAIMER.md)。

## 报告安全问题

请使用 GitHub 仓库的 **Security → Advisories → Report a vulnerability** 私密报告，不要在公开 issue、PR、讨论或截图中披露未修复漏洞或真实凭据。仓库管理员需要在 **Settings → Code security → Private vulnerability reporting** 中启用该入口；如果该入口不可用，请先通过维护者公开资料中的其他私密方式联系，不要公开漏洞细节。

报告中请提供：

- 受影响版本或 commit
- 脱敏后的复现步骤
- 影响范围（凭据泄漏、资源耗尽、请求重放等）
- 建议的修复方向（如有）

请先在上游撤销或轮换已经暴露的凭据。维护者不会通过 issue、PR 或聊天索要 access token、refresh token、授权码或密码。当前没有漏洞赏金计划，也不承诺固定响应时限。

## 支持版本

| 版本 | 支持状态 |
| --- | --- |
| 0.1.x | 当前版本，接受安全修复 |

旧版本和自行修改的版本不保证获得安全修复。

## 凭据边界

- access/refresh token 由 Magpie 的 OAuth 凭据存储保存；插件不另写 token 文件。
- 凭据只发送到所选站点的官方 gateway。`https://qwenwork.invalid/v1` 只是 SDK 路由占位符，不是网络目的地。
- COSY 临时 AES key 仅保存在内存，RSA 公钥随源码提供；请求签名仍使用原始凭据，脱敏只发生在展示层。
- 日志、错误响应、OAuth callback、额度和签到错误展示会尽力移除常见 token、Bearer、授权码、PKCE verifier 和 COSY key，并限制文本长度。不要记录请求体、授权 URL 或 header 全集；结构化凭据不能依赖字符串正则“清洗干净”后再记录。

## 资源限制

| 项目 | 默认限制 |
| --- | ---: |
| 非 SSE 完整响应 | 1 MiB |
| 单个 SSE 事件（含未完成帧） | 1 MiB |
| 首段预读缓冲 | 8 MiB |
| 非流式正文/推理/工具字符串聚合 | 8 MiB |
| 非流式工具调用数量 | 128 |

限制在字符串聚合前检查；超过限制会拒绝响应并取消底层 reader。正常流式回答没有总大小上限，避免把合法长回答截断。

首段有效内容等待上限为 30 秒。开始输出后没有总时长限制；任意上游数据（包括心跳）会重置 120 秒无数据空闲计时，因此它是空闲保护，不是整次回答的 deadline。客户端取消、首段超时、空闲超时和资源超限都会沿 signal/iterator 传递并取消底层流。

## 重试策略

聊天 POST 的通用重试次数为 0：429、500 和网络异常不会自动重放请求，避免重复计费或重复执行有副作用的模型请求。只有尚未产生有效输出的明确认证错误，才允许通过既有刷新流程重试一次；已有输出后绝不重放。额度查询等幂等 GET 仍使用传输层的有限重试。

## 公开仓库卫生

- 仓库中不应包含真实凭据、`plugin-auth.json`、`.env`、日志、抓包文件或私人账号数据；提交前检查 `.gitignore` 和 `git status`。
- 如果凭据曾进入 Git 历史，删除当前文件并不够；应先撤销或轮换凭据，再清理历史后再公开仓库。
- 提交 issue、PR 或截图时，使用 mock 值并移除授权 URL、请求 header、Cookie 和任何账号标识。

## 验证边界

`npm test` 使用 mock 和可控 ReadableStream，覆盖脱敏、响应/帧/聚合上限、取消、空闲超时和 POST 不重放；`npm run check` 做语法检查。本环境没有使用真实账号进行端到端联调，不能据此保证上游服务字段、服务端配额策略或 Magpie 宿主行为永远不变。发布前仍应在授权的 Magpie 沙箱中验证安装、登录、取消和真实流式请求。

本项目的安全说明和测试结果不构成对上游服务、Magpie 宿主或网络环境的安全保证；完整责任边界见 [DISCLAIMER.md](./DISCLAIMER.md)。

## English summary

This is an unofficial project and is not affiliated with or endorsed by Alibaba, Qwen, Qwen Work, Magpie or the CLI2API authors. Use it only with accounts you own or are expressly authorized to use. Do not use it to bypass subscriptions, quotas, captchas, rate limits or other service controls.

Report vulnerabilities privately through **Security → Advisories → Report a vulnerability**. Do not put real access tokens, refresh tokens, authorization codes, cookies, passwords, private keys or account data in issues, pull requests, logs or screenshots. Maintainers will never ask for those values through issues, pull requests or chat. Revoke or rotate any credential that may have been exposed before reporting.

The current supported version is 0.1.x. Older or locally modified versions are not guaranteed to receive security fixes. See [DISCLAIMER.md](./DISCLAIMER.md) for the full risk notice.
