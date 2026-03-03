import express from "express";
import request from "supertest";

jest.mock("../../src/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
  },
}));

// Bypass auth for route-level tests
jest.mock("../../src/middleware/auth", () => ({
  authMiddleware: (_req: any, _res: any, next: any) => {
    _req.user = { id: "user-1", email: "test@vencura.dev", apiKey: "venc_key" };
    next();
  },
}));

import { userRoutes } from "../../src/routes/users";
import { prisma } from "../../src/lib/prisma";

const app = express();

beforeAll(() => {
  app.use(express.json());
  app.use("/api/users", userRoutes);
});

beforeEach(() => jest.clearAllMocks());

// ═══════════════════════════════════════════════════════════════
// POST /api/users
// ═══════════════════════════════════════════════════════════════
describe("POST /api/users", () => {
  test("returns 400 when email is missing from body", async () => {
    const res = await request(app).post("/api/users").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Email is required");
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  test("creates a new user and returns id, email, and apiKey", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.user.create as jest.Mock).mockResolvedValue({
      id: "user-new",
      email: "new@vencura.dev",
      apiKey: "venc_abc123",
      createdAt: new Date("2025-01-01"),
    });

    const res = await request(app).post("/api/users").send({ email: "new@vencura.dev" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("user-new");
    expect(res.body.email).toBe("new@vencura.dev");
    expect(res.body.apiKey).toMatch(/^venc_/);
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "new@vencura.dev" }) })
    );
  });

  test("returns 409 when email is already registered", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: "existing",
      email: "exists@vencura.dev",
    });

    const res = await request(app).post("/api/users").send({ email: "exists@vencura.dev" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("User with this email already exists");
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  test("generated apiKey starts with venc_ prefix", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.user.create as jest.Mock).mockImplementation(({ data }) => ({
      id: "u-1",
      email: data.email,
      apiKey: data.apiKey,
      createdAt: new Date(),
    }));

    const res = await request(app).post("/api/users").send({ email: "prefix@test.com" });

    expect(res.status).toBe(201);
    expect(res.body.apiKey).toMatch(/^venc_[a-f0-9]{32}$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/users/me
// ═══════════════════════════════════════════════════════════════
describe("GET /api/users/me", () => {
  test("returns current user with owned wallets and shared wallets", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: "user-1",
      email: "test@vencura.dev",
      apiKey: "venc_key",
      createdAt: new Date(),
      ownedWallets: [{ id: "w-1", name: "My Wallet" }],
      walletAccesses: [{ wallet: { id: "w-2", name: "Shared Wallet" } }],
    });

    const res = await request(app).get("/api/users/me");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("user-1");
    expect(res.body.wallets).toHaveLength(2);
    expect(res.body.wallets.some((w: any) => w.id === "w-1")).toBe(true);
    expect(res.body.wallets.some((w: any) => w.id === "w-2")).toBe(true);
  });

  test("returns 404 when authenticated user record is not found in DB", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get("/api/users/me");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User not found");
  });

  test("apiKey is included in /me response (user's own key)", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: "user-1",
      email: "test@vencura.dev",
      apiKey: "venc_key",
      createdAt: new Date(),
      ownedWallets: [],
      walletAccesses: [],
    });

    const res = await request(app).get("/api/users/me");

    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe("venc_key");
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/users  (list, protected)
// ═══════════════════════════════════════════════════════════════
describe("GET /api/users", () => {
  test("returns a list of users without exposing apiKey", async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([
      { id: "u-1", email: "alice@vencura.dev", createdAt: new Date() },
      { id: "u-2", email: "bob@vencura.dev", createdAt: new Date() },
    ]);

    const res = await request(app).get("/api/users");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((u: any) => !("apiKey" in u))).toBe(true);
    expect(res.body[0].email).toBe("alice@vencura.dev");
  });

  test("returns empty array when no users exist", async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(app).get("/api/users");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("returns 500 on DB error", async () => {
    (prisma.user.findMany as jest.Mock).mockRejectedValue(new Error("DB down"));
    const res = await request(app).get("/api/users");
    expect(res.status).toBe(500);
  });
});
