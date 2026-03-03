/**
 * Concurrency tests.
 *
 * Verifies the fixes for all concurrency issues identified in the codebase:
 *
 * 1. Balance double-spend — pre-decrement within advisory lock prevents two
 *    concurrent sends from both passing the balance check.
 * 2. syncBalances vs reconcile conflict — syncBalances skips wallets with any
 *    BROADCASTING transactions so it cannot clobber the reserved balance.
 * 3. Deposit deduplication — DB unique constraint on (walletId, txHash,
 *    assetType) prevents duplicate deposit records from concurrent scans.
 * 4. lockedAmount restoration in reconcile — reconciler restores the
 *    estimated-gas reserve before applying the actual on-chain cost, so the
 *    difference between estimated and actual gas does not leak from the wallet.
 * 5. ensureNativeAsset idempotency — upsert on contractAddress="native"
 *    guarantees exactly one native-asset row even under concurrent callers.
 */
import request from "supertest";
import { ethers } from "ethers";
import { prisma } from "../../src/lib/prisma";
import { reconcileBroadcastingTransactions } from "../../src/services/transactionService";
import { syncBalances } from "../../src/services/balanceService";
import {
  ensureNativeAsset,
  getWalletAssetBalance,
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

// ─── Provider mock helpers ──────────────────────────────────────

function mockProviderForSend(overrides: {
  balanceWei?: bigint;
  receiptStatus?: number;
  gasUsed?: bigint;
  gasPrice?: bigint;
} = {}) {
  const balance = overrides.balanceWei ?? ethers.parseEther("100");
  const receiptStatus = overrides.receiptStatus ?? 1;
  const gasUsed = overrides.gasUsed ?? 21_000n;
  const gasPrice = overrides.gasPrice ?? 1_000_000_000n;

  const spies = [
    jest.spyOn(providerLib.provider, "getBalance").mockResolvedValue(balance),
    jest.spyOn(providerLib.provider, "estimateGas").mockResolvedValue(21_000n),
    jest.spyOn(providerLib.provider, "getFeeData").mockResolvedValue({
      gasPrice,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      lastBaseFeePerGas: null,
    } as any),
    jest.spyOn(providerLib.provider, "getNetwork").mockResolvedValue({
      chainId: 31337n,
    } as any),
    jest.spyOn(providerLib.provider, "getTransactionCount").mockResolvedValue(0),
    // Each broadcast returns a unique hash — prevents the @@unique([walletId,
    // txHash, assetType]) constraint from firing when two sends succeed.
    jest.spyOn(providerLib, "broadcastSignedTransaction").mockImplementation(
      async () => ethers.hexlify(ethers.randomBytes(32))
    ),
    jest.spyOn(providerLib.provider, "getTransactionReceipt").mockResolvedValue({
      status: receiptStatus,
      gasUsed,
      gasPrice,
      logs: [],
    } as any),
    jest.spyOn(providerLib.provider, "getTransaction").mockResolvedValue(null as any),
  ];

  return {
    restore() {
      spies.forEach((s) => s.mockRestore());
    },
  };
}

// ─── Setup / teardown ──────────────────────────────────────────

beforeAll(async () => {
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

  await prisma.transaction.deleteMany();
  await prisma.walletAssetBalance.deleteMany();
  await prisma.walletAccess.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.walletGroup.deleteMany();
  await prisma.user.deleteMany();

  const res = await request(app)
    .post("/api/users")
    .send({ email: "concurrency-test@vencura.dev" });
  testApiKey = res.body.apiKey;
});

afterAll(async () => {
  await prisma.transaction.deleteMany();
  await prisma.walletAssetBalance.deleteMany();
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

async function createTestWallet(name?: string) {
  const res = await request(app)
    .post("/api/wallets")
    .set("x-api-key", testApiKey)
    .send({ name: name ?? "Test Wallet" });
  return res.body as { id: string; walletGroupId: string };
}

async function setNativeBalance(walletId: string, balance: bigint) {
  const nativeAsset = await ensureNativeAsset();
  await setWalletAssetBalance(walletId, nativeAsset.id, balance);
}

async function getNativeBalance(walletId: string): Promise<bigint> {
  const nativeAsset = await ensureNativeAsset();
  return getWalletAssetBalance(walletId, nativeAsset.id);
}

// ═══════════════════════════════════════════════════════════════
// Issue 1: Balance pre-decrement prevents double-spend
// ═══════════════════════════════════════════════════════════════
describe("double-spend prevention", () => {
  test("concurrent sends where the total exceeds balance: only one succeeds", async () => {
    // Balance is enough for ONE send (0.1 ETH + gas) but not two.
    // gasPrice = 1 gwei, gasLimit = 21_000 → gasCost = 0.000021 ETH
    // totalReserved per send ≈ 0.100021 ETH → two sends need ≈ 0.200042 ETH
    const wallet = await createTestWallet("Double Spend Wallet");
    await setNativeBalance(wallet.id, ethers.parseEther("0.15"));

    const recipient = ethers.Wallet.createRandom().address;
    const mocks = mockProviderForSend();
    try {
      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/wallets/${wallet.id}/send`)
          .set("x-api-key", testApiKey)
          .send({ to: recipient, amount: "0.1" }),
        request(app)
          .post(`/api/wallets/${wallet.id}/send`)
          .set("x-api-key", testApiKey)
          .send({ to: recipient, amount: "0.1" }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      // The advisory lock serialises sends; the pre-decrement inside the lock
      // ensures the second send sees the reduced balance and fails.
      expect(statuses).toEqual([200, 400]);

      const successBody = res1.status === 200 ? res1.body : res2.body;
      expect(successBody.status).toBe("BROADCASTING");
    } finally {
      mocks.restore();
    }
  });

  test("concurrent sends where balance is sufficient for both: both succeed with sequential nonces", async () => {
    // Balance covers two sends with room to spare.
    const wallet = await createTestWallet("Two-Send Wallet");
    await setNativeBalance(wallet.id, ethers.parseEther("2"));

    const recipient = ethers.Wallet.createRandom().address;
    const mocks = mockProviderForSend();
    try {
      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/wallets/${wallet.id}/send`)
          .set("x-api-key", testApiKey)
          .send({ to: recipient, amount: "0.1" }),
        request(app)
          .post(`/api/wallets/${wallet.id}/send`)
          .set("x-api-key", testApiKey)
          .send({ to: recipient, amount: "0.1" }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Nonces must be different (advisory lock serialises the nonce assignment).
      expect(res1.body.nonce).not.toBe(res2.body.nonce);

      // The DB balance should reflect both pre-decrements.
      const remaining = await getNativeBalance(wallet.id);
      const gasPerSend = 21_000n * 1_000_000_000n;
      const expectedMax = ethers.parseEther("2") - ethers.parseEther("0.1") * 2n - gasPerSend * 2n;
      expect(remaining).toBeLessThanOrEqual(expectedMax + 1n); // allow 1 wei rounding
    } finally {
      mocks.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Issue 2: syncBalances skips BROADCASTING wallets
// ═══════════════════════════════════════════════════════════════
describe("syncBalances skips BROADCASTING wallets", () => {
  test("does not overwrite the reserved DB balance while a tx is in-flight", async () => {
    const wallet = await createTestWallet("Sync-Skip Wallet");
    // Set DB balance to the post-pre-decrement value (funds partially reserved).
    const reservedBalance = ethers.parseEther("0.9");
    await setNativeBalance(wallet.id, reservedBalance);

    // Simulate a tx that was broadcast but not yet confirmed.
    await prisma.transaction.create({
      data: {
        walletId: wallet.id,
        type: "WITHDRAWAL",
        amount: ethers.parseEther("0.1").toString(),
        status: "BROADCASTING",
        txHash: ethers.hexlify(ethers.randomBytes(32)),
        lockedAmount: ethers.parseEther("0.1").toString(),
      },
    });

    // Mock the on-chain balance to a DIFFERENT (higher) value.
    const chainBalanceSpy = jest
      .spyOn(providerLib.provider, "getBalance")
      .mockResolvedValue(ethers.parseEther("5"));
    try {
      await syncBalances();
    } finally {
      chainBalanceSpy.mockRestore();
    }

    // syncBalances must NOT have overwritten the reserved balance.
    const balanceAfterSync = await getNativeBalance(wallet.id);
    expect(balanceAfterSync).toBe(reservedBalance);
  });

  test("syncs balance normally when no BROADCASTING transactions exist", async () => {
    const wallet = await createTestWallet("Sync-Normal Wallet");
    await setNativeBalance(wallet.id, ethers.parseEther("0.5"));

    const chainBalance = ethers.parseEther("1.23");
    const chainBalanceSpy = jest
      .spyOn(providerLib.provider, "getBalance")
      .mockResolvedValue(chainBalance);
    try {
      await syncBalances();
    } finally {
      chainBalanceSpy.mockRestore();
    }

    const balanceAfterSync = await getNativeBalance(wallet.id);
    expect(balanceAfterSync).toBe(chainBalance);
  });
});

// ═══════════════════════════════════════════════════════════════
// Issue 3: Deposit deduplication via DB unique constraint
// ═══════════════════════════════════════════════════════════════
describe("deposit deduplication", () => {
  test("inserting a duplicate (walletId, txHash, assetType) deposit is rejected", async () => {
    const wallet = await createTestWallet("Dedup Wallet");
    const txHash = ethers.hexlify(ethers.randomBytes(32));

    await prisma.transaction.create({
      data: {
        walletId: wallet.id,
        type: "DEPOSIT",
        assetType: "NATIVE",
        assetSymbol: "ETH",
        amount: ethers.parseEther("1").toString(),
        txHash,
        status: "CONFIRMED",
      },
    });

    // A second insert with the same (walletId, txHash, assetType) must fail.
    await expect(
      prisma.transaction.create({
        data: {
          walletId: wallet.id,
          type: "DEPOSIT",
          assetType: "NATIVE",
          assetSymbol: "ETH",
          amount: ethers.parseEther("0.5").toString(),
          txHash, // same hash → violates @@unique([walletId, txHash, assetType])
          status: "CONFIRMED",
        },
      })
    ).rejects.toThrow();
  });

  test("null txHash rows (internal transfers) are not subject to the dedup constraint", async () => {
    const wallet = await createTestWallet("Internal Transfer Wallet");

    // Two internal transfers (txHash=null) for the same wallet must both succeed.
    await expect(
      Promise.all([
        prisma.transaction.create({
          data: {
            walletId: wallet.id,
            type: "WITHDRAWAL",
            assetType: "NATIVE",
            amount: ethers.parseEther("0.5").toString(),
            txHash: null,
            status: "CONFIRMED",
          },
        }),
        prisma.transaction.create({
          data: {
            walletId: wallet.id,
            type: "WITHDRAWAL",
            assetType: "NATIVE",
            amount: ethers.parseEther("0.3").toString(),
            txHash: null,
            status: "CONFIRMED",
          },
        }),
      ])
    ).resolves.toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// Issue 4 / 5: lockedAmount restoration in reconcile
// ═══════════════════════════════════════════════════════════════
describe("lockedAmount restoration during reconciliation", () => {
  test("actual gas less than estimated: wallet retains the difference", async () => {
    const wallet = await createTestWallet("Reconcile Lock Wallet");

    // Pre-decrement by 0.002 ETH (estimated gas).
    // Real scenario: sendTransaction decremented the balance before broadcasting.
    const startBalance = ethers.parseEther("1.0");
    const estimatedGas = ethers.parseEther("0.002"); // 2_000_000 gas * 1 gwei
    await setNativeBalance(wallet.id, startBalance - estimatedGas);

    // Insert a BROADCASTING tx with lockedAmount = estimated gas.
    const txHash = ethers.hexlify(ethers.randomBytes(32));
    await prisma.transaction.create({
      data: {
        walletId: wallet.id,
        type: "WITHDRAWAL",
        assetType: "NATIVE",
        assetSymbol: "ETH",
        amount: "0", // ETH value sent on-chain (0 for gas-only)
        txHash,
        status: "BROADCASTING",
        lockedAmount: estimatedGas.toString(),
      },
    });

    // Receipt shows only 0.001 ETH was actually spent on gas.
    const actualGasUsed = 1_000_000n; // 1M gas
    const gasPriceWei = 1_000n; // 1000 wei/gas = 0.000001 gwei
    const actualGasCost = actualGasUsed * gasPriceWei; // 0.000000001 ETH (1M * 1000 wei)

    const receiptSpy = jest
      .spyOn(providerLib.provider, "getTransactionReceipt")
      .mockResolvedValue({
        status: 1,
        gasUsed: actualGasUsed,
        gasPrice: gasPriceWei,
        logs: [],
      } as any);
    const txSpy = jest
      .spyOn(providerLib.provider, "getTransaction")
      .mockResolvedValue({ gasPrice: gasPriceWei, value: 0n } as any);

    try {
      await reconcileBroadcastingTransactions(10);
    } finally {
      receiptSpy.mockRestore();
      txSpy.mockRestore();
    }

    // Final balance = startBalance - actualGasCost
    // (NOT startBalance - estimatedGas - actualGasCost, which would be wrong).
    const finalBalance = await getNativeBalance(wallet.id);
    expect(finalBalance).toBe(startBalance - actualGasCost);

    const txRecord = await prisma.transaction.findFirst({
      where: { walletId: wallet.id, txHash },
    });
    expect(txRecord?.status).toBe("CONFIRMED");
  });

  test("failed broadcast: catch block restores the reserved balance immediately", async () => {
    const wallet = await createTestWallet("Failed Send Wallet");
    const startBalance = ethers.parseEther("1.0");
    await setNativeBalance(wallet.id, startBalance);

    const recipient = ethers.Wallet.createRandom().address;

    // Simulate broadcast failure.
    const broadcastSpy = jest
      .spyOn(providerLib, "broadcastSignedTransaction")
      .mockRejectedValue(new Error("network error: nonce too low"));
    const otherSpies = [
      jest.spyOn(providerLib.provider, "estimateGas").mockResolvedValue(21_000n),
      jest.spyOn(providerLib.provider, "getFeeData").mockResolvedValue({
        gasPrice: 1_000_000_000n,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
        lastBaseFeePerGas: null,
      } as any),
      jest.spyOn(providerLib.provider, "getBalance").mockResolvedValue(ethers.parseEther("100")),
      jest.spyOn(providerLib.provider, "getNetwork").mockResolvedValue({ chainId: 31337n } as any),
      jest.spyOn(providerLib.provider, "getTransactionCount").mockResolvedValue(0),
    ];

    try {
      const res = await request(app)
        .post(`/api/wallets/${wallet.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: recipient, amount: "0.1" });

      // Broadcast failed → route returns 400.
      expect(res.status).toBe(400);
    } finally {
      broadcastSpy.mockRestore();
      otherSpies.forEach((s) => s.mockRestore());
    }

    // Balance must be fully restored — no funds should be stuck in the "reserved" state.
    const balanceAfterFailure = await getNativeBalance(wallet.id);
    expect(balanceAfterFailure).toBe(startBalance);
  });
});

// ═══════════════════════════════════════════════════════════════
// Issue 7: ensureNativeAsset idempotency
// ═══════════════════════════════════════════════════════════════
describe("ensureNativeAsset idempotency", () => {
  test("concurrent calls produce exactly one native asset row", async () => {
    // Run many concurrent upserts — the unique constraint + upsert logic must
    // ensure only a single row exists afterwards.
    await Promise.all(
      Array.from({ length: 20 }, () => ensureNativeAsset())
    );

    const count = await prisma.asset.count({ where: { type: "NATIVE" } });
    expect(count).toBe(1);
  });
});
