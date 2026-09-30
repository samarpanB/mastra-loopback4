import { afterAll } from 'vitest';
import { createBodyLimitTestSuite } from '@mastra/server-adapters-test-suite';
import type { RestApplication } from '@loopback/rest';

import { LoopbackMastraServer } from '../../loopback-mastra-server.js';
import { createApp, executeChunkedStatusRequest, executeStatusRequest, stopAllApps, stopApp } from './support.js';

createBodyLimitTestSuite<RestApplication>({
  suiteName: 'LoopBack 4 server adapter (body limit)',
  createApp,
  setupAdapter: (app, mastra, bodyLimitOptions) => ({
    adapter: new LoopbackMastraServer({ app, mastra, bodyLimitOptions }),
    app,
  }),
  registerRoute: (adapter: LoopbackMastraServer, app, route) => adapter.registerRoute(app, route, { prefix: '' }),
  executeRequest: executeStatusRequest,
  executeRequestWithoutContentLength: executeChunkedStatusRequest,
  cleanupApp: stopApp,
});

afterAll(stopAllApps);
