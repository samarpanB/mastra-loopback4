import { BindingScope } from '@loopback/core';
import type { Request, Response, RestApplication } from '@loopback/rest';
import type { Mastra } from '@mastra/core';
import type { ToolsInput } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import { MASTRA_USER_PERMISSIONS_KEY } from '@mastra/server/auth';
import {
  checkRouteFGA,
  getCustomHTTPExceptionResponse,
  isZodError,
  MastraServer,
  normalizeQueryParams,
} from '@mastra/server/server-adapter';
import type {
  BodyLimitOptions,
  ParsedRequestParams,
  ServerRoute,
  StreamOptions,
} from '@mastra/server/server-adapter';
import type { InMemoryTaskStore } from '@mastra/server/a2a/store';

import { MastraLoopbackBindings, MastraLoopbackProviderBindings } from './bindings.js';
import { MastraLoopbackComponent } from './component.js';
import { createHttpLoggingMiddleware } from './internal/logging.js';
import {
  createOperationSpec,
  extractPathParamNames,
  joinPath,
  toLoopbackMethods,
  toLoopbackPath,
} from './internal/path-utils.js';
import {
  BodyTooLargeError,
  exceedsBodyLimit,
  isBodyMethod,
  isMultipartRequest,
  parseMultipartFormData,
} from './internal/request-body.js';
import { LoopbackRequestRuntime } from './internal/request-runtime.js';
import type { LoopbackRequestRuntimeHooks } from './internal/request-runtime.js';
import {
  bindRequestContextValues,
  buildCustomRouteUrl,
  createMastraRequestContext,
  normalizeUrlParams,
  toHeaderRecord,
  toWebRequest,
} from './internal/request-utils.js';
import { LoopbackResponseWriter } from './internal/response-writer.js';
import { createLoopbackRouteEntry } from './internal/route-entry-factory.js';
import type { LoopbackRouteInvocationContext } from './internal/route-entry-factory.js';
import type { LoopbackApiRouteMethod, RegisteredMastraRoute } from './internal/types.js';
import type { LoopbackAuthResolverInput, LoopbackMastraConfig, MastraAuthContext } from './types.js';

export interface LoopbackMastraServerOptions {
  app: RestApplication;
  mastra: Mastra;
  config?: LoopbackMastraConfig;
  bodyLimitOptions?: BodyLimitOptions;
  tools?: ToolsInput;
  taskStore?: InMemoryTaskStore;
  customRouteAuthConfig?: Map<string, boolean>;
  streamOptions?: StreamOptions;
  customApiRoutes?: ApiRoute[];
}

type HasPermission = (userPermissions: string[], required: string) => boolean;
type AccessDenial = { status: number; error: string; message?: string };

let hasPermissionPromise: Promise<HasPermission | undefined> | undefined;

/** RBAC matching lives in Mastra's EE entry point; load it only when auth is configured. */
function loadHasPermission(): Promise<HasPermission | undefined> {
  hasPermissionPromise ??= import('@mastra/core/auth/ee').then(
    module => module.hasPermission as HasPermission,
    () => undefined,
  );
  return hasPermissionPromise;
}

/**
 * Native LoopBack 4 adapter for Mastra.
 * Uses LoopBack route registration and request context bindings directly.
 */
export class LoopbackMastraServer extends MastraServer<RestApplication, Request, Response> {
  readonly config: LoopbackMastraConfig;
  private readonly responseWriter: LoopbackResponseWriter;
  private readonly runtime: LoopbackRequestRuntime;
  private authResolver?: (
    input: LoopbackAuthResolverInput,
  ) => MastraAuthContext | undefined | Promise<MastraAuthContext | undefined>;

