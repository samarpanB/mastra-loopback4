import { request as httpRequest } from 'node:http';

import { RestApplication } from '@loopback/rest';
import type {
  AdapterSetupOptions,
  AdapterTestContext,
  HttpRequest,
  HttpResponse,
} from '@mastra/server-adapters-test-suite';

import { LoopbackMastraServer } from '../../loopback-mastra-server.js';

const startedApps = new Set<RestApplication>();

/** Stops every app started by these helpers. Each test file registers it in its own afterAll. */
export async function stopAllApps(): Promise<void> {
  const apps = [...startedApps];
  startedApps.clear();
  await Promise.all(apps.map(app => app.stop()));
}

export function createApp(): RestApplication {
  // No signal traps: the suites start hundreds of apps, and each would add a SIGTERM listener.
  return new RestApplication({ rest: { host: '127.0.0.1', port: 0 }, shutdown: { signals: [] } });
}

export async function setupAdapter(context: AdapterTestContext, options?: AdapterSetupOptions) {
  const app = createApp();
  const adapter = new LoopbackMastraServer({
    app,
    mastra: context.mastra,
    tools: context.tools,
    taskStore: context.taskStore,
    customRouteAuthConfig: context.customRouteAuthConfig,
    config: { prefix: options?.prefix },
  });
  await adapter.init();
  return { adapter, app };
}

/** Starts the app on an ephemeral port once and returns its base URL. */
export async function ensureStarted(app: RestApplication): Promise<string> {
  if (!startedApps.has(app)) {
    await app.start();
    startedApps.add(app);
  }
  const url = app.restServer.url;
  if (!url) {
    throw new Error('LoopBack REST server did not expose a URL after start');
  }
  return url;
}

export async function stopApp(app: RestApplication): Promise<void> {
  if (startedApps.delete(app)) {
    await app.stop();
  }
}

/** The suites address requests to http://localhost/...; retarget them at the running app. */
export async function toAppUrl(app: RestApplication, url: string): Promise<URL> {
  const target = new URL(url);
  const base = new URL(await ensureStarted(app));
  target.protocol = base.protocol;
  target.host = base.host;
  return target;
}

export async function executeHttpRequest(app: RestApplication, request: HttpRequest): Promise<HttpResponse> {
  const baseUrl = await ensureStarted(app);
  const url = new URL(request.path.startsWith('/') ? request.path : `/${request.path}`, baseUrl);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (Array.isArray(value)) {
      value.forEach(entry => url.searchParams.append(key, entry));
    } else {
      url.searchParams.set(key, value);
    }
  }

  const headers = new Headers(request.headers);
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(url, { method: request.method, headers, body });
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  const contentType = response.headers.get('content-type') ?? '';
  const isStream =
    contentType.includes('text/plain') ||
    contentType.includes('text/event-stream') ||
    contentType.includes('audio/') ||
    contentType.includes('application/octet-stream');
  if (isStream) {
    return { status: response.status, type: 'stream', stream: response.body ?? undefined, headers: responseHeaders };
  }

  const text = await response.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Preserve non-JSON responses as text for the suite to inspect.
  }
  return { status: response.status, type: 'json', data, headers: responseHeaders };
}

type SimpleRequestOptions = { headers?: Record<string, string>; body?: string };

/** Sends a request and reports only the status, as the body-limit and logging suites expect. */
export async function executeStatusRequest(
  app: RestApplication,
  method: string,
  url: string,
  options: SimpleRequestOptions = {},
): Promise<{ status: number }> {
  const response = await fetch(await toAppUrl(app, url), {
    method,
    headers: options.headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  await response.arrayBuffer();
  return { status: response.status };
}

/** Same as executeStatusRequest, but streams the body chunked so no Content-Length is sent. */
export async function executeChunkedStatusRequest(
  app: RestApplication,
  method: string,
  url: string,
  options: SimpleRequestOptions = {},
): Promise<{ status: number }> {
  const target = await toAppUrl(app, url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(target, { method, headers: { ...options.headers, 'transfer-encoding': 'chunked' } }, res => {
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.once('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}
