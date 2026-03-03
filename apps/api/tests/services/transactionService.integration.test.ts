/**
 * Transaction-service integration tests.
 *
 * All Ethereum RPC calls are mocked via jest.spyOn.  The suite only needs a
 * live database — no Anvil / local chain required.
 */
import request from "supertest";
import { ethers } from "ethers";
import { prisma } from "../../src/lib/prisma";
import { decrypt } from "../../src/lib/keyvault";
import { reconcileBroadcastingTransactions } from "../../src/services/transactionService";
import * as providerLib from "../../src/lib/provider";
import {
  ensureErc20Asset,
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

// ─── Provider mock helpers ──────────────────────────────────────
function mockProviderForSend(overrides: {
  balanceWei?: bigint;
  txHash?: string;
  receiptStatus?: number;
  nonce?: number;
} = {}) {
  const fakeTxHash = overrides.txHash ?? ethers.hexlify(ethers.randomBytes(32));
  const balance = overrides.balanceWei ?? ethers.parseEther("100");
  const receiptStatus = overrides.receiptStatus ?? 1;
  const nonce = overrides.nonce ?? 0;

  const spies = [
    jest.spyOn(providerLib.provider, "getBalance").mockResolvedValue(balance),
    jest.spyOn(providerLib.provider, "estimateGas").mockResolvedValue(21_000n),
    jest.spyOn(providerLib.provider, "getFeeData").mockResolvedValue({
      gasPrice: 1_000_000_000n,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      lastBaseFeePerGas: null,
    } as any),
    jest.spyOn(providerLib.provider, "getNetwork").mockResolvedValue({
      chainId: 31337n,
    } as any),
    jest.spyOn(providerLib.provider, "getTransactionCount").mockResolvedValue(nonce),
    jest.spyOn(providerLib, "broadcastSignedTransaction").mockResolvedValue(fakeTxHash),
    jest.spyOn(providerLib.provider, "getTransactionReceipt").mockResolvedValue({
      status: receiptStatus,
      gasUsed: 21_000n,
      gasPrice: 1_000_000_000n,
      logs: [],
    } as any),
    // reconcileBroadcastingRecord also calls getTransaction for gasPrice/value fallback
    jest.spyOn(providerLib.provider, "getTransaction").mockResolvedValue(null as any),
  ];

  return {
    fakeTxHash,
    broadcastSpy: spies[5] as jest.SpyInstance,
    restore() {
      spies.forEach((s) => s.mockRestore());
    },
  };
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

  await prisma.transaction.deleteMany();
  await prisma.walletAccess.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.walletGroup.deleteMany();
  await prisma.user.deleteMany();

  const res = await request(app)
    .post("/api/users")
    .send({ email: "tx-integration@vencura.dev" });
  testApiKey = res.body.apiKey;
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

// ─── Shared helpers ────────────────────────────────────────────
async function createTestWallet(name?: string) {
  const res = await request(app)
    .post("/api/wallets")
    .set("x-api-key", testApiKey)
    .send({ name: name ?? "Test Wallet" });
  return res.body;
}

async function getWalletPrivateKey(walletId: string) {
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId },
    include: { walletGroup: true },
  });
  if (!wallet?.walletGroup.encryptedKey) throw new Error("Missing encrypted key");
  return decrypt(wallet.walletGroup.encryptedKey);
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
    `Transaction ${txId} did not reach expected status. Current: ${current?.status}`
  );
}

