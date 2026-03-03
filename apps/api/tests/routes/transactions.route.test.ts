import express from "express";
import request from "supertest";

jest.mock("../../src/services/transactionService", () => ({
  sendTransaction: jest.fn(),
  sendAssetTransaction: jest.fn(),
  getMaxSendAmount: jest.fn(),
  replaceByFee: jest.fn(),
  internalTransfer: jest.fn(),
  getWalletTransactions: jest.fn(),
}));

import { transactionRoutes } from "../../src/routes/transactions";
import {
  sendTransaction,
  sendAssetTransaction,
  getMaxSendAmount,
  replaceByFee,
  internalTransfer,
  getWalletTransactions,
} from "../../src/services/transactionService";

const app = express();

beforeAll(() => {
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "user-1", email: "test@vencura.dev", apiKey: "venc_key" } as any;
    next();
  });
  app.use("/api/wallets", transactionRoutes);
});

beforeEach(() => jest.clearAllMocks());

// ═══════════════════════════════════════════════════════════════
// POST /:walletId/send
// ═══════════════════════════════════════════════════════════════
describe("POST /api/wallets/:walletId/send", () => {
  test("returns 400 when 'to' is missing", async () => {
    const res = await request(app)
      .post("/api/wallets/wallet-1/send")
      .send({ amount: "0.1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("to and amount are required");
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  test("returns 400 when 'amount' is missing", async () => {
    const res = await request(app)
      .post("/api/wallets/wallet-1/send")
      .send({ to: "0xRecipient" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("to and amount are required");
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  test("calls sendTransaction for native ETH and returns the result", async () => {
    (sendTransaction as jest.Mock).mockResolvedValue({
      txHash: "0xabc",
      status: "BROADCASTING",
      transactionId: "tx-1",
      nonce: 0,
    });

    const res = await request(app)
      .post("/api/wallets/wallet-1/send")
      .send({ to: "0xRecipient", amount: "0.1" });

    expect(res.status).toBe(200);
    expect(sendTransaction).toHaveBeenCalledWith(
      "wallet-1",
      "user-1",
      "0xRecipient",
      "0.1",
      undefined
    );
    expect(res.body.txHash).toBe("0xabc");
    expect(res.body.status).toBe("BROADCASTING");
  });

  test("routes to sendAssetTransaction when assetId is provided", async () => {
    (sendAssetTransaction as jest.Mock).mockResolvedValue({
      txHash: "0xdef",
      status: "BROADCASTING",
      transactionId: "tx-2",
    });

    const res = await request(app)
      .post("/api/wallets/wallet-1/send")
      .send({ to: "0xRecipient", amount: "50", assetId: "asset-1" });

    expect(res.status).toBe(200);
    expect(sendAssetTransaction).toHaveBeenCalledWith(
      "wallet-1",
      "user-1",
      "0xRecipient",
      "50",
      "asset-1",
      undefined
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  test("passes gasPrice and nonce overrides when provided", async () => {
    (sendTransaction as jest.Mock).mockResolvedValue({ txHash: "0x1", status: "BROADCASTING" });

    await request(app)
      .post("/api/wallets/wallet-1/send")
      .send({ to: "0xR", amount: "0.1", gasPrice: "2000000000", nonce: 5 });

    expect(sendTransaction).toHaveBeenCalledWith(
      "wallet-1",
      "user-1",
      "0xR",
      "0.1",
      { gasPrice: 2_000_000_000n, nonce: 5 }
    );
  });

  test("returns 400 when service throws (e.g. insufficient balance)", async () => {
    (sendTransaction as jest.Mock).mockRejectedValue(new Error("Insufficient balance: need 1.00 ETH"));

    const res = await request(app)
      .post("/api/wallets/wallet-1/send")
      .send({ to: "0xR", amount: "999" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Insufficient balance/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /:walletId/send-max
// ═══════════════════════════════════════════════════════════════
describe("GET /api/wallets/:walletId/send-max", () => {
  test("returns 400 when assetId query param is missing", async () => {
    const res = await request(app).get("/api/wallets/wallet-1/send-max");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("assetId is required");
    expect(getMaxSendAmount).not.toHaveBeenCalled();
  });

  test("returns 400 when assetId is empty string", async () => {
    const res = await request(app).get("/api/wallets/wallet-1/send-max?assetId=");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("assetId is required");
  });

  test("returns max send amount for the given asset", async () => {
    (getMaxSendAmount as jest.Mock).mockResolvedValue({
      maxAmount: "900000000000000000",
      assetType: "NATIVE",
    });

    const res = await request(app).get("/api/wallets/wallet-1/send-max?assetId=native%3Aeth");

    expect(res.status).toBe(200);
    expect(getMaxSendAmount).toHaveBeenCalledWith("wallet-1", "user-1", "native:eth", undefined);
    expect(res.body.maxAmount).toBe("900000000000000000");
    expect(res.body.assetType).toBe("NATIVE");
  });

  test("passes to address when provided", async () => {
    (getMaxSendAmount as jest.Mock).mockResolvedValue({ maxAmount: "950000000000000000" });

    await request(app).get(
      "/api/wallets/wallet-1/send-max?assetId=native%3Aeth&to=0xRecipient"
    );

    expect(getMaxSendAmount).toHaveBeenCalledWith(
      "wallet-1",
      "user-1",
      "native:eth",
      "0xRecipient"
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /:walletId/rbf
// ═══════════════════════════════════════════════════════════════
describe("POST /api/wallets/:walletId/rbf", () => {
  test("returns 400 when originalTxId is missing", async () => {
    const res = await request(app)
      .post("/api/wallets/wallet-1/rbf")
      .send({ gasPrice: "2000000000" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("originalTxId and gasPrice are required");
    expect(replaceByFee).not.toHaveBeenCalled();
  });

  test("returns 400 when gasPrice is missing", async () => {
    const res = await request(app)
      .post("/api/wallets/wallet-1/rbf")
      .send({ originalTxId: "tx-1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("originalTxId and gasPrice are required");
  });

  test("calls replaceByFee and returns the new transaction", async () => {
    (replaceByFee as jest.Mock).mockResolvedValue({
      txHash: "0xnew",
      status: "BROADCASTING",
      transactionId: "tx-new",
    });

    const res = await request(app)
      .post("/api/wallets/wallet-1/rbf")
      .send({ originalTxId: "tx-old", gasPrice: "3000000000" });

    expect(res.status).toBe(200);
    expect(replaceByFee).toHaveBeenCalledWith(
      "wallet-1",
      "user-1",
      "tx-old",
      3_000_000_000n
    );
    expect(res.body.txHash).toBe("0xnew");
  });

  test("returns 400 when service throws", async () => {
    (replaceByFee as jest.Mock).mockRejectedValue(new Error("Original tx not found"));
    const res = await request(app)
      .post("/api/wallets/wallet-1/rbf")
      .send({ originalTxId: "tx-ghost", gasPrice: "1000000000" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Original tx not found");
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /:walletId/transfer
// ═══════════════════════════════════════════════════════════════
describe("POST /api/wallets/:walletId/transfer", () => {
  test("returns 400 when toWalletId is missing", async () => {
    const res = await request(app)
      .post("/api/wallets/wallet-1/transfer")
      .send({ amount: "1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("toWalletId and amount are required");
    expect(internalTransfer).not.toHaveBeenCalled();
  });

  test("returns 400 when amount is missing", async () => {
    const res = await request(app)
      .post("/api/wallets/wallet-1/transfer")
      .send({ toWalletId: "wallet-2" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("toWalletId and amount are required");
  });

  test("calls internalTransfer and returns debit/credit tx IDs", async () => {
    (internalTransfer as jest.Mock).mockResolvedValue({
      debitTxId: "tx-debit",
      creditTxId: "tx-credit",
    });

    const res = await request(app)
      .post("/api/wallets/wallet-1/transfer")
      .send({ toWalletId: "wallet-2", amount: "1.5" });

    expect(res.status).toBe(200);
    expect(internalTransfer).toHaveBeenCalledWith(
      "wallet-1",
      "wallet-2",
      "user-1",
      "1.5",
      undefined
    );
    expect(res.body.debitTxId).toBe("tx-debit");
    expect(res.body.creditTxId).toBe("tx-credit");
  });

  test("forwards optional assetId to internalTransfer", async () => {
    (internalTransfer as jest.Mock).mockResolvedValue({ debitTxId: "d", creditTxId: "c" });
    await request(app)
      .post("/api/wallets/wallet-1/transfer")
      .send({ toWalletId: "wallet-2", amount: "10", assetId: "asset-1" });
    expect(internalTransfer).toHaveBeenCalledWith(
      "wallet-1",
      "wallet-2",
      "user-1",
      "10",
      "asset-1"
    );
  });

  test("returns 400 on service error", async () => {
    (internalTransfer as jest.Mock).mockRejectedValue(new Error("Insufficient balance"));
    const res = await request(app)
      .post("/api/wallets/wallet-1/transfer")
      .send({ toWalletId: "wallet-2", amount: "999" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Insufficient balance");
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /:walletId/transactions
// ═══════════════════════════════════════════════════════════════
describe("GET /api/wallets/:walletId/transactions", () => {
  test("returns the transaction history for a wallet", async () => {
    const mockTxs = [
      { id: "tx-1", type: "WITHDRAWAL", status: "CONFIRMED", amount: "100000000000000000" },
      { id: "tx-2", type: "DEPOSIT", status: "CONFIRMED", amount: "500000000000000000" },
    ];
    (getWalletTransactions as jest.Mock).mockResolvedValue(mockTxs);

    const res = await request(app).get("/api/wallets/wallet-1/transactions");

    expect(res.status).toBe(200);
    expect(getWalletTransactions).toHaveBeenCalledWith("wallet-1", "user-1");
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe("tx-1");
  });

  test("returns 400 when service throws (e.g. wallet not accessible)", async () => {
    (getWalletTransactions as jest.Mock).mockRejectedValue(new Error("Wallet not found"));
    const res = await request(app).get("/api/wallets/wallet-1/transactions");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Wallet not found");
  });

  test("returns empty array when wallet has no transactions", async () => {
    (getWalletTransactions as jest.Mock).mockResolvedValue([]);
    const res = await request(app).get("/api/wallets/wallet-1/transactions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
