import { Request, Response, NextFunction } from "express";

jest.mock("../../src/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
  },
}));

import { authMiddleware } from "../../src/middleware/auth";
import { prisma } from "../../src/lib/prisma";

describe("authMiddleware", () => {
  let req: Partial<Request>;
  let json: jest.Mock;
  let status: jest.Mock;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    json = jest.fn();
    status = jest.fn().mockReturnThis();
    res = { status, json } as unknown as Response;
    next = jest.fn();
  });

  test("returns 401 when x-api-key header is missing", async () => {
    req = { headers: {} } as Request;
    await authMiddleware(req as Request, res as Response, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Missing x-api-key header" });
    expect(next).not.toHaveBeenCalled();
  });

  test("returns 401 when API key does not match any user", async () => {
    req = { headers: { "x-api-key": "venc_doesnotexist" } } as any;
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    await authMiddleware(req as Request, res as Response, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Invalid API key" });
    expect(next).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { apiKey: "venc_doesnotexist" } });
  });

  test("calls next() and sets req.user when API key is valid", async () => {
    req = { headers: { "x-api-key": "venc_abc123" } } as any;
    const mockUser = { id: "user-1", email: "test@vencura.dev", apiKey: "venc_abc123" };
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

    await authMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).user).toEqual({
      id: "user-1",
      email: "test@vencura.dev",
      apiKey: "venc_abc123",
    });
    expect(status).not.toHaveBeenCalled();
  });

  test("returns 503 when database throws an error", async () => {
    req = { headers: { "x-api-key": "venc_abc123" } } as any;
    (prisma.user.findUnique as jest.Mock).mockRejectedValue(new Error("Connection refused"));

    await authMiddleware(req as Request, res as Response, next);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      error: "Database unavailable. Please try again.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  test("looks up user by the provided API key", async () => {
    req = { headers: { "x-api-key": "venc_mykey" } } as any;
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: "u-2",
      email: "alice@vencura.dev",
      apiKey: "venc_mykey",
    });

    await authMiddleware(req as Request, res as Response, next);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { apiKey: "venc_mykey" } });
  });
});
