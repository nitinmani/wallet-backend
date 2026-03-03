/**
 * Balance-service integration tests.
 *
 * RPC block-scanning is mocked via jest.spyOn on provider.send so the suite
 * runs without a live Ethereum node / Anvil instance.
 */
import request from "supertest";
import { ethers } from "ethers";
import { prisma } from "../../src/lib/prisma";
import { detectDeposits } from "../../src/services/depositDetector";
import * as providerLib from "../../src/lib/provider";
import {
  ensureNativeAsset,
  getWalletAssetBalance,
  setWalletAssetBalance,
} from "../../src/services/assetService";

jest.setTimeout(60_000);

let app: any;
let testApiKey: string;
let testTokenAddress: string;
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

async function setWalletLastSyncBlock(walletId: string, lastSyncBlock: number) {
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId },
    include: { walletGroup: true },
  });
  if (!wallet) throw new Error(`Wallet not found: ${walletId}`);
  await prisma.walletGroup.update({
    where: { id: wallet.walletGroupId },
    data: { lastSyncBlock },
  });
}

async function setNativeBalance(walletId: string, balance: bigint) {
  const nativeAsset = await ensureNativeAsset();
  await setWalletAssetBalance(walletId, nativeAsset.id, balance);
}

async function getNativeBalance(walletId: string): Promise<bigint> {
  const nativeAsset = await ensureNativeAsset();
  return getWalletAssetBalance(walletId, nativeAsset.id);
}

/**
 * Spy on provider.send to simulate a block containing `txEntries` at
 * `targetBlock`.  Restores itself automatically when `restore()` is called.
 */
