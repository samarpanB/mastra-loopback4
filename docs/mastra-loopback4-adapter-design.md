# Design Document: Native LoopBack 4 Server Adapter for Mastra

> Note:
> This is the original design proposal.
> For the architecture currently implemented in the codebase, see
> [ARCHITECTURE.md](/Users/samarpan.bhattacharya/projects/mastra-loopback4/docs/ARCHITECTURE.md).

## 1. Overview

This document proposes a **native LoopBack 4 server adapter** for Mastra that avoids mounting an Express sub-app/router and instead integrates through LoopBack's own routing, middleware sequence, and dependency injection (DI) system.

Primary goals:
- Provide first-class support for Mastra HTTP/SSE/MCP endpoints in LoopBack 4.
- Preserve LoopBack request-scoped DI and lifecycle semantics.
- Align adapter behavior with Mastra's custom adapter contract so it can be upstreamed.

Non-goals:
- Re-implementing LoopBack's REST server internals.
- Forking Mastra core behavior.

---

## 2. Problem Statement

An Express-mounted adapter is fast to build but weakens LoopBack-native features:
- Request context is not naturally represented as LoopBack `BindingScope.REQUEST` bindings.
- Middleware/interceptor/auth composition becomes split across frameworks.
- Upstream LoopBack users expect standard LB4 extension points (providers, bindings, sequence, auth components).

A native adapter should map Mastra's route model to LB4 route registration and pass request context through LoopBack DI.

---

## 3. Requirements

### 3.1 Functional Requirements

The adapter must implement Mastra server adapter responsibilities:
- `registerContextMiddleware`
- `registerAuthMiddleware`
- `registerRoute`
- `getParams`
- `sendResponse`
- `stream`

And support Mastra response types:
- `json`
- `stream`
- `datastream-response`
- `mcp-http`
- `mcp-sse`

### 3.2 Platform Requirements

- LoopBack 4 REST server compatibility.
- Request-scoped DI for auth/context/tooling values.
- TypeScript-first API.
- Backward-compatible with existing Mastra route contracts.

### 3.3 Quality Requirements

- Deterministic behavior under streaming cancellation.
- Correct headers and flushing semantics for SSE/MCP.
- Strong error mapping (validation/auth/runtime).
- Test coverage for all response types and auth paths.

---

## 4. Proposed Architecture

## 4.1 High-Level Components

1. `LoopbackMastraServer` (main adapter class)
- Extends `MastraServer<RestApplication, Request, Response>`.
- Owns route registration and response dispatch.

2. `MastraLoopbackComponent`
- LoopBack component to register bindings and optional middleware/interceptors.
- Provides configuration binding and helper providers.

3. Request-context provider set
- Providers that bind Mastra request context into LoopBack request scope.

4. Route action bridge
- Lightweight route handler factory that converts LB4 `Request/Response` into Mastra handler input/output.

## 4.2 Why Native Registration (No Express Mount)

- Routes are registered using LoopBack's route/table API.
- Auth/context populated through LoopBack sequence/middleware and request bindings.
- Adapter respects existing LB4 middleware ordering and extension points.

---

## 5. DI and Binding Design

## 5.1 Binding Keys

```ts
export namespace MastraLoopbackBindings {
  export const CONFIG = BindingKey.create<LoopbackMastraConfig>('mastra.loopback.config');
  export const REQUEST_CONTEXT = BindingKey.create<MastraRequestContext>('mastra.loopback.requestContext');
  export const AUTH_CONTEXT = BindingKey.create<MastraAuthContext | undefined>('mastra.loopback.authContext');
  export const ABORT_SIGNAL = BindingKey.create<AbortSignal>('mastra.loopback.abortSignal');
  export const MASTRA_INSTANCE = BindingKey.create<Mastra>('mastra.loopback.instance');
}
```

Note: final key names should follow repository naming conventions and avoid whitespace typos.

## 5.2 Scopes

- `CONFIG`, Mastra instance: `SINGLETON` scope.
- `REQUEST_CONTEXT`, `AUTH_CONTEXT`, `ABORT_SIGNAL`: `REQUEST` scope.

## 5.3 Request Context Population

At request entry:
- Parse request metadata (headers/query/path/body).
- Derive abort signal from connection lifecycle.
- Resolve auth (if configured).
- Bind to request context before route handler executes.

This ensures any LoopBack provider/controller/interceptor can consume Mastra-specific values via DI.

---

## 6. Request Lifecycle

1. Incoming request hits LB4 sequence.
2. Adapter-owned route action executes for matching Mastra route.
3. Route action calls `getParams(route, req)`.
4. Route-level validation/auth checks run.
5. Mastra route handler invoked.
6. Adapter dispatches response via `sendResponse` / `stream`.
7. Completion/error triggers cleanup (abort listeners, stream close).

---

## 7. API Surface Proposal

