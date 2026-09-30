import {Mastra} from '@mastra/core';
import {registerApiRoute} from '@mastra/core/server';
import {RestApplication} from '@loopback/rest';

import {LoopbackMastraServer} from '@sourceloop/mastra-loopback';

class CustomerService {
  findById(id: string): {id: string; name: string} {
    return {id, name: 'Ada Lovelace'};
  }
}

async function main(): Promise<void> {
  const app = new RestApplication({
    rest: {
      host: '0.0.0.0',
      port: 3000,
    },
  });

  const mastra = new Mastra();
  mastra.setServer({
    apiRoutes: [
      registerApiRoute('/customer/:id', {
        method: 'GET',
        handler: async c => {
          const requestContext = c.get('requestContext');
          const loopback = requestContext.get('loopback') as {
            resolve: (binding: string) => Promise<CustomerService>;
          };
          const customerService = await loopback.resolve('services.CustomerService');

          return c.json({
            customer: customerService.findById(c.req.param('id')),
            availableContextKeys: [...requestContext.keys()],
          });
        },
        openapi: {
          summary: 'Fetch a customer using a LoopBack service inside a Mastra custom route',
        },
      }),
    ],
  });

  app.bind('services.CustomerService').to(new CustomerService());

  const adapter = new LoopbackMastraServer({
    app,
    mastra,
    config: {
      prefix: '/api/mastra',
      enableAuth: false,
    },
  });

  await adapter.init();
  await app.start();

  const baseUrl = app.restServer.url;
  console.log(`LoopBack app started at ${baseUrl}`);
  console.log(`Mastra routes available under ${baseUrl}/api/mastra`);
  console.log(`Example custom route: ${baseUrl}/api/mastra/customer/123`);
}

void main().catch(error => {
  console.error('Failed to start basic-loopback-app', error);
  process.exitCode = 1;
});
