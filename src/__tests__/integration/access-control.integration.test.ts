import { RestApplication } from '@loopback/rest';
import { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { afterEach, describe, expect, it } from 'vitest';

import { LoopbackMastraServer } from '../../loopback-mastra-server.js';

type ServerConfig = NonNullable<ConstructorParameters<typeof Mastra>[0]>['server'];

const startedApps: RestApplication[] = [];

afterEach(async () => {
  await Promise.all(startedApps.splice(0).map(app => app.stop()));
});

const auth = {
  authenticateToken: async (token: string) => (token === 'valid-token' ? { id: 'user-1' } : null),
  // Without this, Mastra falls back to its default rules whenever RBAC is configured.
  authorizeUser: async () => true,
};

const rbac = {
  getRoles: async () => ['reader'],
  hasRole: async () => true,
  getPermissions: async () => ['agents:read', 'customers:read'],
  hasPermission: async () => true,
  hasAllPermissions: async () => true,
  hasAnyPermission: async () => true,
};

async function start(server: ServerConfig): Promise<string> {
  const mastra = new Mastra();
  mastra.setServer(server as never);
  const app = new RestApplication({ rest: { host: '127.0.0.1', port: 0 } });
  await new LoopbackMastraServer({ app, mastra, config: { prefix: '/api' } }).init();
  await app.start();
  startedApps.push(app);
  return app.restServer.url!;
}

const get = (baseUrl: string, path: string) =>
  fetch(`${baseUrl}${path}`, { headers: { authorization: 'Bearer valid-token' } });

describe('LoopbackMastraServer access control', () => {
  it('enforces Mastra RBAC permissions on built-in routes', async () => {
    const baseUrl = await start({ auth, rbac });

    expect((await get(baseUrl, '/api/agents')).status).toBe(200);

    const denied = await get(baseUrl, '/api/workflows');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: 'Forbidden', message: expect.stringContaining('workflows:read') });
  });

  it('enforces Mastra RBAC permissions on custom API routes', async () => {
    const baseUrl = await start({
      auth,
      rbac,
      apiRoutes: [
        registerApiRoute('/customers', { method: 'GET', handler: async c => c.json({ ok: true }) }),
        registerApiRoute('/invoices', { method: 'GET', handler: async c => c.json({ ok: true }) }),
      ],
    });

    expect((await get(baseUrl, '/api/customers')).status).toBe(200);
    expect((await get(baseUrl, '/api/invoices')).status).toBe(403);
  });

  it('denies protected routes without FGA metadata when the provider requires it', async () => {
    const baseUrl = await start({
      auth,
      fga: {
        requireForProtectedRoutes: true,
        check: async () => true,
        require: async () => undefined,
        filterAccessible: async <T>(_user: unknown, resources: T[]) => resources,
      },
    });

    const denied = await get(baseUrl, '/api/agents');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ message: expect.stringContaining('FGA') });
  });

  it('applies no permission checks when server auth is not configured', async () => {
    const baseUrl = await start({});

    expect((await fetch(`${baseUrl}/api/workflows`)).status).toBe(200);
  });
});
