import { NextFunction, Request, Response } from "express";
import { authenticateConnectedWalletSession } from "../services/connectedWalletService";

declare global {
  namespace Express {
    interface Request {
      connectedWallet?: {
        sessionId: string;
        address: string;
      };
    }
  }
}

function getBearerToken(req: Request): string | null {
  const authorization = req.headers.authorization;
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1].trim();
}

export async function connectedWalletAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Missing connected wallet bearer token" });
    return;
  }

  try {
    const session = await authenticateConnectedWalletSession(token);
    req.connectedWallet = {
      sessionId: session.sessionId,
      address: session.wallet.address,
    };
    next();
  } catch (err: any) {
    res.status(401).json({ error: err.message || "Invalid connected wallet session" });
  }
}

export function getConnectedWalletBearerToken(req: Request): string | null {
  return getBearerToken(req);
}
