import { afterAll } from 'vitest';
import { createMCPTransportTestSuite } from '@mastra/server-adapters-test-suite';

import { LoopbackMastraServer } from '../../loopback-mastra-server.js';
import { createApp, ensureStarted, stopAllApps, stopApp } from './support.js';

createMCPTransportTestSuite({
  suiteName: 'LoopBack 4 server adapter (MCP transports)',
  createServer: async mastra => {
    const app = createApp();
    await new LoopbackMastraServer({ app, mastra }).init();
    const port = Number(new URL(await ensureStarted(app)).port);
    return { server: { close: () => void stopApp(app) }, port };
  },
});

afterAll(stopAllApps);
