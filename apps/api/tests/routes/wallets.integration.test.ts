/**
 * Wallet integration tests.
 *
 * All RPC calls are mocked via jest.spyOn so the suite runs against a real
 * database but does NOT require a live Ethereum node / Anvil instance.
 */
import request from "supertest";
import { ethers } from "ethers";
import { prisma } from "../../src/lib/prisma";
import { decrypt, EncryptedData } from "../../src/lib/keyvault";
import { detectDeposits } from "../../src/services/depositDetector";
import { reconcileBroadcastingTransactions } from "../../src/services/transactionService";
import * as providerLib from "../../src/lib/provider";
import {
  ensureNativeAsset,
  getWalletAssetBalance,
  setWalletAssetBalance,
} from "../../src/services/assetService";

jest.setTimeout(60_000);

let app: any;
let testApiKey: string;
let testUserId: string;
let baselineNetworkSpy: jest.SpyInstance;
let baselineBlockSpy: jest.SpyInstance;
let baselineBalanceSpy: jest.SpyInstance;
let baselineEstimateGasSpy: jest.SpyInstance;
let baselineFeeDataSpy: jest.SpyInstance;

// ─── Provider mock helpers ──────────────────────────────────────
/**
 * Spy on all provider calls needed for ETH/ERC-20 send flows and for the
 * reconciliation loop.  Returns a restore function that MUST be called in
 * afterEach / finally.
 */
function mockProviderForSend(overrides: {
  balanceWei?: bigint;
  txHash?: string;
  receiptStatus?: number;
} = {}) {
  const fakeTxHash = overrides.txHash ?? ethers.hexlify(ethers.randomBytes(32));
  const balance = overrides.balanceWei ?? ethers.parseEther("100");
  const receiptStatus = overrides.receiptStatus ?? 1;

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
    jest.spyOn(providerLib.provider, "getTransactionCount").mockResolvedValue(0),
    // Each broadcast gets a unique hash so concurrent sends don't collide on the
    // @@unique([walletId, txHash, assetType]) DB constraint.
    jest.spyOn(providerLib, "broadcastSignedTransaction").mockImplementation(
      async () => ethers.hexlify(ethers.randomBytes(32))
    ),
    jest.spyOn(providerLib.provider, "getTransactionReceipt").mockResolvedValue({
      status: receiptStatus,
      gasUsed: 21_000n,
      gasPrice: 1_000_000_000n,
      logs: [],
    } as any),
    // reconcileBroadcastingRecord also reads getTransaction for gasPrice/value fallback
    jest.spyOn(providerLib.provider, "getTransaction").mockResolvedValue(null as any),
  ];

  return {
    fakeTxHash,
    restore() {
      spies.forEach((s) => s.mockRestore());
    },
  };
}

/**
 * Spy on provider.send to simulate block scanning for deposit detection.
 * The returned spy reports `targetBlock` as the head, and places `txEntries`
 * inside that block.
 */
