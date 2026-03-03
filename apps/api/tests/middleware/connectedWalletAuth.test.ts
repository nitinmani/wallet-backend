import { Request, Response } from "express";

jest.mock("../../src/services/connectedWalletService", () => ({
  authenticateConnectedWalletSession: jest.fn(),
}));

import {
  connectedWalletAuthMiddleware,
  getConnectedWalletBearerToken,
} from "../../src/middleware/connectedWalletAuth";
import { authenticateConnectedWalletSession } from "../../src/services/connectedWalletService";

describe("connectedWalletAuthMiddleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("extracts bearer token from header", () => {
    const req = {
      headers: {
        authorization: "Bearer token-123",
      },
    } as Request;
    expect(getConnectedWalletBearerToken(req)).toBe("token-123");
  });

  test("returns 401 when bearer token is missing", async () => {
    const req = { headers: {} } as Request;
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const res = { status, json } as unknown as Response;
    const next = jest.fn();

    await connectedWalletAuthMiddleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: "Missing connected wallet bearer token",
    });
    expect(next).not.toHaveBeenCalled();
  });

  test("authenticates and sets req.connectedWallet on success", async () => {
    const req = {
      headers: { authorization: "Bearer token-abc" },
    } as Request;
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const res = { status, json } as unknown as Response;
    const next = jest.fn();

    (authenticateConnectedWalletSession as jest.Mock).mockResolvedValue({
      sessionId: "session-1",
      wallet: { address: "0x9C122F75866c77a619f3298E25FE4aEf246b6b00" },
    });

    await connectedWalletAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.connectedWallet).toEqual({
      sessionId: "session-1",
      address: "0x9C122F75866c77a619f3298E25FE4aEf246b6b00",
    });
    expect(status).not.toHaveBeenCalled();
  });

  test("returns 401 when session authentication fails", async () => {
    const req = {
      headers: { authorization: "Bearer tampered-token" },
    } as Request;
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const res = { status, json } as unknown as Response;
    const next = jest.fn();

    (authenticateConnectedWalletSession as jest.Mock).mockRejectedValue(
      new Error("Invalid connected wallet session")
    );

    await connectedWalletAuthMiddleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: "Invalid connected wallet session",
    });
    expect(next).not.toHaveBeenCalled();
  });
});
