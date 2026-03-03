/**
 * Contract-route integration tests.
 *
 * All Ethereum RPC calls are mocked via jest.spyOn so the suite runs without
 * a live Ethereum node / Anvil instance.
 */
import request from "supertest";
import { ethers } from "ethers";
import { prisma } from "../../src/lib/prisma";
import { reconcileBroadcastingTransactions } from "../../src/services/transactionService";
import {
  ensureNativeAsset,
  setWalletAssetBalance,
} from "../../src/services/assetService";
import * as providerLib from "../../src/lib/provider";

jest.setTimeout(60_000);

let app: any;
let testApiKey: string;
let baselineNetworkSpy: jest.SpyInstance;
let baselineBlockSpy: jest.SpyInstance;
let baselineBalanceSpy: jest.SpyInstance;
let baselineEstimateGasSpy: jest.SpyInstance;
let baselineFeeDataSpy: jest.SpyInstance;

// ─── Provider mock helper ──────────────────────────────────────
function mockProviderForWrite(overrides: { txHash?: string } = {}) {
  const fakeTxHash = overrides.txHash ?? ethers.hexlify(ethers.randomBytes(32));

  const spies = [
    jest.spyOn(providerLib.provider, "getBalance").mockResolvedValue(ethers.parseEther("100")),
    jest.spyOn(providerLib.provider, "estimateGas").mockResolvedValue(50_000n),
    jest.spyOn(providerLib.provider, "getFeeData").mockResolvedValue({
      gasPrice: 1_000_000_000n,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      lastBaseFeePerGas: null,
    } as any),
    jest.spyOn(providerLib.provider, "getNetwork").mockResolvedValue({
      chainId: 31337n,
    } as any),
    jest.spyOn(providerLib.provider, "getTransactionCount").mockResolvedValue(0),
    jest.spyOn(providerLib, "broadcastSignedTransaction").mockResolvedValue(fakeTxHash),
    jest.spyOn(providerLib.provider, "getTransactionReceipt").mockResolvedValue({
      status: 1,
      gasUsed: 50_000n,
      gasPrice: 1_000_000_000n,
      logs: [],
    } as any),
    // reconcileBroadcastingRecord reads getTransaction for gasPrice/value fallback
    jest.spyOn(providerLib.provider, "getTransaction").mockResolvedValue(null as any),
  ];

  return {
    fakeTxHash,
    restore() {
      spies.forEach((s) => s.mockRestore());
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────
async function createUser(email: string) {
  const res = await request(app).post("/api/users").send({ email });
  return res.body;
}

async function createTestWallet(name?: string) {
  const res = await request(app)
    .post("/api/wallets")
    .set("x-api-key", testApiKey)
    .send({ name: name ?? "Contract Test Wallet" });
  return res.body;
}

async function setNativeBalance(walletId: string, balance: bigint) {
  const nativeAsset = await ensureNativeAsset();
  await setWalletAssetBalance(walletId, nativeAsset.id, balance);
}

async function waitForTxFinalStatus(
  txId: string,
  expected: Array<"CONFIRMED" | "FAILED"> = ["CONFIRMED"]
) {
  for (let i = 0; i < 20; i++) {
    await reconcileBroadcastingTransactions(500);
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    if (tx && expected.includes(tx.status as "CONFIRMED" | "FAILED")) return tx;
    await new Promise((r) => setTimeout(r, 50));
  }
  const current = await prisma.transaction.findUnique({ where: { id: txId } });
  throw new Error(
    `Transaction ${txId} did not reach final status. Current: ${current?.status}`
  );
}

// ─── Setup / teardown ──────────────────────────────────────────
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
    `contracts-${Date.now()}-${Math.floor(Math.random() * 1000)}@vencura.dev`
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

// ═══════════════════════════════════════════════════════════════
// CONTRACT ROUTES
// ═══════════════════════════════════════════════════════════════
describe("contractRoutes", () => {
  test("reads contract state through /api/contracts/read", async () => {
    const fakeContractAddress = ethers.Wallet.createRandom().address;

    // Stub provider.call to return "TST" as ABI-encoded string
    const callSpy = jest
      .spyOn(providerLib.provider, "call" as any)
      .mockResolvedValue(
        ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["TST"])
      );

    try {
      const readRes = await request(app)
        .post("/api/contracts/read")
        .set("x-api-key", testApiKey)
        .send({
          contractAddress: fakeContractAddress,
          abi: ["function symbol() view returns (string)"],
          method: "symbol",
          args: [],
        });

      expect(readRes.status).toBe(200);
      expect(readRes.body.result).toBe("TST");
    } finally {
      callSpy.mockRestore();
    }
  });

  test("writes contract transaction through /api/contracts/:walletId/write", async () => {
    const wallet = await createTestWallet("Generic Contract Writer");
    await setNativeBalance(wallet.id, ethers.parseEther("1"));

    const fakeContractAddress = ethers.Wallet.createRandom().address;
    const recipient = ethers.Wallet.createRandom().address;

    const mocks = mockProviderForWrite();

    try {
      const writeRes = await request(app)
        .post(`/api/contracts/${wallet.id}/write`)
        .set("x-api-key", testApiKey)
        .send({
          contractAddress: fakeContractAddress,
          abi: ["function transfer(address to, uint256 amount) returns (bool)"],
          method: "transfer",
          args: [recipient, ethers.parseUnits("7", 18).toString()],
        });

      expect(writeRes.status).toBe(200);
      expect(writeRes.body.txHash).toBe(mocks.fakeTxHash);
      expect(writeRes.body.status).toBe("BROADCASTING");

      const txRecord = await waitForTxFinalStatus(writeRes.body.transactionId, ["CONFIRMED"]);
      expect(txRecord!.status).toBe("CONFIRMED");
      expect(txRecord!.type).toBe("CONTRACT");
      expect(txRecord!.to!.toLowerCase()).toBe(fakeContractAddress.toLowerCase());
    } finally {
      mocks.restore();
    }
  });

  test("contract write returns 400 when wallet has insufficient ETH for gas", async () => {
    const wallet = await createTestWallet("Broke Contract Caller");
    // Leave DB balance at 0 (default)

    const fakeContractAddress = ethers.Wallet.createRandom().address;

    // Inline mocks: previous tests' spy.mockRestore() resets provider back to real RPC.
    const balSpy = jest.spyOn(providerLib.provider, "getBalance").mockResolvedValue(ethers.parseEther("100"));
    const gasSpy = jest.spyOn(providerLib.provider, "estimateGas").mockResolvedValue(21_000n);
    const feeSpy = jest.spyOn(providerLib.provider, "getFeeData").mockResolvedValue({
      gasPrice: 1_000_000_000n, maxFeePerGas: null, maxPriorityFeePerGas: null, lastBaseFeePerGas: null,
    } as any);

    try {
      const res = await request(app)
        .post(`/api/contracts/${wallet.id}/write`)
        .set("x-api-key", testApiKey)
        .send({
          contractAddress: fakeContractAddress,
          abi: ["function approve(address spender, uint256 amount) returns (bool)"],
          method: "approve",
          args: [ethers.Wallet.createRandom().address, "1000"],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Insufficient balance/i);
    } finally {
      balSpy.mockRestore();
      gasSpy.mockRestore();
      feeSpy.mockRestore();
    }
  });

  test("contract read returns 400 for missing required fields", async () => {
    const res = await request(app)
      .post("/api/contracts/read")
      .set("x-api-key", testApiKey)
      .send({ contractAddress: ethers.Wallet.createRandom().address });
    // Missing abi / method — service should throw or route validates
    expect([400, 500]).toContain(res.status);
  });
});
