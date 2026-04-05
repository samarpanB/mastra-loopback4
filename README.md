# @mastra/loopback

Native LoopBack 4 server adapter for Mastra.

## Status

Core adapter implementation is working. Upstream hardening is in progress.

## Example App

- `/examples/basic-loopback-app` contains a runnable LoopBack app with:
  - a real `Mastra` instance
  - a custom Mastra route
  - a LoopBack service resolved from `requestContext.get('loopback')`

## LoopBack DI In Mastra

Mastra handlers receive a real Mastra `RequestContext`. The adapter injects a
LoopBack bridge into that context under the `loopback` key.

```ts
const loopback = requestContext.get('loopback');
const customerRepository = await loopback.resolve('repositories.CustomerRepository');
const customer = await customerRepository.findById(customerId);
```

This keeps request-scoped LoopBack bindings, services, repositories, and other
DI-managed artifacts available to Mastra routes, tools, and agents without
bypassing LoopBack's container.

The adapter also binds provider-backed request state into LoopBack so other
LoopBack artifacts can consume the current Mastra request state through DI:

- `providers.mastra.loopback.requestContext`
- `providers.mastra.loopback.authContext`
- `providers.mastra.loopback.abortSignal`
- `providers.mastra.loopback.bridge`

## Custom Routes

Mastra `apiRoutes` can be registered natively through LoopBack. The adapter
builds Mastra's internal custom-route handler and exposes each route through
LoopBack route entries, preserving `requestContext` and LoopBack DI.

```ts
mastra.setServer({
  apiRoutes: [
    registerApiRoute('/customer/:id', {
      method: 'GET',
      handler: async c => {
        const requestContext = c.get('requestContext');
        const loopback = requestContext.get('loopback');
        const customerService = await loopback.resolve('services.CustomerService');
        return c.json(customerService.findById(c.req.param('id')));
      },
      openapi: {
        summary: 'Get customer by id',
      },
    }),
  ],
});
```

## Auth

Mastra auth rules work against the prefixed LoopBack path, so protected/public
paths should include the adapter prefix.

```ts
mastra.setServer({
  auth: {
    protected: ['/api/mastra/secure/*', '/api/mastra/customer/*'],
    authenticateToken: async token => {
      if (token === 'valid-token') return {id: 'user-1'};
      return null;
    },
  },
});
```

Consumers can also extend or replace the adapter-managed auth behavior:

```ts
const adapter = new LoopbackMastraServer({
  app,
  mastra,
  config: {
    prefix: '/api/mastra',
    auth: {
      authorizeMode: 'after',
      authorize: async input => {
        return input.getHeader('x-tenant-id')
          ? null
          : {status: 403, error: 'Tenant header required'};
      },
      resolveContextMode: 'replace',
      resolveContext: async input => ({
        userId: input.headers['x-user-id'] as string | undefined,
      }),
    },
  },
});
```

Supported composition modes:
- `authorizeMode`: `before`, `after`, `replace`
- `resolveContextMode`: `before`, `after`, `replace`

## OpenAPI

The adapter supports Mastra's OpenAPI route generation under the configured
prefix. Custom routes are included when they define `openapi` metadata.

## Upstream PR

Upstream porting notes and the current readiness checklist are in
`docs/upstream-pr-plan.md`.

## Development

```bash
npm install
npm run build
npm run verify
```