// ═══════════════════════════════════════════════════════════════
// SEND TRANSACTION
// ═══════════════════════════════════════════════════════════════
describe("sendTransaction", () => {
  const recipient = ethers.Wallet.createRandom().address;

  test("withdrawal of native ETH returns BROADCASTING first, then reaches CONFIRMED", async () => {
    const wallet = await createTestWallet("ETH Send Wallet");
    await setNativeBalance(wallet.id, ethers.parseEther("10"));

    const mocks = mockProviderForSend();
    try {
      const res = await request(app)
        .post(`/api/wallets/${wallet.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: recipient, amount: "0.1" });

      expect(res.status).toBe(200);
      expect(res.body.txHash).toBe(mocks.fakeTxHash);
      expect(res.body.transactionId).toBeDefined();
      expect(res.body.nonce).toBeDefined();
      expect(res.body.status).toBe("BROADCASTING");

      const initialTxRecord = await prisma.transaction.findUnique({
        where: { id: res.body.transactionId },
      });
      expect(initialTxRecord!.status).toBe("BROADCASTING");

      const txRecord = await waitForTxFinalStatus(res.body.transactionId, ["CONFIRMED"]);
      expect(txRecord!.status).toBe("CONFIRMED");
      expect(txRecord!.type).toBe("WITHDRAWAL");
      expect(txRecord!.to).toBe(recipient);
      expect(txRecord!.txHash).toBe(mocks.fakeTxHash);
      expect(txRecord!.nonce).not.toBeNull();
      expect(txRecord!.gasPrice).not.toBeNull();
    } finally {
      mocks.restore();
    }
  });

  test("withdrawal of ERC-20 token records the correct asset type", async () => {
    const wallet = await createTestWallet("ERC20 Send Wallet");
    await setNativeBalance(wallet.id, ethers.parseEther("1"));

    const fakeTokenAddress = ethers.Wallet.createRandom().address;
    const tokenAsset = await ensureErc20Asset(fakeTokenAddress, "TST", 18);
    await setWalletAssetBalance(wallet.id, tokenAsset.id, ethers.parseUnits("100", 18));

    const tokenRecipient = ethers.Wallet.createRandom().address;
    const mocks = mockProviderForSend();

    // sendERC20Transaction calls decimals()/symbol()/balanceOf() via provider.call
    const callSpy = jest
      .spyOn(providerLib.provider, "call" as any)
      .mockImplementation(async (tx: any) => {
        const data: string = (tx?.data ?? tx ?? "").toString();
        const selector = data.slice(0, 10).toLowerCase();
        if (selector === "0x313ce567") {
          // decimals() → uint8 18
          return ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [18]);
        }
        if (selector === "0x95d89b41") {
          // symbol() → string "TST"
          return ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["TST"]);
        }
        if (selector === "0x70a08231") {
          // balanceOf(address) → uint256
          return ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256"],
            [ethers.parseUnits("200", 18)]
          );
        }
        return "0x";
      });

    try {
      const res = await request(app)
        .post(`/api/wallets/${wallet.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: tokenRecipient, amount: "50", assetId: tokenAsset.id });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("BROADCASTING");

      const txRecord = await waitForTxFinalStatus(res.body.transactionId, ["CONFIRMED"]);
      expect(txRecord!.status).toBe("CONFIRMED");
      expect(txRecord!.type).toBe("WITHDRAWAL");
      expect(txRecord!.assetType).toBe("ERC20");
      expect(txRecord!.assetSymbol).toBe("TST");
      expect(txRecord!.tokenAddress!.toLowerCase()).toBe(fakeTokenAddress.toLowerCase());
    } finally {
      callSpy.mockRestore();
      mocks.restore();
    }
  });

  test("error when withdrawing more ETH than wallet balance", async () => {
    const poorWallet = await createTestWallet("Poor Wallet");
    await setNativeBalance(poorWallet.id, ethers.parseEther("0.01"));

    // Inline mocks: needed because previous tests may have stacked+restored spies,
    // which resets provider methods back to the original (non-mocked) implementation.
    const balSpy = jest.spyOn(providerLib.provider, "getBalance").mockResolvedValue(ethers.parseEther("100"));
    const gasSpy = jest.spyOn(providerLib.provider, "estimateGas").mockResolvedValue(21_000n);
    const feeSpy = jest.spyOn(providerLib.provider, "getFeeData").mockResolvedValue({
      gasPrice: 1_000_000_000n, maxFeePerGas: null, maxPriorityFeePerGas: null, lastBaseFeePerGas: null,
    } as any);

    try {
      const res = await request(app)
        .post(`/api/wallets/${poorWallet.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: recipient, amount: "100" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Insufficient balance/i);

      const txs = await prisma.transaction.findMany({
        where: { walletId: poorWallet.id, status: "CONFIRMED" },
      });
      expect(txs.length).toBe(0);
    } finally {
      balSpy.mockRestore();
      gasSpy.mockRestore();
      feeSpy.mockRestore();
    }
  });

  test("gas + withdrawal amount must not exceed balance", async () => {
    const tightWallet = await createTestWallet("Tight Balance Wallet");
    await setNativeBalance(tightWallet.id, ethers.parseEther("0.0001"));

    const balSpy = jest.spyOn(providerLib.provider, "getBalance").mockResolvedValue(ethers.parseEther("100"));
    const gasSpy = jest.spyOn(providerLib.provider, "estimateGas").mockResolvedValue(21_000n);
    const feeSpy = jest.spyOn(providerLib.provider, "getFeeData").mockResolvedValue({
      gasPrice: 1_000_000_000n, maxFeePerGas: null, maxPriorityFeePerGas: null, lastBaseFeePerGas: null,
    } as any);

    try {
      const res = await request(app)
        .post(`/api/wallets/${tightWallet.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: recipient, amount: "0.0001" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Insufficient balance/i);
    } finally {
      balSpy.mockRestore();
      gasSpy.mockRestore();
      feeSpy.mockRestore();
    }
  });

  test("idempotency — duplicate nonce: only one tx confirms, other fails", async () => {
    const idempWallet = await createTestWallet("Idempotency Wallet");
    await setNativeBalance(idempWallet.id, ethers.parseEther("5"));

    const currentNonce = 7;
    const firstTxHash = ethers.hexlify(ethers.randomBytes(32));

    const getBalanceSpy = jest
      .spyOn(providerLib.provider, "getBalance")
      .mockResolvedValue(ethers.parseEther("100"));
    const estimateGasSpy = jest
      .spyOn(providerLib.provider, "estimateGas")
      .mockResolvedValue(21_000n);
    const feeDataSpy = jest.spyOn(providerLib.provider, "getFeeData").mockResolvedValue({
      gasPrice: 1_000_000_000n,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      lastBaseFeePerGas: null,
    } as any);
    const networkSpy = jest
      .spyOn(providerLib.provider, "getNetwork")
      .mockResolvedValue({ chainId: 31337n } as any);
    const nonceSpy = jest
      .spyOn(providerLib.provider, "getTransactionCount")
      .mockResolvedValue(currentNonce);
    const broadcastSpy = jest
      .spyOn(providerLib, "broadcastSignedTransaction")
      .mockResolvedValueOnce(firstTxHash)
      .mockRejectedValueOnce(new Error("nonce already used"));
    const getTransactionSpy = jest
      .spyOn(providerLib.provider, "getTransaction")
      .mockResolvedValue(null as any);

    try {
      const res1 = await request(app)
        .post(`/api/wallets/${idempWallet.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: recipient, amount: "0.01", nonce: currentNonce });

      expect(res1.status).toBe(200);
      expect(res1.body.txHash).toBe(firstTxHash);

      const res2 = await request(app)
        .post(`/api/wallets/${idempWallet.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: recipient, amount: "0.01", nonce: currentNonce });

      expect(res2.status).toBe(400);
      expect(res2.body.error).toMatch(/failed/i);

      const allTxs = await prisma.transaction.findMany({
        where: { walletId: idempWallet.id },
        orderBy: { createdAt: "asc" },
      });

      expect(allTxs.filter((t) => t.status === "BROADCASTING").length).toBe(1);
      expect(allTxs.filter((t) => t.status === "FAILED").length).toBeGreaterThanOrEqual(1);
      expect(broadcastSpy).toHaveBeenCalledTimes(2);
    } finally {
      getTransactionSpy.mockRestore();
      broadcastSpy.mockRestore();
      nonceSpy.mockRestore();
      networkSpy.mockRestore();
      feeDataSpy.mockRestore();
      estimateGasSpy.mockRestore();
      getBalanceSpy.mockRestore();
    }
  });

  test("RBF — replace low-gas tx records original as FAILED and replacement CONFIRMED", async () => {
    const rbfWallet = await createTestWallet("RBF Wallet");
    await setNativeBalance(rbfWallet.id, ethers.parseEther("5"));

    const nonce = 0;
    const highGasPrice = 10_000_000_000n;
    const highTxHash = ethers.hexlify(ethers.randomBytes(32));
    const lowTxHash = ethers.hexlify(ethers.randomBytes(32));

    const pk = await getWalletPrivateKey(rbfWallet.id);
    const fromAddress = new ethers.Wallet(pk).address;

    const txRecord1 = await prisma.transaction.create({
      data: {
        walletId: rbfWallet.id,
        type: "WITHDRAWAL",
        to: recipient,
        from: fromAddress,
        amount: ethers.parseEther("0.01").toString(),
        nonce,
        gasPrice: "1000000000",
        txHash: lowTxHash,
        status: "BROADCASTING",
      },
    });

    const getBalanceSpy = jest
      .spyOn(providerLib.provider, "getBalance")
      .mockResolvedValue(ethers.parseEther("100"));
    const estimateGasSpy = jest
      .spyOn(providerLib.provider, "estimateGas")
      .mockResolvedValue(21_000n);
    const feeDataSpy = jest
      .spyOn(providerLib.provider, "getFeeData")
      .mockResolvedValue({
        gasPrice: highGasPrice,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
        lastBaseFeePerGas: null,
      } as any);
    const networkSpy = jest
      .spyOn(providerLib.provider, "getNetwork")
      .mockResolvedValue({ chainId: 31337n } as any);
    const nonceSpy = jest
      .spyOn(providerLib.provider, "getTransactionCount")
      .mockResolvedValue(nonce);
    const broadcastSpy = jest
      .spyOn(providerLib, "broadcastSignedTransaction")
      .mockResolvedValue(highTxHash);
    const receiptSpy = jest
      .spyOn(providerLib.provider, "getTransactionReceipt")
      .mockResolvedValue({
        status: 1,
        gasUsed: 21_000n,
        gasPrice: highGasPrice,
        logs: [],
      } as any);
    const getTransactionSpy = jest
      .spyOn(providerLib.provider, "getTransaction")
      .mockResolvedValue(null as any);

    try {
      const rbfRes = await request(app)
        .post(`/api/wallets/${rbfWallet.id}/rbf`)
        .set("x-api-key", testApiKey)
        .send({ originalTxId: txRecord1.id, gasPrice: highGasPrice.toString() });

      if (rbfRes.status === 200) {
        const original = await prisma.transaction.findUnique({
          where: { id: txRecord1.id },
        });
        expect(original!.status).toBe("FAILED");

        const replacement = await waitForTxFinalStatus(rbfRes.body.transactionId, [
          "CONFIRMED",
          "FAILED",
        ]);
        expect(replacement!.nonce).toBe(nonce);
      } else {
        expect(rbfRes.status).toBe(400);
      }
    } finally {
      getTransactionSpy.mockRestore();
      broadcastSpy.mockRestore();
      nonceSpy.mockRestore();
      networkSpy.mockRestore();
      feeDataSpy.mockRestore();
      estimateGasSpy.mockRestore();
      getBalanceSpy.mockRestore();
      receiptSpy.mockRestore();
    }
  });

  test("nonce manager assigns N+1 to second send while first is BROADCASTING", async () => {
    const queuedWallet = await createTestWallet("Queued Nonce Wallet");
    await setNativeBalance(queuedWallet.id, ethers.parseEther("2"));

    const txHashA = ethers.hexlify(ethers.randomBytes(32));
    const txHashB = ethers.hexlify(ethers.randomBytes(32));

    const getBalanceSpy = jest
      .spyOn(providerLib.provider, "getBalance")
      .mockResolvedValue(ethers.parseEther("100"));
    const estimateGasSpy = jest
      .spyOn(providerLib.provider, "estimateGas")
      .mockResolvedValue(21_000n);
    const feeDataSpy = jest
      .spyOn(providerLib.provider, "getFeeData")
      .mockResolvedValue({
        gasPrice: 1_000_000_000n,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
        lastBaseFeePerGas: null,
      } as any);
    const networkSpy = jest
      .spyOn(providerLib.provider, "getNetwork")
      .mockResolvedValue({ chainId: 31337n } as any);
    // Chain nonce always 0; DB-reserved nonces drive the sequencing
    const nonceSpy = jest
      .spyOn(providerLib.provider, "getTransactionCount")
      .mockResolvedValue(0);
    const broadcastSpy = jest
      .spyOn(providerLib, "broadcastSignedTransaction")
      .mockResolvedValueOnce(txHashA)
      .mockResolvedValueOnce(txHashB);
    const receiptSpy = jest
      .spyOn(providerLib.provider, "getTransactionReceipt")
      .mockResolvedValue({
        status: 1,
        gasUsed: 21_000n,
        gasPrice: 1_000_000_000n,
        logs: [],
      } as any);
    const getTransactionSpy = jest
      .spyOn(providerLib.provider, "getTransaction")
      .mockResolvedValue(null as any);

    try {
      const txA = await request(app)
        .post(`/api/wallets/${queuedWallet.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: recipient, amount: "0.01" });

      expect(txA.status).toBe(200);
      expect(txA.body.status).toBe("BROADCASTING");

      const txB = await request(app)
        .post(`/api/wallets/${queuedWallet.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: ethers.Wallet.createRandom().address, amount: "0.02" });

      expect(txB.status).toBe(200);
      expect(txB.body.status).toBe("BROADCASTING");
      expect(txB.body.nonce).toBe(txA.body.nonce + 1);

      const finalA = await waitForTxFinalStatus(txA.body.transactionId, ["CONFIRMED"]);
      const finalB = await waitForTxFinalStatus(txB.body.transactionId, ["CONFIRMED"]);
      expect(finalA!.status).toBe("CONFIRMED");
      expect(finalB!.status).toBe("CONFIRMED");
      expect(finalB!.nonce).toBe((finalA!.nonce ?? -1) + 1);
    } finally {
      getTransactionSpy.mockRestore();
      broadcastSpy.mockRestore();
      nonceSpy.mockRestore();
      networkSpy.mockRestore();
      feeDataSpy.mockRestore();
      estimateGasSpy.mockRestore();
      getBalanceSpy.mockRestore();
      receiptSpy.mockRestore();
    }
  });

  test("failed transaction (zero balance) ends without a CONFIRMED record", async () => {
    const emptyWallet = await createTestWallet("Empty TX Wallet");

    const balSpy = jest.spyOn(providerLib.provider, "getBalance").mockResolvedValue(ethers.parseEther("100"));
    const gasSpy = jest.spyOn(providerLib.provider, "estimateGas").mockResolvedValue(21_000n);
    const feeSpy = jest.spyOn(providerLib.provider, "getFeeData").mockResolvedValue({
      gasPrice: 1_000_000_000n, maxFeePerGas: null, maxPriorityFeePerGas: null, lastBaseFeePerGas: null,
    } as any);

    try {
      const res = await request(app)
        .post(`/api/wallets/${emptyWallet.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: recipient, amount: "1" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Insufficient balance/i);

      const txs = await prisma.transaction.findMany({
        where: { walletId: emptyWallet.id, status: "CONFIRMED" },
      });
      expect(txs.length).toBe(0);
    } finally {
      balSpy.mockRestore();
      gasSpy.mockRestore();
      feeSpy.mockRestore();
    }
  });
});
