# basic-loopback-app

Runnable examples showing how `@mastra/loopback` can be used inside a real
LoopBack application.

The examples import the built adapter artifact from the repo root, so the
scripts refresh the root package before starting.

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

## Run Agent Example

```bash
npm run dev:agent-example
```

## Run SourceFuse Auth Example

```bash
npm run dev:sourcefuse-auth-example
```

## Notes

- Routes are mounted with the adapter prefix `/api/mastra`.
- The example registers a Mastra custom API route at `/customer/:id`.
- LoopBack bindings remain request-scoped. Inside a Mastra route, tool, or agent:

```ts
const loopback = requestContext.get('loopback');
const customerService = await loopback.resolve('services.CustomerService');
const customer = customerService.findById('customer-1');
```

## Concrete Agent Example

`src/repository-tool-agent-route-example.ts` demonstrates:

1. a LoopBack repository backed by an in-memory datasource
2. a Mastra tool that resolves that repository from `requestContext`
3. a Mastra agent that uses the tool
4. a Mastra route that invokes the agent and returns the output

Route exposed by that example:

```text
/api/mastra/agent/customer-summary/:id
```

## SourceFuse JWT Auth Example

`src/sourcefuse-auth-jwt-example.ts` demonstrates:

1. `loopback4-authentication` bearer-token verification
2. `loopback4-authorization` permission checks
3. adapter-level auth composition through `config.auth`
4. Mastra routes that resolve LoopBack services after JWT auth succeeds

Routes exposed by that example:

```text
/auth/token/{username}
/api/mastra/public/ping
/api/mastra/customer/{id}
/api/mastra/whoami
/api/mastra/admin/report
```

Demo flow:

1. Fetch a token:

```bash
curl http://127.0.0.1:3002/auth/token/ada
```

2. Call a protected Mastra route:

```bash
curl \
  -H "Authorization: Bearer <token>" \
  http://127.0.0.1:3002/api/mastra/customer/cust-1
```

3. Try the admin route with the `admin` token:

```bash
curl \
  -H "Authorization: Bearer <admin-token>" \
  http://127.0.0.1:3002/api/mastra/admin/report
```
