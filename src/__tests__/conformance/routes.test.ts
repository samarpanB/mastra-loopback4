import { afterAll } from 'vitest';
import { createMCPRouteTestSuite, createRouteAdapterTestSuite } from '@mastra/server-adapters-test-suite';

import { executeHttpRequest, setupAdapter, stopAllApps } from './support.js';

createRouteAdapterTestSuite({
  suiteName: 'LoopBack 4 server adapter',
  setupAdapter,
  executeHttpRequest,
  emptyBodyNormalization: {
    withoutContentType: 'undefined',
    withJsonContentType: 'empty-object',
  },
});

createMCPRouteTestSuite({
  suiteName: 'LoopBack 4 server adapter (MCP routes)',
  setupAdapter,
  executeHttpRequest,
});

afterAll(stopAllApps);
