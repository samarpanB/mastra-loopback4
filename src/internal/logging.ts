import type { Middleware } from '@loopback/rest';
import type { HttpLoggingConfig } from '@mastra/core/server';

import { toHeaderRecord } from './request-utils.js';
import type { RequestLogPayload } from './types.js';

type LogLevel = NonNullable<HttpLoggingConfig['level']>;
type RequestLogger = Record<LogLevel, (message: string, payload: RequestLogPayload) => void>;

/**
 * LoopBack middleware equivalent of the official adapters' request logger.
 * Runs for every request on the application, like Express's `app.use`, and
 * writes through the Mastra logger once the response has finished.
 */
export function createHttpLoggingMiddleware(input: {
  config: HttpLoggingConfig;
  shouldLogRequest: (path: string) => boolean;
  getLogger: () => RequestLogger;
}): Middleware {
  return async (ctx, next) => {
    const { request: req, response: res } = ctx;
    if (!input.shouldLogRequest(req.path)) {
      return next();
    }

    const startedAt = Date.now();
    res.once('finish', () => {
      const { config } = input;
      const duration = Date.now() - startedAt;
      const payload: RequestLogPayload = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: `${duration}ms`,
      };
      if (config.includeQueryParams) {
        payload.query = req.query as Record<string, unknown>;
      }
      if (config.includeHeaders) {
        payload.headers = redactHeaders(toHeaderRecord(req.headers), config);
      }

      const level = config.level ?? 'info';
      input.getLogger()[level](`${payload.method} ${payload.path} ${payload.status} ${payload.duration}`, payload);
    });
    return next();
  };
}

const DEFAULT_REDACT_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key'];

function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
  config: HttpLoggingConfig,
): Record<string, string | string[] | undefined> {
  const redacted = new Set(
    [...DEFAULT_REDACT_HEADERS, ...(config.redactHeaders ?? [])].map(header => header.toLowerCase()),
  );
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (redacted.has(key.toLowerCase())) {
        return [key, '[REDACTED]'] as const;
      }
      return [key, value] as const;
    }),
  );
}
