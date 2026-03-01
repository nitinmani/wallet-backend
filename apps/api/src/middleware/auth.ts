import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        apiKey: string;
      };
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const apiKey = req.headers["x-api-key"] as string | undefined;

  if (!apiKey) {
    res.status(401).json({ error: "Missing x-api-key header" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { apiKey } });

  if (!user) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  req.user = { id: user.id, email: user.email, apiKey: user.apiKey };
  next();
}