function mockProviderForDepositScan(
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

  await prisma.transaction.deleteMany();
  await prisma.walletAccess.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.walletGroup.deleteMany();
  await prisma.user.deleteMany();

  const res = await request(app)
    .post("/api/users")
    .send({ email: "test@vencura.dev" });
  testApiKey = res.body.apiKey;
  testUserId = res.body.id;
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

async function createUser(email: string) {
  const res = await request(app).post("/api/users").send({ email });
  return res.body;
}

async function createWalletInGroup(apiKey: string, sourceWalletId: string, name?: string) {
  return request(app)
    .post(`/api/wallets/${sourceWalletId}/group-wallet`)
    .set("x-api-key", apiKey)
    .send({ name });
}

async function getWalletWithGroup(walletId: string) {
  return prisma.wallet.findUnique({
    where: { id: walletId },
    include: { walletGroup: true },
  });
}

async function getWalletPrivateKey(walletId: string) {
  const wallet = await getWalletWithGroup(walletId);
  if (!wallet) throw new Error(`Wallet not found: ${walletId}`);
  if (!wallet.walletGroup.encryptedKey) {
    throw new Error(`Wallet group missing encrypted key: ${wallet.walletGroupId}`);
  }
  return decrypt(wallet.walletGroup.encryptedKey);
}

async function setWalletLastSyncBlock(walletId: string, lastSyncBlock: number) {
  const wallet = await getWalletWithGroup(walletId);
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

async function settleBroadcastingTxs(iterations = 12) {
  for (let i = 0; i < iterations; i++) {
    await reconcileBroadcastingTransactions(500);
    const pending = await prisma.transaction.count({
      where: { status: "BROADCASTING" },
    });
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ═══════════════════════════════════════════════════════════════
// 1. CREATE WALLET
// ═══════════════════════════════════════════════════════════════
describe("createWallet", () => {
  test("creates a wallet entry in the DB belonging to the user", async () => {
    const res = await request(app)
      .post("/api/wallets")
      .set("x-api-key", testApiKey)
      .send({ name: "My First Wallet" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(res.body.ownerId).toBe(testUserId);
    expect(res.body.name).toBe("My First Wallet");
    expect(JSON.stringify(res.body)).not.toMatch(/encryptedKey|privateKey|mnemonic|seed/i);

    const dbWallet = await prisma.wallet.findUnique({ where: { id: res.body.id } });
    expect(dbWallet).not.toBeNull();
    expect(dbWallet!.ownerId).toBe(testUserId);
  });

  test("private key is encrypted in storage (not stored as plaintext)", async () => {
    const res = await request(app)
      .post("/api/wallets")
      .set("x-api-key", testApiKey)
      .send({ name: "Encryption Test Wallet" });

    const dbWallet = await prisma.wallet.findUnique({
      where: { id: res.body.id },
      include: { walletGroup: true },
    });
    expect(dbWallet).not.toBeNull();
    const encryptedKey = dbWallet!.walletGroup.encryptedKey;
    expect(encryptedKey).toBeDefined();
    if (!encryptedKey) throw new Error("Expected encrypted key");

    const parsed: EncryptedData = JSON.parse(encryptedKey);
    expect(parsed.ciphertext).toBeDefined();
    expect(parsed.iv).toBeDefined();
    expect(parsed.tag).toBeDefined();
    expect(encryptedKey.startsWith("0x")).toBe(false);

    const privateKey = decrypt(encryptedKey);
    expect(privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    const reconstructed = new ethers.Wallet(privateKey);
    expect(reconstructed.address).toBe(res.body.address);
    expect(JSON.stringify(res.body)).not.toMatch(/encryptedKey|privateKey|mnemonic|seed/i);
  });

  test("GET /api/wallets returns the user's wallets", async () => {
    const res = await request(app).get("/api/wallets").set("x-api-key", testApiKey);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body.every((w: any) => !("encryptedKey" in (w.walletGroup ?? {})))).toBe(true);
  });

  test("GET /api/wallets/:walletId returns a specific wallet", async () => {
    const created = await createTestWallet("Single Wallet");
    const res = await request(app)
      .get(`/api/wallets/${created.id}`)
      .set("x-api-key", testApiKey);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(JSON.stringify(res.body)).not.toMatch(/encryptedKey|privateKey/i);
  });

  test("GET /api/wallets/:walletId returns 404 for unknown wallet", async () => {
    const res = await request(app)
      .get("/api/wallets/nonexistent-wallet-id")
      .set("x-api-key", testApiKey);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. SIGN MESSAGE
// ═══════════════════════════════════════════════════════════════
describe("signMessage", () => {
  test("signs a message with the wallet's private key (ECDSA) and signature is verifiable", async () => {
    const wallet = await createTestWallet("Signing Wallet");
    const message = "Hello, Vencura!";

    const res = await request(app)
      .post(`/api/wallets/${wallet.id}/sign`)
      .set("x-api-key", testApiKey)
      .send({ message });

    expect(res.status).toBe(200);
    expect(res.body.signature).toBeDefined();
    expect(res.body.message).toBe(message);
    expect(res.body.address).toBe(wallet.address);

    const recoveredAddress = ethers.verifyMessage(message, res.body.signature);
    expect(recoveredAddress).toBe(wallet.address);
  });

  test("signed value matches expected output for a known message", async () => {
    const wallet = await createTestWallet("Deterministic Sign Wallet");
    const privateKey = await getWalletPrivateKey(wallet.id);
    const localSigner = new ethers.Wallet(privateKey);
    const message = "deterministic test message 12345";
    const expectedSig = await localSigner.signMessage(message);

    const res = await request(app)
      .post(`/api/wallets/${wallet.id}/sign`)
      .set("x-api-key", testApiKey)
      .send({ message });

    expect(res.status).toBe(200);
    expect(res.body.signature).toBe(expectedSig);
  });

  test("different messages produce different signatures", async () => {
    const wallet = await createTestWallet("Multi Sign Wallet");

    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/api/wallets/${wallet.id}/sign`)
        .set("x-api-key", testApiKey)
        .send({ message: "message A" }),
      request(app)
        .post(`/api/wallets/${wallet.id}/sign`)
        .set("x-api-key", testApiKey)
        .send({ message: "message B" }),
    ]);

    expect(res1.body.signature).not.toBe(res2.body.signature);
  });

  test("returns 400 when message is missing", async () => {
    const wallet = await createTestWallet("Empty Sign Wallet");
    const res = await request(app)
      .post(`/api/wallets/${wallet.id}/sign`)
      .set("x-api-key", testApiKey)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Message is required");
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. WALLET GROUPS
// ═══════════════════════════════════════════════════════════════
describe("walletGroups", () => {
  test("internal transfer between wallets that share a private key stays off-chain and records withdrawal+deposit with zero gas", async () => {
    const source = await createTestWallet("Group Source");
    await setNativeBalance(source.id, ethers.parseEther("3"));

    const groupedRes = await createWalletInGroup(testApiKey, source.id, "Group Destination");
    expect(groupedRes.status).toBe(201);
    const destination = groupedRes.body;

    const transferRes = await request(app)
      .post(`/api/wallets/${source.id}/transfer`)
      .set("x-api-key", testApiKey)
      .send({ toWalletId: destination.id, amount: "1" });

    expect(transferRes.status).toBe(200);

    const [debit, credit] = await Promise.all([
      prisma.transaction.findUnique({ where: { id: transferRes.body.debitTxId } }),
      prisma.transaction.findUnique({ where: { id: transferRes.body.creditTxId } }),
    ]);

    expect(debit).not.toBeNull();
    expect(credit).not.toBeNull();
    expect(debit!.type).toBe("WITHDRAWAL");
    expect(credit!.type).toBe("DEPOSIT");
    expect(debit!.gasPrice).toBe("0");
    expect(credit!.gasPrice).toBe("0");
    expect(debit!.txHash).toBeNull();
    expect(credit!.txHash).toBeNull();

    expect(await getNativeBalance(source.id)).toBe(ethers.parseEther("2"));
    expect(await getNativeBalance(destination.id)).toBe(ethers.parseEther("1"));
  });

  test("grouped wallet internal transfer cannot exceed source wallet balance", async () => {
    const source = await createTestWallet("Low Group Source");
    await setNativeBalance(source.id, ethers.parseEther("0.25"));

    const groupedRes = await createWalletInGroup(testApiKey, source.id, "Low Group Dest");
    expect(groupedRes.status).toBe(201);

    const transferRes = await request(app)
      .post(`/api/wallets/${source.id}/transfer`)
      .set("x-api-key", testApiKey)
      .send({ toWalletId: groupedRes.body.id, amount: "0.3" });

    expect(transferRes.status).toBe(400);
    expect(transferRes.body.error).toMatch(/Insufficient balance/i);
  });

  test("grouped wallet external withdrawal cannot exceed the wallet's own balance", async () => {
    const groupedSource = await createTestWallet("Grouped External Source");
    await setNativeBalance(groupedSource.id, ethers.parseEther("0.05"));

    const groupedRes = await createWalletInGroup(
      testApiKey,
      groupedSource.id,
      "Grouped External Dest"
    );
    expect(groupedRes.status).toBe(201);

    // The send is expected to fail the balance check before hitting the provider.
    const sendRes = await request(app)
      .post(`/api/wallets/${groupedSource.id}/send`)
      .set("x-api-key", testApiKey)
      .send({ to: ethers.Wallet.createRandom().address, amount: "0.05" });

    expect(sendRes.status).toBe(400);
    expect(sendRes.body.error).toMatch(/Insufficient balance/i);
  });

  test("wallet-group advisory lock serialises concurrent sends and assigns sequential nonces", async () => {
    const walletA = await createTestWallet("Group Lock A");
    await setNativeBalance(walletA.id, ethers.parseEther("2"));

    const walletBRes = await createWalletInGroup(testApiKey, walletA.id, "Group Lock B");
    expect(walletBRes.status).toBe(201);
    const walletB = walletBRes.body;
    await setNativeBalance(walletB.id, ethers.parseEther("2"));

    const recipientA = ethers.Wallet.createRandom().address;
    const recipientB = ethers.Wallet.createRandom().address;

    const mocks = mockProviderForSend();
    try {
      const [sendA, sendB] = await Promise.all([
        request(app)
          .post(`/api/wallets/${walletA.id}/send`)
          .set("x-api-key", testApiKey)
          .send({ to: recipientA, amount: "0.1" }),
        request(app)
          .post(`/api/wallets/${walletB.id}/send`)
          .set("x-api-key", testApiKey)
          .send({ to: recipientB, amount: "0.1" }),
      ]);

      // Advisory lock serialises them — both should succeed
      expect(sendA.status).toBe(200);
      expect(sendB.status).toBe(200);

      await settleBroadcastingTxs();

      // Same signing key → both transactions must have been created with sequential nonces
      const confirmed = await prisma.transaction.findMany({
        where: {
          walletId: { in: [walletA.id, walletB.id] },
          status: "CONFIRMED",
          type: "WITHDRAWAL",
        },
        orderBy: { nonce: "asc" },
      });
      expect(confirmed.length).toBe(2);
      expect(confirmed[1].nonce).toBe((confirmed[0].nonce ?? -1) + 1);
    } finally {
      mocks.restore();
    }
  });

  test("cron-style deposit detector picks grouped-wallet deposits and credits the primary wallet", async () => {
    const source = await createTestWallet("Grouped Deposit Source");
    const groupedRes = await createWalletInGroup(testApiKey, source.id, "Grouped Deposit Member");
    expect(groupedRes.status).toBe(201);

    const groupId = groupedRes.body.walletGroupId as string;
    const depositTxHash = ethers.hexlify(ethers.randomBytes(32));
    const targetBlock = 50_000;
    await setWalletLastSyncBlock(source.id, targetBlock - 1);

    const scanMock = mockProviderForDepositScan(targetBlock, [
      {
        hash: depositTxHash,
        to: source.address,
        value: ethers.parseEther("0.12"),
      },
    ]);

    try {
      await detectDeposits();
    } finally {
      scanMock.restore();
    }

    const groupWallets = await prisma.wallet.findMany({
      where: { walletGroupId: groupId },
      orderBy: { createdAt: "asc" },
    });
    expect(groupWallets.length).toBeGreaterThanOrEqual(1);
    const primaryWallet = groupWallets[0];

    const deposit = await prisma.transaction.findFirst({
      where: { walletId: primaryWallet.id, type: "DEPOSIT", txHash: depositTxHash },
    });

    expect(deposit).not.toBeNull();
    expect(deposit!.status).toBe("CONFIRMED");
    expect(await getNativeBalance(primaryWallet.id)).toBeGreaterThanOrEqual(
      ethers.parseEther("0.12")
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. WALLET SHARING
// ═══════════════════════════════════════════════════════════════
describe("walletSharing", () => {
  test("an existing user can be granted access to an existing wallet", async () => {
    const invited = await createUser("shared-access@vencura.dev");
    const wallet = await createTestWallet("Shared Access Wallet");

    const shareRes = await request(app)
      .post(`/api/wallets/${wallet.id}/share`)
      .set("x-api-key", testApiKey)
      .send({ email: invited.email });

    expect(shareRes.status).toBe(200);
    expect(shareRes.body.sharedWithEmail).toBe(invited.email);

    const invitedWalletRes = await request(app)
      .get(`/api/wallets/${wallet.id}`)
      .set("x-api-key", invited.apiKey);

    expect(invitedWalletRes.status).toBe(200);
    expect(invitedWalletRes.body.id).toBe(wallet.id);
  });

  test("shared users can send concurrently; advisory lock ensures sequential nonces", async () => {
    const user2 = await createUser("shared-lock@vencura.dev");
    const sharedWallet = await createTestWallet("Concurrent Shared Wallet");
    await setNativeBalance(sharedWallet.id, ethers.parseEther("2"));

    const shareRes = await request(app)
      .post(`/api/wallets/${sharedWallet.id}/share`)
      .set("x-api-key", testApiKey)
      .send({ email: user2.email });
    expect(shareRes.status).toBe(200);

    const mocks = mockProviderForSend();
    try {
      const [user1Send, user2Send] = await Promise.all([
        request(app)
          .post(`/api/wallets/${sharedWallet.id}/send`)
          .set("x-api-key", testApiKey)
          .send({ to: ethers.Wallet.createRandom().address, amount: "0.1" }),
        request(app)
          .post(`/api/wallets/${sharedWallet.id}/send`)
          .set("x-api-key", user2.apiKey)
          .send({ to: ethers.Wallet.createRandom().address, amount: "0.1" }),
      ]);

      // Advisory lock serialises them — both should succeed
      expect(user1Send.status).toBe(200);
      expect(user2Send.status).toBe(200);

      // Nonces must be sequential (lock prevents duplicate nonces on same wallet)
      const nonces = [user1Send.body.nonce, user2Send.body.nonce].sort((a, b) => a - b);
      expect(nonces[1]).toBe(nonces[0] + 1);

      // Signing still works after concurrent sends
      const signRes = await request(app)
        .post(`/api/wallets/${sharedWallet.id}/sign`)
        .set("x-api-key", user2.apiKey)
        .send({ message: "shared wallet concurrent check" });
      expect(signRes.status).toBe(200);
    } finally {
      mocks.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. MANUAL WALLET-GROUP SYNC
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
describe("walletMetadataUpdates", () => {
  test("can update wallet name", async () => {
    const wallet = await createTestWallet("Original Name");
    const res = await request(app)
      .patch(`/api/wallets/${wallet.id}`)
      .set("x-api-key", testApiKey)
      .send({ name: "Updated Name" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Name");
  });

  test("returns 400 when name is not a string", async () => {
    const wallet = await createTestWallet("Name Type Check");
    const res = await request(app)
      .patch(`/api/wallets/${wallet.id}`)
      .set("x-api-key", testApiKey)
      .send({ name: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("name is required");
  });

  test("can update wallet group name", async () => {
    const wallet = await createTestWallet("Wallet For Group Name");
    const groupedRes = await createWalletInGroup(testApiKey, wallet.id, "Grouped Member");
    expect(groupedRes.status).toBe(201);

    const groupId = groupedRes.body.walletGroupId;

    const res = await request(app)
      .patch(`/api/wallet-groups/${groupId}`)
      .set("x-api-key", testApiKey)
      .send({ name: "Treasury Group" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Treasury Group");

    const dbGroup = await prisma.walletGroup.findUnique({ where: { id: groupId } });
    expect(dbGroup!.name).toBe("Treasury Group");
  });

  test("cannot update wallet group name without access", async () => {
    const wallet = await createTestWallet("Private Group Wallet");
    const groupedRes = await createWalletInGroup(testApiKey, wallet.id, "Private Group Member");
    expect(groupedRes.status).toBe(201);

    const outsider = await createUser("wallet-group-outsider@vencura.dev");

    const res = await request(app)
      .patch(`/api/wallet-groups/${groupedRes.body.walletGroupId}`)
      .set("x-api-key", outsider.apiKey)
      .send({ name: "Should Not Work" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. WALLET GROUPS API
// ═══════════════════════════════════════════════════════════════
describe("walletGroupsApi", () => {
  test("cannot create a wallet in a group with a duplicate name", async () => {
    const sourceWallet = await createTestWallet("Team Wallet");

    const duplicateRes = await createWalletInGroup(testApiKey, sourceWallet.id, "Team Wallet");
    expect(duplicateRes.status).toBe(400);
    expect(duplicateRes.body.error).toMatch(/already exists in this wallet group/i);
  });

  test("can add wallets to an existing wallet group", async () => {
    const sourceWallet = await createTestWallet("Dashboard Group Primary Wallet");
    const groupId = sourceWallet.walletGroupId;

    const addWalletRes = await request(app)
      .post(`/api/wallet-groups/${groupId}/wallets`)
      .set("x-api-key", testApiKey)
      .send({ name: "Group Wallet A" });

    expect(addWalletRes.status).toBe(201);
    expect(addWalletRes.body.walletGroupId).toBe(groupId);

    const groupDetailRes = await request(app)
      .get(`/api/wallet-groups/${groupId}`)
      .set("x-api-key", testApiKey);

    expect(groupDetailRes.status).toBe(200);
    expect(JSON.stringify(groupDetailRes.body)).not.toMatch(
      /encryptedKey|privateKey|mnemonic|seed/i
    );
    expect(groupDetailRes.body.wallets.length).toBeGreaterThanOrEqual(1);
    expect(
      groupDetailRes.body.wallets.some((w: any) => w.id === addWalletRes.body.id)
    ).toBe(true);
  });
});
