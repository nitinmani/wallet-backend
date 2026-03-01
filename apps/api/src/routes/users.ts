import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";

export const userRoutes = Router();

// Create user (public)
userRoutes.post("/", async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: "User with this email already exists" });
      return;
    }

    const apiKey = `venc_${uuidv4().replace(/-/g, "")}`;

    const user = await prisma.user.create({
      data: { email, apiKey },
    });

    res.status(201).json({
      id: user.id,
      email: user.email,
      apiKey: user.apiKey,
      createdAt: user.createdAt,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get current user (protected)
userRoutes.get("/me", authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        ownedWallets: { orderBy: { createdAt: "desc" } },
        walletAccesses: {
          include: {
            wallet: true,
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      id: user.id,
      email: user.email,
      apiKey: user.apiKey,
      createdAt: user.createdAt,
      wallets: [
        ...user.ownedWallets,
        ...user.walletAccesses.map((access) => access.wallet),
      ],
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List users (protected)
userRoutes.get("/", authMiddleware, async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
