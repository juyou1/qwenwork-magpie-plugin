# QwenWork (Qwen Work) Magpie plugin

Connect your own, or explicitly authorized, QwenWork account to [Magpie](https://usemagpie.ai/). Magpie and its clients can then use it through a normal OpenAI-compatible provider.

> **Unofficial project. Authorized accounts only.**
>
> This project is not affiliated with, authorized by or endorsed by Alibaba, Qwen, Qwen Work, Magpie or the CLI2API authors. It must not be used to bypass subscriptions, quotas, captchas, rate limits or other service controls. Use it only with accounts you own or are expressly authorized to use. Using an unofficial client may violate upstream terms and create account risk; read the full [disclaimer](./DISCLAIMER.md) and [security notes](./SECURITY.md).

The plugin implements official device authorization, refresh-token rotation, COSY request signing and the `agent_chat_generation` streaming API. It is not an official QwenWork or Magpie plugin and does not bypass subscriptions, quotas, captchas or other service controls.

## Install and sign in

Magpie supplies the Bun plugin runtime. Local tests need only Node.js 18 or newer; there are no runtime npm dependencies.

```sh
magpie plugin add ./qwenwork-magpie-plugin
magpie plugin login qwenwork
```

Alternatively, choose this folder in **Plugins → Add a plugin** in the Magpie window and sign in from the provider row. Select the site for your account:

- **Global**: `qwenwork.ai` / `gateway.qwenwork.ai`
- **China**: `qwenwork.cn` / `gateway.qwenwork.cn`

Magpie opens the official authorization URL. After you authorize it, the plugin polls the device grant for up to five minutes. Never paste an authorization code, access token or refresh token into a chat.

Check the installation with:

```sh
magpie plugin
magpie provider test qwenwork
magpie quota
```

Use `qwenwork/<model key>` as the model name. When available, the plugin reads the account's actual `qwork` catalog. If the catalog cannot be read, it marks the result as a fallback and retains a default model:

| Site | Default model key | Provider/model name |
| --- | --- | --- |
| Global | `qwork-advanced` | `qwenwork/qwork-advanced` |
| China | `pro` | `qwenwork/pro` |

Model keys are sent unchanged. In particular, `pro` is not guessed to mean a different upstream model. A catalog failure does not erase the model list Magpie already has.

## Credentials and security

- Magpie stores credentials in `plugin-auth.json` in its config directory (normally mode `0600`); this plugin does not create a separate plaintext token file.
- Sign-in uses `GET /api/v1/deviceToken/poll`; renewal uses `POST /api/v1/deviceToken/refresh`, with official `userinfo` used to complete the account identity.
- Near-expiry access tokens are refreshed softly. Concurrent requests share one renewal so a single-use refresh token is not consumed twice. Terminal `invalid_grant`-style failures mark the account for sign-in again.
- Each access token gets its own temporary AES key for the COSY identity. Keys are cached only in memory and regenerated after token rotation. The source contains the RSA public key; private keys and tokens are not logged.
- Text entering error responses, OAuth callbacks and logs is redacted for common credential shapes (tokens, authorization codes, PKCE verifiers, Bearer values and COSY keys) and length-limited. Request bodies and authorization parameters must not be logged; redaction is display protection, not a reason to log secrets.
- Credentials are sent only to the official host for the selected site. The configured `https://qwenwork.invalid/v1` is an intentional SDK placeholder that routes requests into this plugin's `fetch`; it is never used as a DNS/HTTP destination.
- Use only accounts you own or are explicitly authorized to access. Captchas are never solved automatically: check-in returns `captcha`, and you should complete it in the official client.

The loader accepts snake_case, camelCase, nested `data`/`credential` values and several legacy credential shapes. Saved credentials use Magpie's OAuth fields: raw `access`, `refresh`, millisecond `expires`, plus `uid`, `accountId`, `email`, `nickname`, `machine_id` and `region` metadata. A legacy value with a refresh token but no usable expiry can be refreshed once on first use; a missing refresh token is never treated as a successful renewal.

## Request behavior

- Builds the current desktop envelope with `request_id`, `session_id`, `chat_context`, `model_config` and related fields.
- Merges system/developer messages into `system`, preserves multi-turn messages and tool calls, and normalizes empty assistant content for pure tool calls.
- Requests SSE upstream and decodes both the outer `{headers, body, statusCodeValue}` wrapper and common flat chunks, preserving text and fragmented `tool_calls`.
- Aggregates locally into an OpenAI `chat.completion` for non-streaming Magpie requests; streaming requests receive OpenAI chunks and `[DONE]`.
- Errors before the first delta become HTTP errors. After output has started, an error becomes an error chunk followed by `[DONE]`, without discarding content already emitted.
- Non-SSE responses are capped at 1 MiB, individual SSE frames at 1 MiB, first-chunk buffering and non-streaming aggregation at 8 MiB, and tool calls at 128. Limits reject and cancel the underlying read rather than reading unboundedly and truncating afterward.
- Waiting for the first meaningful delta is capped at 30 seconds. After output begins there is no total-duration or total-size limit for streaming answers. Any upstream data, including a heartbeat, resets the 120-second no-data idle timer; this is not a whole-response deadline. Client cancellation, idle timeout and limit violations cancel the underlying stream.
- Authentication/payment, rate-limit, model-availability, quota and service failures are classified separately. Chat POSTs are not generically retried on 429, 500 or network errors; only a definite authentication failure before output may trigger one refresh/retry, and a request that already produced output is never replayed.
- `usage` and `checkin` call the official quota/check-in endpoints and return Magpie's shapes. Unavailable endpoints report an error or inactive state rather than inventing a balance.

## Local tests

```sh
node --test test/*.test.mjs
# or
npm test
```

All tests are mock-only: no real account and no official network access are needed. Coverage includes PKCE, device polling, legacy credentials, refresh deduplication, RSA/AES COSY, catalogs, request envelopes, streaming tool calls, error frames, direct JSON, the Magpie loader, usage, check-in, redaction, response/frame/aggregate limits, idle cancellation and chat POST no-replay behavior.

## Contributing and security

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) before opening a pull request or issue.
- See [SUPPORT.md](./SUPPORT.md) for installation, compatibility and usage help.
- Never include real access tokens, refresh tokens, authorization codes, cookies or account data in public issues, pull requests, logs or screenshots.
- Report vulnerabilities privately through GitHub Security Advisories; see [SECURITY.md](./SECURITY.md).
- Read the full [disclaimer](./DISCLAIMER.md) before public use or redistribution.

## Verification scope and license

Syntax checks and isolated mock tests have been run. No real QwenWork account was used for end-to-end testing in this environment, so upstream fields, quota behavior and check-in policy can still change server-side. Before publishing, run `magpie plugin add`, `magpie plugin login` and `magpie provider test` in your own Magpie sandbox.

See [SECURITY.md](./SECURITY.md) for security boundaries and resource limits, [DISCLAIMER.md](./DISCLAIMER.md) for the full risk notice, and [NOTICE](./NOTICE) for protocol provenance and licensing. This package and the referenced code are distributed under the included MIT License.

[中文说明](./README.md)
