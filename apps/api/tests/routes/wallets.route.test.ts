import express from "express";
import request from "supertest";

jest.mock("../../src/services/walletService", () => ({
  createWallet: jest.fn(),
  createWalletInWalletGroup: jest.fn(),
  getUserWallets: jest.fn(),
  getWalletById: jest.fn(),
  getWalletSigningContext: jest.fn(),
  shareWalletWithUser: jest.fn(),
  updateWalletName: jest.fn(),
}));

import { walletRoutes } from "../../src/routes/wallets";
import { updateWalletName } from "../../src/services/walletService";

describe("walletRoutes", () => {
  const app = express();

  beforeAll(() => {
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: "user-1" } as any;
      next();
    });
    app.use("/api/wallets", walletRoutes);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("PATCH /api/wallets/:walletId validates name is string", async () => {
    const res = await request(app)
      .patch("/api/wallets/wallet-1")
      .send({ name: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("name is required");
    expect(updateWalletName).not.toHaveBeenCalled();
  });

  test("PATCH /api/wallets/:walletId updates wallet name", async () => {
    (updateWalletName as jest.Mock).mockResolvedValue({
      id: "wallet-1",
      name: "New Name",
    });

    const res = await request(app)
      .patch("/api/wallets/wallet-1")
      .send({ name: "New Name" });

    expect(res.status).toBe(200);
    expect(updateWalletName).toHaveBeenCalledWith("wallet-1", "user-1", "New Name");
    expect(res.body.name).toBe("New Name");
  });

  test("PATCH /api/wallets/:walletId returns service errors", async () => {
    (updateWalletName as jest.Mock).mockRejectedValue(
      new Error("Wallet name already exists in this wallet group")
    );

    const res = await request(app)
      .patch("/api/wallets/wallet-1")
      .send({ name: "Existing Name" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Wallet name already exists in this wallet group");
  });
});
