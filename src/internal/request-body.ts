import { Busboy } from '@fastify/busboy';
import type { Request } from '@loopback/rest';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isBodyMethod(method: string): boolean {
  return BODY_METHODS.has(method.toUpperCase());
}

export function isMultipartRequest(req: Request): boolean {
  return (req.headers['content-type'] ?? '').includes('multipart/form-data');
}

/**
 * Mirrors the official adapters' body-limit gate: trust Content-Length when the
 * client sent one, otherwise measure what LoopBack's JSON parser produced.
 * Multipart bodies are streamed, so their size is enforced by the parser instead.
 */
export function exceedsBodyLimit(req: Request, maxSize: number): boolean {
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    return Number.parseInt(contentLength, 10) > maxSize;
  }
  if (req.body === undefined || isMultipartRequest(req)) {
    return false;
  }
  return Buffer.byteLength(JSON.stringify(req.body), 'utf8') > maxSize;
}

export class BodyTooLargeError extends Error {
  readonly status = 413;
  readonly expose = true;
}

/**
 * Parses multipart/form-data from the raw request stream. Files become Buffers
 * and field values are JSON-decoded when possible, matching the official adapters.
 */
export function parseMultipartFormData(req: Request, maxFileSize?: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const result: Record<string, unknown> = {};
    const busboy = new Busboy({
      headers: { 'content-type': req.headers['content-type'] ?? '' },
      limits: maxFileSize ? { fileSize: maxFileSize } : undefined,
    });

    busboy.on('file', (fieldname, file) => {
      const chunks: Buffer[] = [];
      let limitExceeded = false;
      file.on('data', (chunk: Buffer) => chunks.push(chunk));
      file.on('limit', () => {
        limitExceeded = true;
        reject(new BodyTooLargeError(`File size limit exceeded${maxFileSize ? ` (max: ${maxFileSize} bytes)` : ''}`));
      });
      file.on('end', () => {
        if (!limitExceeded) {
          result[fieldname] = Buffer.concat(chunks);
        }
      });
    });
    busboy.on('field', (fieldname, value) => {
      try {
        result[fieldname] = JSON.parse(value);
      } catch {
        result[fieldname] = value;
      }
    });
    busboy.on('finish', () => resolve(result));
    busboy.on('error', reject);
    req.pipe(busboy);
  });
}
