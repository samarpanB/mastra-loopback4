import { afterAll } from 'vitest';
import { createMultipartTestSuite } from '@mastra/server-adapters-test-suite';
import type { RestApplication } from '@loopback/rest';

import { LoopbackMastraServer } from '../../loopback-mastra-server.js';
import { createApp, ensureStarted, stopAllApps, stopApp } from './support.js';

createMultipartTestSuite({
  suiteName: 'LoopBack 4 server adapter (multipart)',
  setupAdapter: async (context, options) => {
    const app = createApp();
    const adapter = new LoopbackMastraServer({
      app,
      mastra: context.mastra,
      taskStore: context.taskStore,
      bodyLimitOptions: options?.bodyLimitOptions,
    });
    await adapter.init();
    return { adapter, app };
  },
  startServer: async (app: RestApplication) => ({
    baseUrl: (await ensureStarted(app)).replace(/\/$/, ''),
    cleanup: () => stopApp(app),
  }),
  registerRoute: (adapter: LoopbackMastraServer, app, route, options) =>
    adapter.registerRoute(app, route, options ?? { prefix: '' }),
  // Nothing to apply: the adapter builds the Mastra request context inside each LoopBack route.
  getContextMiddleware: () => undefined,
  applyMiddleware: () => {},
});

afterAll(stopAllApps);
