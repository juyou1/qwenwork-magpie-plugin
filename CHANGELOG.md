# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-11-13

### Added

- Magpie plugin configuration, OAuth device login, token refresh, credential loader, usage and check-in hooks.
- Dynamic Qwen Work model catalog with static fallback models.
- COSY request signing using an RSA public key and per-access-token temporary AES identity keys.
- OpenAI-compatible chat completions, SSE streaming, tool calls, reasoning content and non-stream aggregation.

### Security

- Added bounded, cancellable reads for non-SSE responses, SSE frames, pre-read buffering and non-stream aggregation.
- Added redaction for tokens, authorization values, OAuth codes, PKCE verifiers and COSY keys at error, log and callback boundaries.
- Disabled generic retries for chat POST requests to avoid duplicate generation or quota consumption.
- Added idle, first-content and cancellation propagation for upstream streams.

### Verification

- 26 mock-based tests pass.
- Syntax check passes for all source, script and test files.
