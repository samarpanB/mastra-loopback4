# @sourceloop/mastra-loopback

Community-maintained [LoopBack 4](https://loopback.io/) server adapter for
[Mastra](https://mastra.ai/). It mounts Mastra's server routes directly on a
`RestApplication` while preserving LoopBack request context and dependency
injection.

## Install

```bash
npm install @sourceloop/mastra-loopback @mastra/core @loopback/core @loopback/rest
```

Node.js 22.13 or newer is required. This release targets Mastra 1.72 and newer
1.x releases, LoopBack Core 7, and LoopBack REST 15.

## Quick start

```ts
import { RestApplication } from '@loopback/rest';
import { Mastra } from '@mastra/core';
import { LoopbackMastraServer } from '@sourceloop/mastra-loopback';

const app = new RestApplication({
  rest: { host: '0.0.0.0', port: 3000 },
});
const mastra = new Mastra();

const adapter = new LoopbackMastraServer({
  app,
  mastra,
  config: { prefix: '/api/mastra' },
});

await adapter.init();
await app.start();
```

The package publishes both ESM and CommonJS entry points with TypeScript
declarations.

## LoopBack DI in Mastra

Mastra handlers receive a real Mastra `RequestContext`. The adapter injects a
LoopBack bridge under the `loopback` key:

```ts
const loopback = requestContext.get('loopback');
const customerRepository = await loopback.resolve(
  'repositories.CustomerRepository',
);
const customer = await customerRepository.findById(customerId);
```

This keeps request-scoped bindings, services, repositories, and other
DI-managed artifacts available to Mastra routes, tools, and agents. The
adapter also exposes the current Mastra state to LoopBack through these
bindings:

- `providers.mastra.loopback.requestContext`
- `providers.mastra.loopback.authContext`
- `providers.mastra.loopback.abortSignal`
- `providers.mastra.loopback.bridge`

## Custom routes

Mastra `apiRoutes` are registered as native LoopBack route entries while
preserving request context and DI:

```ts
import { registerApiRoute } from '@mastra/core/server';

mastra.setServer({
  apiRoutes: [
    registerApiRoute('/customer/:id', {
      method: 'GET',
      handler: async c => {
        const requestContext = c.get('requestContext');
        const loopback = requestContext.get('loopback');
        const service = await loopback.resolve('services.CustomerService');
        return c.json(await service.findById(c.req.param('id')));
      },
      openapi: { summary: 'Get customer by id' },
    }),
  ],
});
```

## Auth

Mastra's server auth configuration works normally. Adapter-specific hooks can
compose with it before, after, or in place of the default behavior:

```ts
const adapter = new LoopbackMastraServer({
  app,
  mastra,
  config: {
    prefix: '/api/mastra',
    auth: {
      authorizeMode: 'after',
      authorize: async input =>
        input.getHeader('x-tenant-id')
          ? null
          : { status: 403, error: 'Tenant header required' },
      resolveContextMode: 'replace',
      resolveContext: async input => ({
        userId: input.headers['x-user-id'] as string | undefined,
      }),
    },
  },
});
```

See [HOW-TO-USE.md](./HOW-TO-USE.md) for full integration patterns and
[examples/basic-loopback-app](./examples/basic-loopback-app) for runnable
examples.

## Supported behavior

- Mastra JSON, streamed, data-stream, MCP HTTP, and MCP SSE responses
- Mastra custom API routes
- Mastra auth, RBAC permissions, and FGA checks, plus optional LoopBack-aware
  auth composition
- `multipart/form-data` uploads (files arrive as `Buffer`s, JSON fields decoded)
- Body-size limits via `bodyLimitOptions` or a route's `maxBodySize` (`413`)
- Request cancellation and stream redaction
- Mastra `apiReqLogs` request logging through the Mastra logger
- Custom route prefixes
- LoopBack request-scoped dependency injection

Request logging is registered as LoopBack middleware, so it covers every
request on the application (as `app.use` does for the Express adapter) and
needs LoopBack's default `MiddlewareSequence`.

## Conformance

The adapter runs all six of Mastra's published server-adapter conformance
suites from
[`@mastra/server-adapters-test-suite`](https://www.npmjs.com/package/@mastra/server-adapters-test-suite):
route parity against the live `SERVER_ROUTES` table, MCP routes, MCP
transports, multipart, body limits, and HTTP logging. Against Mastra 1.72.0 and
suite 0.1.1 every check passes, and CI runs them on every change and before
every release.

## Development

```bash
npm install --ignore-scripts
npm run verify
```

`npm run verify` type-checks, runs the unit, integration, and conformance
suites, and builds both package formats with publint and
are-the-types-wrong. `npm run test:conformance` runs only the conformance
suites.

## Releasing

Releases publish from `main` only.

1. In a PR, bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Merge it to `main`.

On every push to `main`, the release workflow checks whether that version is
already on npm. If it is not, it reruns the full CI (conformance included) on
the merged commit, publishes with npm trusted publishing (OIDC, with
provenance), and then creates the `v<version>` tag and GitHub release. Merges
that do not change the version publish nothing.

One-time setup, which is what makes "main only" enforced by GitHub and npm
rather than by the workflow alone:

- Create an `npm` environment in the repository settings and limit its
  deployment branches to `main`.
- Register this repository, `release.yml`, and the `npm` environment as the
  trusted publisher for the package on npmjs.com.

## License

[MIT](./LICENSE)
