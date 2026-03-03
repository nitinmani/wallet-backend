import { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void>;

type RouteErrorHandlerOptions = {
  status?: number;
};

function getErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return "Request failed";
}

export function routeHandler(
  handler: AsyncRouteHandler,
  options?: RouteErrorHandlerOptions
): RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (res.headersSent) {
        next(err);
        return;
      }

      const status = options?.status ?? 400;
      res.status(status).json({ error: getErrorMessage(err) });
    }
  };
}