  constructor(options: LoopbackMastraServerOptions) {
    const config = options.config ?? {};
    super({
      app: options.app,
      mastra: options.mastra,
      prefix: config.prefix,
      openapiPath: config.openapiPath,
      bodyLimitOptions: options.bodyLimitOptions,
      tools: options.tools,
      taskStore: options.taskStore,
      customRouteAuthConfig: options.customRouteAuthConfig,
      streamOptions: options.streamOptions,
      customApiRoutes: options.customApiRoutes,
      mcpOptions: config.mcp,
    } as never);
    this.config = config;
    this.runtime = new LoopbackRequestRuntime({
      config: this.config,
      parseQueryParamsHook: (route, queryParams) => this.invokeParseQueryParamsHook(route, queryParams),
      parseBodyHook: (route, body) => this.invokeParseBodyHook(route, body),
      parsePathParamsHook: (route, pathParams) => this.invokeParsePathParamsHook(route, pathParams),
      checkRouteAuthHook: (route, input) => this.invokeCheckRouteAuthHook(route, input),
      legacyAuthResolver: input => this.getConfiguredAuthResolver()?.(input),
      resolveTools: () => this.resolveToolsForRoute(),
      resolveTaskStore: () => this.resolveTaskStore(),
      redactStreamChunkHook: chunk => this.invokeRedactStreamChunkHook(chunk),
    });
    this.responseWriter = new LoopbackResponseWriter({
      prefix: this.prefix,
      applyStreamRedaction: chunk => this.runtime.redactStreamChunk(chunk),
    });

    this.ensureSupportBindingsRegistered(options.app);
    options.app.bind(MastraLoopbackBindings.CONFIG).to(this.config).inScope(BindingScope.SINGLETON);
    options.app.bind(MastraLoopbackBindings.MASTRA_INSTANCE).to(options.mastra).inScope(BindingScope.SINGLETON);
  }

  registerContextMiddleware(): void {
    this.ensureSupportBindingsRegistered(this.app);
  }

  registerAuthMiddleware(): void {
    this.ensureSupportBindingsRegistered(this.app);
    this.authResolver = this.getConfiguredAuthResolver();
    this.app.bind(MastraLoopbackBindings.AUTH_RESOLVER).to(this.authResolver).inScope(BindingScope.SINGLETON);
  }

  registerHttpLoggingMiddleware(): void {
    this.ensureSupportBindingsRegistered(this.app);
    this.app
      .bind(MastraLoopbackBindings.HTTP_LOGGING_CONFIG)
      .to(this.httpLoggingConfig)
      .inScope(BindingScope.SINGLETON);

    const config = this.httpLoggingConfig;
    if (!config?.enabled) {
      return;
    }
    this.app.middleware(
      createHttpLoggingMiddleware({
        config,
        shouldLogRequest: path => this.shouldLogRequest(path),
        getLogger: () => this.logger,
      }),
    );
  }

  async registerCustomApiRoutes(): Promise<void> {
    const customRoutes = await this.registerSchemaApiRoutes();
    const hasCustomRoutes = await this.buildCustomRouteHandler(customRoutes);
    if (!hasCustomRoutes) {
      return;
    }

    this.customApiRoutes = customRoutes;
    this.syncCustomRouteAuthConfig(customRoutes);

    for (const route of customRoutes) {
      for (const method of toLoopbackMethods(route.method)) {
        await this.registerCustomApiRoute(method, route);
      }
    }
  }

  async registerRoute(app: RestApplication, route: ServerRoute, opts: { prefix?: string } = {}): Promise<void> {
    const mastraRoute = route as RegisteredMastraRoute;
    const routeHandler = this.resolveRouteHandler(mastraRoute);
    const fullPath = toLoopbackPath(joinPath(opts.prefix ?? this.prefix, mastraRoute.path));
    const pathParamNames = extractPathParamNames(fullPath);
    // Mastra route metadata can contain Zod schemas. Passing those directly to
    // LoopBack makes its AJV layer interpret Zod internals as JSON Schema and
    // reject otherwise valid requests before Mastra can validate them.
    const operationSpec = createOperationSpec(pathParamNames);

    // LoopBack has no `all` verb, so MCP transport routes (method ALL) are
    // registered once per concrete method.
    for (const verb of toLoopbackMethods(mastraRoute.method as LoopbackApiRouteMethod)) {
      app.route(
        createLoopbackRouteEntry({
          verb,
          path: fullPath,
          pathParamNames,
          spec: operationSpec,
          handle: lifecycle => this.handleRegisteredRouteInvocation(lifecycle, mastraRoute, routeHandler),
        }),
      );
    }
  }

  async getParams(route: ServerRoute, req: Request): Promise<ParsedRequestParams> {
    const params: ParsedRequestParams = {
      urlParams: normalizeUrlParams(req.params),
      queryParams: normalizeQueryParams((req.query ?? {}) as Record<string, unknown>),
      body: req.body,
    };

    if (isBodyMethod(route.method) && isMultipartRequest(req)) {
      try {
        params.body = await parseMultipartFormData(req, this.getMaxBodySize(route));
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          throw error;
        }
        params.bodyParseError = {
          message: error instanceof Error ? error.message : 'Failed to parse multipart form data',
        };
      }
    }

