import express from "express";
import request from "supertest";
import { ethers } from "ethers";

jest.mock("../../src/lib/provider", () => ({
  provider: {
    getBalance: jest.fn(),
  },
}));

jest.mock("../../src/services/balanceService", () => ({
  getWalletAssetBalanceByContract: jest.fn(),
  getWalletAssetBalances: jest.fn(),
  getWalletNativeBalance: jest.fn(),
}));

jest.mock("../../src/lib/prisma", () => ({
  prisma: {
    wallet: {
      findFirst: jest.fn(),
    },
    walletAssetBalance: {
      findFirst: jest.fn(),
    },
  },
}));

import { balanceRoutes } from "../../src/routes/balance";
import { provider } from "../../src/lib/provider";
import {
  getWalletAssetBalanceByContract,
  getWalletAssetBalances,
  getWalletNativeBalance,
} from "../../src/services/balanceService";
import { prisma } from "../../src/lib/prisma";

const app = express();

beforeAll(() => {
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "user-1", email: "test@vencura.dev", apiKey: "venc_key" } as any;
    next();
  });
  app.use("/api/balance", balanceRoutes);
});

beforeEach(() => jest.clearAllMocks());

// ═══════════════════════════════════════════════════════════════
// GET /:addressOrWalletId  (native balance)
// ═══════════════════════════════════════════════════════════════
describe("GET /api/balance/:addressOrWalletId (native)", () => {
  test("returns on-chain balance for a raw Ethereum address when no wallet found", async () => {
    const addr = ethers.Wallet.createRandom().address;
    (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(null);
    (provider.getBalance as jest.Mock).mockResolvedValue(ethers.parseEther("1.5"));

    const res = await request(app).get(`/api/balance/${addr}`);

    expect(res.status).toBe(200);
    expect(res.body.address).toBe(addr);
    expect(res.body.balance).toBe(ethers.parseEther("1.5").toString());
    expect(res.body.formatted).toBe("1.5");
  });

  test("returns 404 for an input that is neither a valid address nor a known wallet ID", async () => {
    (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app).get("/api/balance/not-a-real-id");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Wallet not found");
    expect(provider.getBalance).not.toHaveBeenCalled();
  });

  test("returns DB-backed native balance when wallet is found by ID", async () => {
    (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({ id: "wallet-1" });
    (getWalletNativeBalance as jest.Mock).mockResolvedValue({
      balance: "1500000000000000000",
      formatted: "1.5",
      address: "0xWalletAddr",
    });

    const res = await request(app).get("/api/balance/wallet-1");

    expect(res.status).toBe(200);
    expect(getWalletNativeBalance).toHaveBeenCalledWith("wallet-1");
    expect(provider.getBalance).not.toHaveBeenCalled();
  });

  test("zero on-chain balance for unfunded address", async () => {
    const addr = ethers.Wallet.createRandom().address;
    (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(null);
    (provider.getBalance as jest.Mock).mockResolvedValue(0n);

    const res = await request(app).get(`/api/balance/${addr}`);

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe("0");
    expect(res.body.formatted).toBe("0.0");
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /:addressOrWalletId?asset=<contractAddress>  (ERC-20)
// ═══════════════════════════════════════════════════════════════
describe("GET /api/balance/:addressOrWalletId?asset=<contract>", () => {
  test("returns ERC-20 balance for a known wallet queried by contract address", async () => {
    const tokenAddr = ethers.Wallet.createRandom().address;
    (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({ id: "wallet-1" });
    (getWalletAssetBalanceByContract as jest.Mock).mockResolvedValue({
      balance: "50000000000000000000",
      formatted: "50.0",
      symbol: "TST",
      decimals: 18,
    });

    const res = await request(app).get(`/api/balance/wallet-1?asset=${tokenAddr}`);

    expect(res.status).toBe(200);
    expect(getWalletAssetBalanceByContract).toHaveBeenCalledWith("wallet-1", tokenAddr);
    expect(res.body.symbol).toBe("TST");
  });

  test("returns asset balance by assetId for a known wallet", async () => {
    (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({ id: "wallet-1" });
    (prisma.walletAssetBalance.findFirst as jest.Mock).mockResolvedValue({
      balance: "100000000000000000000",
      assetId: "asset-xyz",
      asset: { decimals: 18, symbol: "TST", contractAddress: "0xToken" },
    });

    const res = await request(app).get("/api/balance/wallet-1?asset=asset-xyz");

    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe("TST");
    expect(res.body.assetId).toBe("asset-xyz");
  });

  test("returns 404 when asset balance not found for given assetId", async () => {
    (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({ id: "wallet-1" });
    (prisma.walletAssetBalance.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app).get("/api/balance/wallet-1?asset=asset-missing");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Asset balance not found");
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /wallet/:walletId/assets
// ═══════════════════════════════════════════════════════════════
describe("GET /api/balance/wallet/:walletId/assets", () => {
  test("returns all asset balances for an accessible wallet", async () => {
    const mockAssets = [
      { assetId: "native:eth", balance: "1000000000000000000", symbol: "ETH", type: "NATIVE" },
      { assetId: "asset-2", balance: "500000000000000000000", symbol: "TST", type: "ERC20" },
    ];
    (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({ id: "wallet-1" });
    (getWalletAssetBalances as jest.Mock).mockResolvedValue(mockAssets);

    const res = await request(app).get("/api/balance/wallet/wallet-1/assets");

    expect(res.status).toBe(200);
    expect(getWalletAssetBalances).toHaveBeenCalledWith("wallet-1");
    expect(res.body).toHaveLength(2);
    expect(res.body[0].symbol).toBe("ETH");
  });

  test("returns 404 when wallet is not accessible to the user", async () => {
    (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app).get("/api/balance/wallet/wallet-stranger/assets");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Wallet not found");
    expect(getWalletAssetBalances).not.toHaveBeenCalled();
  });
});