function mockBlockScan(
  targetBlock: number,
  txEntries: Array<{
    hash: string;
    to: string;
    from?: string;
    value?: bigint;
    input?: string;
  }>
) {
  const originalSend = providerLib.provider.send.bind(providerLib.provider);
  const sendSpy = jest
    .spyOn(providerLib.provider, "send")
    .mockImplementation(async (method: string, params: any[] | Record<string, any>) => {
      if (method === "eth_blockNumber") return ethers.toQuantity(targetBlock);
      if (method === "eth_getBlockByNumber") {
        if (!Array.isArray(params)) return { transactions: [] };
        const blockNo = Number(BigInt(params[0]));
        if (blockNo === targetBlock) {
          return {
            transactions: txEntries.map((e) => ({
              hash: e.hash,
              to: e.to,
              from: e.from ?? "0x0000000000000000000000000000000000000001",
              value: ethers.toQuantity(e.value ?? 0n),
              input: e.input ?? "0x",
            })),
          };
        }
        return { transactions: [] };
      }
      return originalSend(method, params);
    });

  const balanceSpy = jest
    .spyOn(providerLib.provider, "getBalance")
    .mockResolvedValue(ethers.parseEther("1"));

  return {
    restore() {
      sendSpy.mockRestore();
      balanceSpy.mockRestore();
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

  // Use a deterministic fake token address — no chain deployment needed
  testTokenAddress = ethers.Wallet.createRandom().address;
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

// ═══════════════════════════════════════════════════════════════
// DEPOSIT DETECTION
// ═══════════════════════════════════════════════════════════════
describe("depositDetection", () => {
  test("native ETH deposit to wallet address creates a DEPOSIT transaction within 10 minutes", async () => {
    const wallet = await createTestWallet("Deposit Detection Wallet");

    const targetBlock = 10_000;
    const depositTxHash = ethers.hexlify(ethers.randomBytes(32));
    const depositAmount = ethers.parseEther("0.25");
    await setWalletLastSyncBlock(wallet.id, targetBlock - 1);

    const blockMock = mockBlockScan(targetBlock, [
      { hash: depositTxHash, to: wallet.address, value: depositAmount },
    ]);

    try {
      await detectDeposits();
    } finally {
      blockMock.restore();
    }

    const transactions = await prisma.transaction.findMany({
      where: { walletId: wallet.id, type: "DEPOSIT" },
    });

    expect(transactions.length).toBeGreaterThanOrEqual(1);
    const deposit = transactions.find((t) => t.txHash === depositTxHash);
    expect(deposit).toBeDefined();
    expect(deposit!.status).toBe("CONFIRMED");
    expect(deposit!.amount).toBe(depositAmount.toString());

    const timeDiff = Date.now() - deposit!.createdAt.getTime();
    expect(timeDiff).toBeLessThan(10 * 60 * 1000);
  });

  test("ERC-20 deposit to wallet address creates a token DEPOSIT transaction", async () => {
    const wallet = await createTestWallet("Token Deposit Detection Wallet");
    const targetBlock = 10_100;
    const tokenDepositTxHash = ethers.hexlify(ethers.randomBytes(32));
    const tokenDepositAmount = ethers.parseUnits("25", 18);
    const transferInput = new ethers.Interface([
      "function transfer(address to, uint256 amount)",
    ]).encodeFunctionData("transfer", [wallet.address, tokenDepositAmount]);
    await setWalletLastSyncBlock(wallet.id, targetBlock - 1);

    const blockMock = mockBlockScan(targetBlock, [
      { hash: tokenDepositTxHash, to: testTokenAddress, value: 0n, input: transferInput },
    ]);

    try {
      await detectDeposits();
    } finally {
      blockMock.restore();
    }

    const tokenDeposit = await prisma.transaction.findFirst({
      where: {
        walletId: wallet.id,
        type: "DEPOSIT",
        assetType: "ERC20",
        txHash: tokenDepositTxHash,
      },
    });

    expect(tokenDeposit).not.toBeNull();
    expect(tokenDeposit!.tokenAddress!.toLowerCase()).toBe(testTokenAddress.toLowerCase());
    expect(tokenDeposit!.tokenDecimals).toBe(18);
    expect(tokenDeposit!.amount).toBe(tokenDepositAmount.toString());
  });

  test("deposits to unmonitored addresses are ignored", async () => {
    const wallet = await createTestWallet("Ignored Wallet");
    const targetBlock = 10_200;
    await setWalletLastSyncBlock(wallet.id, targetBlock - 1);

    const blockMock = mockBlockScan(targetBlock, [
      {
        hash: ethers.hexlify(ethers.randomBytes(32)),
        to: ethers.Wallet.createRandom().address,
        value: ethers.parseEther("1"),
      },
    ]);

    try {
      await detectDeposits();
    } finally {
      blockMock.restore();
    }

    const txs = await prisma.transaction.findMany({
      where: { walletId: wallet.id, type: "DEPOSIT" },
    });
    expect(txs.length).toBe(0);
  });

  test("same deposit tx hash is not recorded twice (idempotent scan)", async () => {
    const wallet = await createTestWallet("Idempotent Deposit Wallet");
    const targetBlock = 10_300;
    const depositTxHash = ethers.hexlify(ethers.randomBytes(32));
    await setWalletLastSyncBlock(wallet.id, targetBlock - 1);

    const blockMock = mockBlockScan(targetBlock, [
      { hash: depositTxHash, to: wallet.address, value: ethers.parseEther("0.1") },
    ]);

    try {
      await detectDeposits();
      await setWalletLastSyncBlock(wallet.id, targetBlock - 1);
      await detectDeposits();
    } finally {
      blockMock.restore();
    }

    const deposits = await prisma.transaction.findMany({
      where: { walletId: wallet.id, type: "DEPOSIT", txHash: depositTxHash },
    });
    expect(deposits.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// BALANCE ROUTES
// ═══════════════════════════════════════════════════════════════
describe("balanceRoutes", () => {
  test("returns on-chain balance for a random (non-wallet) address", async () => {
    const randomAddr = ethers.Wallet.createRandom().address;
    const balanceSpy = jest
      .spyOn(providerLib.provider, "getBalance")
      .mockResolvedValue(ethers.parseEther("3.7"));

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

  test("returns DB-backed balance for a wallet queried by ID", async () => {
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
