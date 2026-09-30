import type { Context } from '@loopback/core';
import { RestBindings } from '@loopback/rest';
import type { OperationObject, Request, Response, RouteEntry } from '@loopback/rest';

export interface LoopbackRouteInvocationContext {
  requestContext: Context;
  req: Request;
  res: Response;
  abortController: AbortController;
}

export function createLoopbackRouteEntry(input: {
  verb: string;
  path: string;
  pathParamNames?: string[];
  spec: OperationObject;
  handle: (context: LoopbackRouteInvocationContext) => Promise<Response>;
}): RouteEntry {
  return {
    verb: input.verb.toLowerCase(),
    path: input.path,
    spec: input.spec,
    updateBindings: requestContext => {
      requestContext.bind(RestBindings.OPERATION_SPEC_CURRENT).to(input.spec);
    },
    invokeHandler: async (requestContext, args) => {
      const req = await requestContext.get(RestBindings.Http.REQUEST);
      const res = await requestContext.get(RestBindings.Http.RESPONSE);
      if (input.pathParamNames?.length && args.length >= input.pathParamNames.length) {
        const offset = args.length - input.pathParamNames.length;
        req.params = Object.fromEntries(
          input.pathParamNames.map((name, index) => [name, args[offset + index]]),
        );
      }
      const abortController = new AbortController();
      const abortRequest = () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      };
      const abortOnRequestClose = () => {
        if (!req.readableEnded) {
          abortRequest();
        }
      };
      const abortOnResponseClose = () => {
        if (!res.writableFinished) {
          abortRequest();
        }
      };

      req.once('aborted', abortRequest);
      req.once('close', abortOnRequestClose);
      res.once('close', abortOnResponseClose);

      try {
        return await input.handle({
          requestContext,
          req,
          res,
          abortController,
        });
      } finally {
        req.removeListener('aborted', abortRequest);
        req.removeListener('close', abortOnRequestClose);
        res.removeListener('close', abortOnResponseClose);
      }
    },
    describe: () => `${input.verb.toUpperCase()} ${input.path}`,
  };
}
