import type { OperationObject } from '@loopback/rest';

import type { LoopbackApiRouteMethod } from './types.js';

export function extractPathParamNames(path: string): string[] {
  const names = new Set<string>();
  const braceParamRegex = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null = null;

  while ((match = braceParamRegex.exec(path)) !== null) {
    if (match[1]) {
      names.add(match[1]);
    }
  }

  return [...names];
}

export function toLoopbackPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

export function joinPath(prefix: string | undefined, path: string): string {
  const joined = `${prefix ?? ''}/${path}`.replace(/\/{2,}/g, '/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

export function toLoopbackMethods(method: LoopbackApiRouteMethod): string[] {
  if (method === 'ALL') {
    return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  }
  return [method];
}

export function createOperationSpec(pathParamNames: string[]): OperationObject {
  const spec: OperationObject = {
    responses: {
      '200': {
        description: 'Mastra route response',
      },
    },
  };

  if (pathParamNames.length > 0) {
    spec.parameters = pathParamNames.map(name => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
  }

  spec.requestBody = {
    required: false,
    content: {
      'application/json': {
        // Mastra owns route validation. Keep LoopBack's parser permissive so
        // scalar, array, object, null, and empty-body inputs reach Mastra.
        schema: {},
      },
      // Hand multipart bodies over unparsed; the adapter streams them through
      // busboy so file uploads become Buffers and size limits apply per file.
      'multipart/form-data': {
        'x-parser': 'stream',
        schema: {},
      },
    },
  };

  return spec;
}