    return params;
  }

  async sendResponse(route: ServerRoute, res: Response, result: unknown, request?: Request): Promise<void> {
    await this.responseWriter.sendResponse(route, res, result, request);
  }

  async stream(route: ServerRoute, res: Response, result: unknown): Promise<void> {
    await this.responseWriter.stream(route, res, result);
  }

  async init(): Promise<void> {
    await super.init();
  }

  private async handleRegisteredRouteInvocation(
    lifecycle: LoopbackRouteInvocationContext,
    route: RegisteredMastraRoute,
    routeHandler: (params: unknown) => unknown | Promise<unknown>,
  ): Promise<Response> {
    const { requestContext, req, res, abortController } = lifecycle;

    try {
      const maxBodySize = this.getMaxBodySize(route);
      if (maxBodySize !== undefined && isBodyMethod(route.method) && exceedsBodyLimit(req, maxBodySize)) {
        res.status(413).json(this.toBodyLimitError(route));
        return res;
      }

      const params = await this.getParams(route, req);
      if (params.bodyParseError) {
        res.status(400).json({
          error: 'Invalid request body',
          issues: [{ field: 'body', message: params.bodyParseError.message }],
        });
        return res;
      }
      let queryParams: Record<string, unknown>;
      try {
        queryParams = await this.runtime.parseQueryParams(route, params.queryParams);
      } catch (error) {
        if (isZodError(error)) {
          const result = this.resolveValidationError(route, error as never, 'query');
          res.status(result.status).json(result.body);
          return res;
        }
        res.status(400).json({ error: 'Invalid query parameters' });
        return res;
      }
      let body: unknown;
      try {
        body = await this.runtime.parseBody(route, params.body);
      } catch (error) {
        if (isZodError(error)) {
          const result = this.resolveValidationError(route, error as never, 'body');
          res.status(result.status).json(result.body);
          return res;
        }
        res.status(400).json({ error: 'Invalid request body' });
        return res;
      }
      let pathParams: Record<string, unknown>;
      try {
        pathParams = await this.runtime.parsePathParams(route, params.urlParams);
      } catch (error) {
        if (isZodError(error)) {
          const result = this.resolveValidationError(route, error as never, 'path');
          res.status(result.status).json(result.body);
          return res;
        }
        res.status(400).json({ error: 'Invalid path parameters' });
        return res;
      }
      const mastraRequestContext = createMastraRequestContext({
        app: this.app,
        mergeRequestContext: input => this.mergeRequestContext(input),
        loopbackContext: requestContext,
        request: req,
        response: res,
        queryParams: req.query as Record<string, unknown> | undefined,
        body: req.body,
      });
      mastraRequestContext.set('abortSignal', abortController.signal);

      const authError = await this.runtime.checkRouteAuth(route, req, mastraRequestContext);
      if (authError) {
        res.status(authError.status).json({ error: authError.error });
        return res;
      }

      const authContext = await this.runtime.resolveAuthContext(req, mastraRequestContext);
      if (authContext) {
        mastraRequestContext.set('auth', authContext);
      }
      bindRequestContextValues({
        requestContext,
        request: req,
        abortSignal: abortController.signal,
        mastraRequestContext,
        authContext,
      });

      const handlerInput: Record<string, unknown> = {
        ...pathParams,
        ...queryParams,
        ...(typeof body === 'object' && body !== null ? body : {}),
        request: toWebRequest(req),
        mastra: this.mastra,
        requestContext: mastraRequestContext,
        registeredTools: this.runtime.resolveTools(),
        abortSignal: abortController.signal,
        taskStore: this.runtime.resolveTaskStore(),
        routePrefix: this.prefix,
      };
      // Raw-request conveniences for custom ServerRoutes. Non-enumerable so
      // handlers that collect remaining body fields with object rest never see
      // them, and only filled when the request did not supply the same key.
      // `tools` is intentionally absent: Mastra handlers destructure it as an
      // optional body field, and `registeredTools` already carries the value.
      const compatibilityValues: Record<string, unknown> = {
        method: req.method,
        query: queryParams,
        body,
        headers: req.headers,
        params: pathParams,
        response: res,
        getRawRequest: () => req,
        getRawResponse: () => res,
      };
      for (const [key, value] of Object.entries(compatibilityValues)) {
        if (!(key in handlerInput)) {
          Object.defineProperty(handlerInput, key, { value });
        }
      }

      const accessDenial = await this.checkAccessPolicies(route, mastraRequestContext, {
        ...pathParams,
        ...queryParams,
        ...(typeof body === 'object' && body !== null ? body : {}),
      });
      if (accessDenial) {
        res.status(accessDenial.status).json({ error: accessDenial.error, message: accessDenial.message });
        return res;
      }

      const handlerResult = await routeHandler(handlerInput);

      if (this.isStreamRoute(route)) {
        await this.stream(route, res, handlerResult);
      } else {
        await this.sendResponse(route, res, handlerResult, req);
      }
      return res;
    } catch (error: unknown) {
      const customResponse = getCustomHTTPExceptionResponse(error);
      if (customResponse) {
        await this.writeCustomRouteResponse(customResponse, res, abortController.signal);
        return res;
      }
      this.sendErrorResponse(res, error);
      return res;
    }
  }

  private async registerCustomApiRoute(method: string, route: ApiRoute): Promise<void> {
    const fullPath = toLoopbackPath(joinPath(this.prefix, route.path));
    const operationSpec = createOperationSpec(extractPathParamNames(fullPath));
    const pathParamNames = extractPathParamNames(fullPath);

    this.app.route(
      createLoopbackRouteEntry({
        verb: method,
        path: fullPath,
        pathParamNames,
        spec: operationSpec,
        handle: lifecycle => this.handleCustomRouteInvocation(lifecycle, method, route),
      }),
    );
  }

  private async handleCustomRouteInvocation(
    lifecycle: LoopbackRouteInvocationContext,
    method: string,
    route: ApiRoute,
  ): Promise<Response> {
    const { requestContext, req, res, abortController } = lifecycle;

    try {
      const mastraRequestContext = createMastraRequestContext({
        app: this.app,
        mergeRequestContext: input => this.mergeRequestContext(input),
        loopbackContext: requestContext,
        request: req,
        response: res,
        queryParams: req.query as Record<string, unknown> | undefined,
        body: req.body,
      });
      mastraRequestContext.set('abortSignal', abortController.signal);

      const authRoute = {
        method,
        path: joinPath(this.prefix, route.path),
        requiresAuth: route.requiresAuth,
      } as RegisteredMastraRoute;
      const authError = await this.runtime.checkRouteAuth(authRoute, req, mastraRequestContext);
      if (authError) {
        res.status(authError.status).json({ error: authError.error });
        return res;
      }

      const authContext = await this.runtime.resolveAuthContext(req, mastraRequestContext);
      if (authContext) {
        mastraRequestContext.set('auth', authContext);
      }
      bindRequestContextValues({
        requestContext,
        request: req,
        abortSignal: abortController.signal,
        mastraRequestContext,
        authContext,
      });

      const accessDenial = await this.checkAccessPolicies(
        // Unprefixed path: Mastra derives the resource permission from it.
        { ...route, method } as unknown as ServerRoute,
        mastraRequestContext,
        {
          ...normalizeUrlParams(req.params),
          ...(req.query as Record<string, unknown> | undefined),
          ...(typeof req.body === 'object' && req.body !== null ? req.body : {}),
        },
      );
      if (accessDenial) {
        res.status(accessDenial.status).json({ error: accessDenial.error, message: accessDenial.message });
        return res;
      }

      const customResponse = await this.handleCustomRouteRequest(
        buildCustomRouteUrl(req, this.prefix).toString(),
        method,
        toHeaderRecord(req.headers),
        req.body,
        mastraRequestContext,
      );

      if (!customResponse) {
        res.status(404).json({ error: 'Not Found' });
        return res;
      }

      await this.writeCustomRouteResponse(customResponse, res, abortController.signal);
      return res;
    } catch (error: unknown) {
      this.sendErrorResponse(res, error);
      return res;
    }
  }

  /** Mastra RBAC (when server auth is configured) followed by FGA, as the official adapters apply them. */
  private async checkAccessPolicies(
    route: ServerRoute,
    requestContext: RequestContext,
    params: Record<string, unknown>,
  ): Promise<AccessDenial | null> {
    if (this.mastra.getServer()?.auth) {
      const hasPermission = await loadHasPermission();
      if (hasPermission) {
        const userPermissions = requestContext.get(MASTRA_USER_PERMISSIONS_KEY) as string[] | undefined;
        const denial = this.checkRoutePermission(route, userPermissions, hasPermission, requestContext);
        if (denial) {
          return denial;
        }
      }
    }
    return checkRouteFGA(this.mastra, route, requestContext, params);
  }

  private getMaxBodySize(route: ServerRoute): number | undefined {
    return route.maxBodySize ?? this.bodyLimitOptions?.maxSize;
  }

  /** Route-specific limits use the default payload; global limits may be reshaped by `onError`. */
  private toBodyLimitError(route: ServerRoute): unknown {
    const errorResponse = { error: 'Request body too large' };
    if (route.maxBodySize !== undefined || !this.bodyLimitOptions) {
      return errorResponse;
    }
    try {
      return this.bodyLimitOptions.onError(errorResponse);
    } catch {
      return errorResponse;
    }
  }

  private resolveRouteHandler(route: RegisteredMastraRoute): (params: unknown) => unknown | Promise<unknown> {
    if (typeof route.handler !== 'function') {
      throw new Error(`Route handler is not configured for ${route.method} ${route.path}`);
    }
    return route.handler;
  }

  private getCustomApiRoutes(): ApiRoute[] {
    return (this.customApiRoutes ?? this.mastra.getServer()?.apiRoutes ?? []) as ApiRoute[];
  }

  private syncCustomRouteAuthConfig(routes: ApiRoute[]): void {
    const config = this.customRouteAuthConfig ?? new Map<string, boolean>();
    for (const route of routes) {
      if (route.requiresAuth === undefined) {
        continue;
      }
      config.set(`${route.method}:${joinPath(this.prefix, route.path)}`, route.requiresAuth);
    }
    this.customRouteAuthConfig = config;
  }

  private resolveToolsForRoute(): unknown {
    const serverInternals = this as unknown as {
      tools?: unknown;
      getToolsets?: (tools: unknown) => unknown;
    };

    if (typeof serverInternals.getToolsets === 'function') {
      return serverInternals.getToolsets.call(this, serverInternals.tools);
    }

    return serverInternals.tools;
  }

  private resolveTaskStore(): unknown {
    return (this as unknown as { taskStore?: unknown }).taskStore;
  }

  private isStreamRoute(route: RegisteredMastraRoute): boolean {
    return route.responseType === 'stream';
  }

  private sendErrorResponse(res: Response, error: unknown): void {
    this.responseWriter.sendErrorResponse(res, error);
  }

  private ensureSupportBindingsRegistered(app: RestApplication): void {
    if (!app.isBound(MastraLoopbackProviderBindings.REQUEST_CONTEXT)) {
      app.component(MastraLoopbackComponent);
    }
  }

  private getConfiguredAuthResolver(): LoopbackMastraConfig['authResolver'] {
    return this.config.auth?.resolveContext ?? this.config.authResolver;
  }

  private async invokeParseQueryParamsHook(
    route: RegisteredMastraRoute,
    queryParams: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const parseQueryParams = (
      this as unknown as {
        parseQueryParams?: (
          route: RegisteredMastraRoute,
          queryParams: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).parseQueryParams;

    return typeof parseQueryParams === 'function' ? parseQueryParams.call(this, route, queryParams) : queryParams;
  }

  private async invokeParseBodyHook(route: RegisteredMastraRoute, body: unknown): Promise<unknown> {
    const parseBody = (
      this as unknown as {
        parseBody?: (route: RegisteredMastraRoute, body: unknown) => Promise<unknown>;
      }
    ).parseBody;

    return typeof parseBody === 'function' ? parseBody.call(this, route, body) : body;
  }

  private async invokeParsePathParamsHook(
    route: RegisteredMastraRoute,
    pathParams: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const parsePathParams = (
      this as unknown as {
        parsePathParams?: (
          route: RegisteredMastraRoute,
          pathParams: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).parsePathParams;

    return typeof parsePathParams === 'function' ? parsePathParams.call(this, route, pathParams) : pathParams;
  }

  private async invokeCheckRouteAuthHook(
    route: RegisteredMastraRoute,
    input: Parameters<NonNullable<LoopbackRequestRuntimeHooks['checkRouteAuthHook']>>[1],
  ): Promise<{ status: number; error: string } | null> {
    const checkRouteAuth = (
      this as unknown as {
        checkRouteAuth?: (
          route: RegisteredMastraRoute,
          input: {
            path: string;
            method: string;
            getHeader: (key: string) => string | undefined;
            getQuery: (key: string) => string | undefined;
            requestContext: RequestContext;
            request: globalThis.Request;
            buildAuthorizeContext: () => globalThis.Request;
          },
        ) => Promise<{ status: number; error: string } | null>;
      }
    ).checkRouteAuth;

    return typeof checkRouteAuth === 'function' ? checkRouteAuth.call(this, route, input) : null;
  }

  private invokeRedactStreamChunkHook(chunk: unknown): unknown | Promise<unknown> {
    const streamOptions = (this as unknown as { streamOptions?: { redact?: unknown } }).streamOptions;
    const redact = streamOptions?.redact;

    return typeof redact === 'function' ? redact(chunk) : chunk;
  }
}
