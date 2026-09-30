# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0

First release as an independent community package, repackaged from the
reviewed LoopBack adapter in Mastra PR #15568.

- Compatible with Mastra 1.72, LoopBack Core 7, and LoopBack REST 15;
  requires Node.js 22.13+.
- ESM and CommonJS builds with declaration files, validated by publint and
  are-the-types-wrong.
- Passes all six of Mastra's published server-adapter conformance suites
  (`@mastra/server-adapters-test-suite`), which gate CI and every release.
- Enforces Mastra RBAC permissions and FGA checks on built-in and custom
  routes, matching the official adapters.
- Supports `multipart/form-data` uploads and enforces body-size limits
  (`bodyLimitOptions`, route `maxBodySize`) with `413` responses.
- Registers Mastra routes declared with method `ALL` for each HTTP method, so
  MCP HTTP/SSE transports are reachable over real HTTP.
- `apiReqLogs` request logging now runs as LoopBack middleware for the whole
  application and writes through the Mastra logger as
  `METHOD /path STATUS DURATIONms` with `duration` in the payload, replacing
  the previous `console` output and `durationMs` field.
- Route handlers no longer receive a hidden `tools` alias (it shadowed the
  optional `tools` body field of stored agent/workspace routes); use
  `registeredTools`.
- Adds the fixes from the PR review: `204` for empty stream results, safe
  error-message exposure, default sensitive-header redaction, abort only on
  premature disconnects, and `LoopbackAuthorizationDenial` (formerly
  `LoopbackAuthorizationResult`).
