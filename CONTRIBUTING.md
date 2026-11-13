# 贡献指南 / Contributing

感谢你愿意改进本项目。提交 issue 或 pull request 前，请先阅读 [DISCLAIMER.md](./DISCLAIMER.md) 和 [SECURITY.md](./SECURITY.md)。

## 接受的贡献

- 修复 Magpie 钩子、OAuth、凭据兼容、协议解析和流式适配问题
- 增加不依赖真实账号的测试
- 改进错误分类、资源限制、取消传播和凭据脱敏
- 文档、类型说明和可维护性改进

## 不接受的贡献

- 绕过订阅、付费、额度、速率限制、验证码或其他服务控制
- 批量注册、账号池、凭据窃取、账号滥用或风控规避
- 规避检测、混淆流量、隐藏未授权访问或其他对抗性功能
- 在代码、测试、issue、PR、日志或截图中加入真实 token、授权码、Cookie、密码、私钥或账号数据

## 开发环境

需要 Node.js 18 或更新版本。本项目没有运行时 npm 依赖。

```sh
npm test
npm run check
```

测试必须完全使用 mock，不访问真实账号或官方服务。新增协议行为时，请同时增加对应的离线测试。

## Pull Request 要求

- 说明要解决的问题、修改范围和兼容性影响
- 为新行为或 bug 修复增加测试
- 保持 ESM、Node 18+ 兼容，并避免无必要的依赖
- 不要在日志、错误或测试夹具中写入真实凭据
- 涉及资源限制、重试、认证或凭据处理时，同步更新 README、README_EN 和 SECURITY.md
- 提交的内容视为按本仓库的 MIT License 授权

## 安全漏洞

不要为未修复的安全问题创建公开 issue。请按照 [SECURITY.md](./SECURITY.md) 使用 GitHub 的私密 Security Advisory 报告，并提供脱敏后的复现信息。

## English summary

Contributions are welcome for bug fixes, Magpie integration, protocol parsing, streaming, tests, documentation and security hardening. Do not contribute subscription/quota/captcha bypasses, credential theft, account abuse, detection evasion or real credentials. Use Node.js 18+, run `npm test` and `npm run check`, add mock-based tests, and report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md). Contributions are accepted under the repository's MIT License.
