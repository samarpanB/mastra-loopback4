import { afterAll } from 'vitest';
import { RestBindings } from '@loopback/rest';
import type { RestApplication, RouteEntry } from '@loopback/rest';
import { createHttpLoggingTestSuite } from '@mastra/server-adapters-test-suite';

import { LoopbackMastraServer } from '../../loopback-mastra-server.js';
import { createApp, executeStatusRequest, stopAllApps } from './support.js';

/** A plain LoopBack route, outside Mastra, so logging is proven to cover the whole application. */
function addRoute(
  app: RestApplication,
  method: string,
  path: string,
  handler: (req: unknown) => unknown | Promise<unknown>,
): void {
  const entry: RouteEntry = {
    verb: method.toLowerCase(),
    path,
    spec: { responses: {} },
    updateBindings: () => {},
    describe: () => `${method} ${path}`,
    invokeHandler: async requestContext => {
      const req = await requestContext.get(RestBindings.Http.REQUEST);
      const res = await requestContext.get(RestBindings.Http.RESPONSE);
      const result = (await handler(req)) as { status?: unknown; body?: unknown } | undefined;
      // Only a numeric status is a status: some suite routes return bodies like `{ status: 'ok' }`.
      if (typeof result?.status === 'number') {
        res.status(result.status).json(result.body ?? {});
      } else {
        res.status(200).json(result ?? {});
      }
      return res;
    },
  };
  app.route(entry);
}

createHttpLoggingTestSuite<RestApplication>({
  suiteName: 'LoopBack 4 server adapter (HTTP logging)',
  createApp,
  setupAdapter: (app, mastra) => ({ adapter: new LoopbackMastraServer({ app, mastra }), app }),
  addRoute,
  executeRequest: (app, method, url, options = {}) =>
    executeStatusRequest(app, method, url, {
      ...options,
      headers: { 'content-type': 'application/json', ...options.headers },
    }),
});

afterAll(stopAllApps);
