import type {Provider} from '@loopback/core';
import {RestBindings, RestApplication, type OperationObject, type RouteEntry} from '@loopback/rest';
import {Mastra} from '@mastra/core';
import {registerApiRoute} from '@mastra/core/server';
import jwt from 'jsonwebtoken';
import {
  AuthenticationBindings,
  AuthenticationComponent,
  Strategies,
  type VerifyFunction,
} from 'loopback4-authentication';
import {
  AuthorizationBindings,
  AuthorizationComponent,
  type AuthorizationMetadata,
  type AuthorizeFn,
  type IAuthUserWithPermissions,
} from 'loopback4-authorization';

import {LoopbackMastraServer, type LoopbackMastraBridge} from '@sourceloop/mastra-loopback';

type DemoUser = IAuthUserWithPermissions & {
  tenantId: string;
};

type JwtPayload = {
  sub: string;
  user: DemoUser;
};

const JWT_SECRET = 'sourcefuse-loopback-mastra-demo-secret';

const DEMO_USERS: Record<string, DemoUser> = {
  ada: {
    id: 'ada',
    username: 'ada',
    firstName: 'Ada',
    lastName: 'Lovelace',
    role: 'support',
    permissions: ['customer:read'],
    authClientId: 1,
    tenantId: 'tenant-acme',
  },
  admin: {
    id: 'admin',
    username: 'admin',
    firstName: 'Grace',
    lastName: 'Hopper',
    role: 'admin',
    permissions: ['customer:read', 'admin:read'],
    authClientId: 1,
    tenantId: 'tenant-acme',
  },
};

class CustomerService {
  findById(id: string): {id: string; name: string; tier: string} {
    return {
      id,
      name: id === 'cust-1' ? 'Ada Lovelace' : 'Grace Hopper',
      tier: id === 'cust-1' ? 'enterprise' : 'admin',
    };
  }
}

class JwtBearerVerifyProvider
  implements Provider<VerifyFunction.BearerFn<DemoUser>>
{
  value(): VerifyFunction.BearerFn<DemoUser> {
    return async token => {
      try {
        const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
        return payload.user;
      } catch {
        return null;
      }
    };
  }
}

function createAuthorizationMetadata(path: string): AuthorizationMetadata | undefined {
  if (/^\/api\/mastra\/customer\/[^/]+$/.test(path)) {
    return {permissions: ['customer:read']};
  }

  if (path === '/api/mastra/whoami') {
    return {permissions: ['customer:read', 'admin:read']};
  }

  if (path === '/api/mastra/admin/report') {
    return {permissions: ['admin:read']};
  }

  return undefined;
}

function issueToken(user: DemoUser): string {
  return jwt.sign(
    {
      sub: String(user.id ?? user.username),
      user,
    } satisfies JwtPayload,
    JWT_SECRET,
    {
      expiresIn: '1h',
      audience: 'sourceloop-mastra-loopback-demo',
      issuer: 'sourcefuse-auth-example',
    },
  );
}

function registerTokenRoutes(app: RestApplication): void {
  const tokenByUserSpec: OperationObject = {
    responses: {
      '200': {description: 'Demo token response'},
      '404': {description: 'Demo user not found'},
    },
    parameters: [
      {
        name: 'username',
        in: 'path',
        required: true,
        schema: {type: 'string'},
      },
    ],
  };

  const tokenRoute: RouteEntry = {
    verb: 'get',
    path: '/auth/token/{username}',
    spec: tokenByUserSpec,
    updateBindings: requestContext => {
      requestContext.bind(RestBindings.OPERATION_SPEC_CURRENT).to(tokenByUserSpec);
    },
    invokeHandler: async requestContext => {
      const req = await requestContext.get(RestBindings.Http.REQUEST);
      const res = await requestContext.get(RestBindings.Http.RESPONSE);
      const username = req.params.username as string;
      const user = DEMO_USERS[username];

      if (!user) {
        res.status(404).json({
          error: 'Demo user not found',
          availableUsers: Object.keys(DEMO_USERS),
        });
        return res;
      }

      res.json({
        username,
        token: issueToken(user),
        permissions: user.permissions,
      });
      return res;
    },
    describe: () => 'GET /auth/token/{username}',
  };

  app.route(tokenRoute);
}

