# basic-loopback-app

Runnable examples showing how `@sourceloop/mastra-loopback` can be used inside a real
LoopBack application.

The example imports the adapter as `@sourceloop/mastra-loopback`, exactly as an
installed application would. It is an npm workspace of the repository, so the
package name resolves to this repository's build and every dependency is
installed once at the root. Its run scripts build the package first.

## Install

From the repository root:

```bash
npm install --ignore-scripts
```

## Run

```bash
npm run dev -w basic-loopback-app
npm run dev:agent-example -w basic-loopback-app
npm run dev:sourcefuse-auth-example -w basic-loopback-app
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
