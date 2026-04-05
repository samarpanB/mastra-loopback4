var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { registerApiRoute } from '@mastra/core/server';
import { createTool } from '@mastra/core/tools';
import { DefaultCrudRepository, Entity, juggler, model, property, } from '@loopback/repository';
import { RestApplication } from '@loopback/rest';
import { z } from 'zod';
import { LoopbackMastraServer } from '../../../src/index.js';
let Customer = class Customer extends Entity {
    constructor(data) {
        super(data);
        this.id = data?.id ?? '';
        this.name = data?.name ?? '';
        this.tier = data?.tier ?? '';
        this.notes = data?.notes ?? '';
    }
};
__decorate([
    property({
        id: true,
    })
], Customer.prototype, "id", void 0);
__decorate([
    property()
], Customer.prototype, "name", void 0);
__decorate([
    property()
], Customer.prototype, "tier", void 0);
__decorate([
    property()
], Customer.prototype, "notes", void 0);
Customer = __decorate([
    model()
], Customer);
class CustomerRepository extends DefaultCrudRepository {
    constructor(dataSource) {
        super(Customer, dataSource);
    }
}
async function main() {
    const app = new RestApplication({
        rest: {
            host: '0.0.0.0',
            port: 3001,
        },
    });
    const db = new juggler.DataSource({
        name: 'customer-db',
        connector: 'memory',
    });
    const customerRepository = new CustomerRepository(db);
    await customerRepository.createAll([
        {
            id: 'cust-1',
            name: 'Ada Lovelace',
            tier: 'enterprise',
            notes: 'Prefers architectural detail and long-term planning.',
        },
        {
            id: 'cust-2',
            name: 'Grace Hopper',
            tier: 'growth',
            notes: 'Interested in developer productivity improvements.',
        },
    ]);
    app.bind('repositories.CustomerRepository').to(customerRepository);
    const lookupCustomerTool = createTool({
        id: 'lookup-customer',
        description: 'Load customer information from the LoopBack repository',
        inputSchema: z.object({
            customerId: z.string(),
        }),
        execute: async (input, context) => {
            const requestContext = context.requestContext;
            if (!requestContext) {
                throw new Error('Mastra requestContext is required for LoopBack DI resolution.');
            }
            const loopback = requestContext.get('loopback');
            const repository = await loopback.resolve('repositories.CustomerRepository');
            const customer = await repository.findById(input.customerId);
            return {
                id: customer.id,
                name: customer.name,
                tier: customer.tier,
                notes: customer.notes,
            };
        },
    });
    // Replace the model id with a provider/model available in your runtime.
    const customerSupportAgent = new Agent({
        id: 'customer-support-agent',
        name: 'customerSupportAgent',
        instructions: [
            'You are a customer support assistant for an existing LoopBack application.',
            'Always use the lookup-customer tool before answering.',
            'Summarize the customer account in plain language for an internal support rep.',
        ].join(' '),
        model: 'openai/gpt-5',
        tools: {
            lookupCustomer: lookupCustomerTool,
        },
    });
    const mastra = new Mastra({
        agents: {
            customerSupportAgent,
        },
    });
    mastra.setServer({
        apiRoutes: [
            registerApiRoute('/agent/customer-summary/:id', {
                method: 'GET',
                handler: async (c) => {
                    const requestContext = c.get('requestContext');
                    const agent = mastra.getAgent('customerSupportAgent');
                    const customerId = c.req.param('id');
                    const result = await agent.generate(`Summarize customer ${customerId} for a support representative.`, {
                        requestContext,
                    });
                    return c.json({
                        customerId,
                        text: result.text,
                        toolCalls: result.toolCalls,
                        toolResults: result.toolResults,
                    });
                },
                openapi: {
                    summary: 'Invoke a Mastra agent that reads customer data from a LoopBack repository tool',
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
            enableAuth: false,
        },
    });
    await adapter.init();
    await app.start();
    const baseUrl = app.restServer.url;
    console.log(`LoopBack app started at ${baseUrl}`);
    console.log(`Agent route: ${baseUrl}/api/mastra/agent/customer-summary/cust-1`);
    console.log('This example requires a working model/provider configuration for the configured agent model.');
    console.log(`OpenAPI route: ${baseUrl}/api/mastra/openapi.json`);
}
void main().catch(error => {
    console.error('Failed to start repository-tool-agent-route example', error);
    process.exitCode = 1;
});