```ts
export interface LoopbackMastraConfig {
  prefix?: string; // default: '/api/mastra'
  openapiPath?: string; // optional docs integration
  enableAuth?: boolean;
  mcp?: {
    enabled?: boolean;
    serverless?: boolean;
  };
}

export class LoopbackMastraServer extends MastraServer<RestApplication, Request, Response> {
  constructor(options: {
    app: RestApplication;
    mastra: Mastra;
    config?: LoopbackMastraConfig;
  });

  init(): Promise<void>;
  registerContextMiddleware(): void;
  registerAuthMiddleware(): void;
  registerRoute(app: RestApplication, route: ServerRoute, opts: {prefix?: string}): Promise<void>;
  getParams(route: ServerRoute, req: Request): Promise<{urlParams: object; queryParams: object; body: unknown}>;
  sendResponse(route: ServerRoute, res: Response, result: unknown): Promise<void>;
  stream(route: ServerRoute, res: Response, result: unknown): Promise<void>;
}
```

---

## 8. Route Registration Strategy

## 8.1 Route Mapping

For each Mastra `ServerRoute`:
- Compute effective path: `prefix + route.path`.
- Register corresponding HTTP verb in LoopBack route table.
- Attach generated route action that references route metadata.

## 8.2 Validation and Error Strategy

- Input validation errors -> HTTP 400 with stable error schema.
- Auth failures -> HTTP 401/403.
- Unknown runtime errors -> HTTP 500.
- Preserve Mastra error payloads where possible.

## 8.3 OpenAPI Exposure

Two options:
- Minimal: leave Mastra routes undocumented by LB4 OpenAPI initially.
- Enhanced: generate LB4 route specs from Mastra metadata and merge into app spec.

Recommendation: ship minimal first, add generated specs in follow-up.

---

## 9. Response Handling

## 9.1 `json`
- `res.status(code).json(payload)` with explicit content type.

## 9.2 `stream` / `datastream-response`
- Set chunked transfer headers.
- Write chunks incrementally.
- End on completion/cancel/error.

## 9.3 `mcp-http`
- Map Mastra MCP HTTP payload/status/headers directly.

## 9.4 `mcp-sse`
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
- Emit correctly framed SSE events.
- Flush and keep connection alive until completed/aborted.

## 9.5 Abort/Cancellation

- Listen for request close/aborted events.
- Abort in-flight handlers using bound `AbortSignal`.
- Ensure finalization is idempotent.

---

## 10. Authentication Design

## 10.1 Integration Approach

`registerAuthMiddleware` binds an auth resolver/provider that:
- Reads credentials from request.
- Calls Mastra auth hook/validator.
- Writes resolved principal/session to request scope.

## 10.2 Compatibility

- If app already has LB4 auth strategies, adapter should allow delegation.
- Config flag can disable internal auth wrapper when external auth is authoritative.

---

## 11. Testing Strategy

## 11.1 Unit Tests

- Path/verb mapping from Mastra route definition.
- `getParams` behavior (query/path/body parsing).
- `sendResponse` dispatch by response type.
- Auth/context binding population.

## 11.2 Integration Tests (LoopBack app)

- Full request -> Mastra handler -> response path for each response type.
- SSE framing and termination behavior.
- Abort behavior on client disconnect.
- Error mapping and status codes.

## 11.3 Contract/Parity Tests

- Compare behavior against an existing reference adapter (e.g., Express/Fastify).
- Ensure same payload shape/status for equivalent route definitions.

---

## 12. Packaging and Repository Layout

Suggested package layout:

```text
packages/
  loopback/
    src/
      loopback-mastra-server.ts
      component.ts
      bindings.ts
      providers/
      types.ts
    test/
      unit/
      integration/
    README.md
    package.json
```

Recommended package name: `@mastra/loopback`.

---

## 13. Upstream Contribution Plan

1. Open design issue first
- Explain why native LB4 adapter is preferable to Express mount.
- Include lifecycle/DI diagram and supported response types.

2. Submit MVP PR
- Core adapter + tests for `json` and basic `stream`.

3. Follow-up PR
- Add `mcp-http` and `mcp-sse` support + parity tests.

4. Final hardening PR
- Docs, example app, CI matrix, error compatibility polishing.

PR acceptance criteria:
- All required adapter methods implemented.
- Test coverage across response types and auth behavior.
- Clear docs and migration notes.

---

## 14. Risks and Mitigations

1. Streaming differences between LB4/Node versions
- Mitigation: CI matrix and explicit SSE integration tests.

2. Auth overlap with existing LB4 strategies
- Mitigation: pluggable auth resolver + disable flag.

3. Divergence from Mastra core adapter evolution
- Mitigation: shared adapter conformance tests and periodic parity checks.

---

## 15. Milestones

1. Week 1: MVP adapter skeleton, json route support, request DI bindings.
2. Week 2: streaming + cancellation + auth integration.
3. Week 3: MCP modes, parity tests, docs and example.
4. Week 4: upstream review fixes and release prep.

---

## 16. Open Questions

1. Should OpenAPI generation for Mastra routes be in-scope for MVP?
2. Which auth source wins when both LB4 auth and Mastra auth are configured?
3. Should adapter expose LB4 interceptor hooks around Mastra handlers by default?

---

## 17. Recommendation

Proceed with a **native LoopBack 4 adapter** as the primary implementation path. It aligns with your DI requirement, is architecturally cleaner for LoopBack users, and remains fully compatible with Mastra's adapter contract for upstream contribution.
