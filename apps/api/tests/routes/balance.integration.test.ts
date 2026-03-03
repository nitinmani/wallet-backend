/**
 * Balance-route integration tests.
 *
 * All RPC calls are mocked via jest.spyOn — no Anvil / local chain required.
 * Deposit-detection coverage lives in services/balanceService.integration.test.ts.
 */
import request from "supertest";
import { ethers } from "ethers";
import { prisma } from "../../src/lib/prisma";
import * as providerLib from "../../src/lib/provider";
import {
  ensureNativeAsset,
  getWalletAssetBalance,
  setWalletAssetBalance,
} from "../../src/services/assetService";

jest.setTimeout(60_000);

let app: any;
let testApiKey: string;
let baselineNetworkSpy: jest.SpyInstance;
let baselineBlockSpy: jest.SpyInstance;
let baselineBalanceSpy: jest.SpyInstance;
let baselineEstimateGasSpy: jest.SpyInstance;
let baselineFeeDataSpy: jest.SpyInstance;

async function createUser(email: string) {
  const res = await request(app).post("/api/users").send({ email });
  return res.body;
}

async function createTestWallet(name?: string) {
  const res = await request(app)
    .post("/api/wallets")
    .set("x-api-key", testApiKey)
    .send({ name: name ?? "Balance Test Wallet" });
  return res.body;
}

async function setNativeBalance(walletId: string, balance: bigint) {
  const nativeAsset = await ensureNativeAsset();
  await setWalletAssetBalance(walletId, nativeAsset.id, balance);
}

beforeAll(async () => {
  // Seed provider so createWallet (getBlockNumber) and ensureNativeAsset (getNetwork)
  // succeed without a live RPC node.
  baselineNetworkSpy = jest
    .spyOn(providerLib.provider, "getNetwork")
    .mockResolvedValue({ chainId: 31337n } as any);
  baselineBlockSpy = jest
    .spyOn(providerLib.provider, "getBlockNumber")
    .mockResolvedValue(0);
  baselineBalanceSpy = jest
    .spyOn(providerLib.provider, "getBalance")
    .mockResolvedValue(ethers.parseEther("100"));
  baselineEstimateGasSpy = jest
    .spyOn(providerLib.provider, "estimateGas")
    .mockResolvedValue(21_000n);
  baselineFeeDataSpy = jest
    .spyOn(providerLib.provider, "getFeeData")
    .mockResolvedValue({
      gasPrice: 1_000_000_000n,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      lastBaseFeePerGas: null,
    } as any);

  const appModule = await import("../../src/app");
  app = appModule.default;
});

beforeEach(async () => {
  await prisma.transaction.deleteMany();
  await prisma.walletAccess.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.walletGroup.deleteMany();
  await prisma.user.deleteMany();

  const user = await createUser(
    `balance-${Date.now()}-${Math.floor(Math.random() * 1000)}@vencura.dev`
  );
  testApiKey = user.apiKey;
});

afterAll(async () => {
  await prisma.transaction.deleteMany();
  await prisma.walletAccess.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.walletGroup.deleteMany();
  await prisma.user.deleteMany();
  baselineNetworkSpy?.mockRestore();
  baselineBlockSpy?.mockRestore();
  baselineBalanceSpy?.mockRestore();
  baselineEstimateGasSpy?.mockRestore();
  baselineFeeDataSpy?.mockRestore();
  await prisma.$disconnect();
});

describe("balanceRoutes", () => {
  test("returns balance for a random (non-wallet) address", async () => {
    const randomAddr = ethers.Wallet.createRandom().address;
    const balanceSpy = jest
      .spyOn(providerLib.provider, "getBalance")
      .mockResolvedValue(ethers.parseEther("0.5"));

    try {
      const res = await request(app)
        .get(`/api/balance/${randomAddr}`)
        .set("x-api-key", testApiKey);

      expect(res.status).toBe(200);
      expect(res.body.address).toBe(randomAddr);
      expect(res.body.balance).toBeDefined();
      expect(res.body.formatted).toBeDefined();
    } finally {
      balanceSpy.mockRestore();
    }
  });

  test("returns DB-backed balance for a wallet address (by wallet ID)", async () => {
    const wallet = await createTestWallet("Balance Wallet");
    await setNativeBalance(wallet.id, ethers.parseEther("1.5"));

    const res = await request(app)
      .get(`/api/balance/${wallet.id}`)
      .set("x-api-key", testApiKey);

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(ethers.parseEther("1.5").toString());
    expect(res.body.formatted).toBe("1.5");
  });

  test("empty wallet returns zero balance", async () => {
    const wallet = await createTestWallet("Empty Wallet");

    const res = await request(app)
      .get(`/api/balance/${wallet.id}`)
      .set("x-api-key", testApiKey);

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe("0");
    expect(res.body.formatted).toBe("0.0");
  });
});