async function main(): Promise<void> {
  const app = new RestApplication({
    rest: {
      host: '0.0.0.0',
      port: 3002,
    },
  });

  app.bind(AuthorizationBindings.CONFIG).to({
    allowAlwaysPaths: ['/auth/token'],
  });
  app.component(AuthenticationComponent);
  app.component(AuthorizationComponent);
  app.bind(Strategies.Passport.BEARER_TOKEN_VERIFIER).toProvider(JwtBearerVerifyProvider);
  app.bind('services.CustomerService').to(new CustomerService());

  registerTokenRoutes(app);

  const mastra = new Mastra();
  mastra.setServer({
    apiRoutes: [
      registerApiRoute('/public/ping', {
        method: 'GET',
        handler: async c => c.json({ok: true}),
        openapi: {
          summary: 'Public health route with no auth',
        },
      }),
      registerApiRoute('/customer/:id', {
        method: 'GET',
        handler: async c => {
          const requestContext = c.get('requestContext');
          const loopback = requestContext.get('loopback') as LoopbackMastraBridge;
          const customerService = await loopback.resolve<CustomerService>('services.CustomerService');
          const user = requestContext.get('user') as DemoUser;

          return c.json({
            customer: customerService.findById(c.req.param('id')),
            user: {
              id: user.id,
              username: user.username,
              permissions: user.permissions,
            },
          });
        },
        openapi: {
          summary: 'Protected customer route requiring customer:read',
        },
      }),
      registerApiRoute('/whoami', {
        method: 'GET',
        handler: async c => {
          const requestContext = c.get('requestContext');
          const auth = requestContext.get('auth');
          const user = requestContext.get('user') as DemoUser;

          return c.json({
            auth,
            user,
          });
        },
        openapi: {
          summary: 'Return the authenticated SourceFuse JWT user and adapter auth context',
        },
      }),
      registerApiRoute('/admin/report', {
        method: 'GET',
        handler: async c => {
          const requestContext = c.get('requestContext');
          const user = requestContext.get('user') as DemoUser;

          return c.json({
            report: 'admin-only analytics',
            user: {
              id: user.id,
              permissions: user.permissions,
            },
          });
        },
        openapi: {
          summary: 'Protected admin route requiring admin:read',
        },
      }),
    ],
  });

  const adapter = new LoopbackMastraServer({
    app,
    mastra,
    config: {
      prefix: '/api/mastra',
      openapiPath: '/openapi.json',
      auth: {
        enabled: true,
        authorizeMode: 'replace',
        authorize: async input => {
          const loopback = input.requestContext.get('loopback') as LoopbackMastraBridge;
          const authHeader = input.getHeader('authorization');
          const token = authHeader?.startsWith('Bearer ')
            ? authHeader.slice('Bearer '.length)
            : undefined;

          if (!token) {
            return {status: 401, error: 'Missing bearer token'};
          }

          const verifyBearer = await loopback.resolve<VerifyFunction.BearerFn<DemoUser>>(
            Strategies.Passport.BEARER_TOKEN_VERIFIER,
          );
          const user = await verifyBearer(token, input.request);
          if (!user) {
            return {status: 401, error: 'Invalid or expired token'};
          }

          input.requestContext.set('user', user);
          loopback.context.bind(AuthenticationBindings.CURRENT_USER).to(user);

          const metadata = createAuthorizationMetadata(input.path);
          if (!metadata) {
            return null;
          }

          loopback.context.bind(AuthorizationBindings.METADATA).to(metadata);
          const authorizeAction = await loopback.resolve<AuthorizeFn>(
            AuthorizationBindings.AUTHORIZE_ACTION,
          );
          const isAllowed = await authorizeAction(user.permissions, input.request as never);
          if (!isAllowed) {
            return {status: 403, error: 'Not allowed'};
          }

          return null;
        },
        resolveContextMode: 'replace',
        resolveContext: async input => {
          const user = input.requestContext.get('user') as DemoUser | undefined;
          if (!user) {
            return undefined;
          }

          return {
            userId: String(user.id ?? user.username),
            scopes: user.permissions,
            raw: user,
          };
        },
      },
    },
  });

  await adapter.init();
  await app.start();

  const baseUrl = app.restServer.url;
  const adaToken = issueToken(DEMO_USERS.ada);
  const adminToken = issueToken(DEMO_USERS.admin);

  console.log(`LoopBack app started at ${baseUrl}`);
  console.log(`OpenAPI route: ${baseUrl}/api/mastra/openapi.json`);
  console.log(`Public route: ${baseUrl}/api/mastra/public/ping`);
  console.log(`Customer route: ${baseUrl}/api/mastra/customer/cust-1`);
  console.log(`Admin route: ${baseUrl}/api/mastra/admin/report`);
  console.log(`Whoami route: ${baseUrl}/api/mastra/whoami`);
  console.log(`Demo token route: ${baseUrl}/auth/token/ada`);
  console.log('Demo bearer tokens:');
  console.log(`ada: Bearer ${adaToken}`);
  console.log(`admin: Bearer ${adminToken}`);
}

void main().catch(error => {
  console.error('Failed to start SourceFuse auth JWT example', error);
  process.exitCode = 1;
});
