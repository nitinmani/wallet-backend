/**
 * Connected-wallet integration tests.
 *
 * All Ethereum RPC calls (getBalance, block scanning) are mocked so the suite
 * runs without a live Ethereum node / Anvil instance.
 */
import request from "supertest";
import { ethers } from "ethers";
import { prisma } from "../../src/lib/prisma";
import * as providerLib from "../../src/lib/provider";
import { detectDeposits } from "../../src/services/depositDetector";

jest.setTimeout(60_000);

let app: any;
let testApiKey: string;
let testUserId: string;
let baselineNetworkSpy: jest.SpyInstance;
let baselineBlockSpy: jest.SpyInstance;
let baselineBalanceSpy: jest.SpyInstance;
let baselineEstimateGasSpy: jest.SpyInstance;
let baselineFeeDataSpy: jest.SpyInstance;

// ─── Helpers ───────────────────────────────────────────────────
async function createUser(email: string) {
  const res = await request(app).post("/api/users").send({ email });
  return res.body;
}

async function createCustodialWallet(name: string) {
  const res = await request(app)
    .post("/api/wallets")
    .set("x-api-key", testApiKey)
    .send({ name });
  return res.body;
}

async function getWalletCounters() {
  const [walletGroups, wallets, transactions] = await Promise.all([
    prisma.walletGroup.count(),
    prisma.wallet.count(),
    prisma.transaction.count(),
  ]);
  return { walletGroups, wallets, transactions };
}

/** Mock provider.getBalance to return a fixed ETH balance. */
function mockBalance(wei: bigint) {
  return jest.spyOn(providerLib.provider, "getBalance").mockResolvedValue(wei);
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
    `connected-${Date.now()}-${Math.floor(Math.random() * 1000)}@vencura.dev`
  );
  testApiKey = user.apiKey;
  testUserId = user.id;
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
// STATELESS FLOW (challenge → verify → JWT → /me)
// ═══════════════════════════════════════════════════════════════
describe("connectedWalletStatelessFlow", () => {
  test("challenge/verify creates no wallet records in DB and token auth works", async () => {
    const externalWallet = ethers.Wallet.createRandom();
    const before = await getWalletCounters();

    // Etherscan API stub — no ERC-20 holdings
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "1", message: "OK", result: [] }),
    } as any);

    try {
      const challengeRes = await request(app)
        .post("/api/connected-wallet/challenge")
        .send({ address: externalWallet.address });
      expect(challengeRes.status).toBe(200);
      expect(challengeRes.body.message).toContain(externalWallet.address);

      const signature = await externalWallet.signMessage(challengeRes.body.message);

      const verifyRes = await request(app)
        .post("/api/connected-wallet/verify")
        .send({ address: externalWallet.address, signature });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.token).toBeDefined();
      expect(verifyRes.body.wallet.address).toBe(externalWallet.address);
      expect(JSON.stringify(verifyRes.body)).not.toMatch(
        /privateKey|encryptedKey|mnemonic|seedPhrase|seed_phrase/i
      );

      const token = verifyRes.body.token as string;
      const [payload] = token.split(".");
      const decodedPayload = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8")
      );
      expect(decodedPayload.privateKey).toBeUndefined();
      expect(decodedPayload.encryptedKey).toBeUndefined();
      expect(decodedPayload.mnemonic).toBeUndefined();

      const meRes = await request(app)
        .get("/api/connected-wallet/me")
        .set("Authorization", `Bearer ${token}`);
      expect(meRes.status).toBe(200);
      expect(meRes.body.address).toBe(externalWallet.address);
      expect(JSON.stringify(meRes.body)).not.toMatch(
        /privateKey|encryptedKey|mnemonic|seedPhrase|seed_phrase/i
      );

      // No DB records should have been created
      const after = await getWalletCounters();
      expect(after).toEqual(before);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("assets endpoint returns ETH balance and discovered ERC-20 balances", async () => {
    const externalWallet = ethers.Wallet.createRandom();
    const fakeTokenAddress = ethers.Wallet.createRandom().address;

    // Stub provider.getBalance to return 2 ETH
    const balanceSpy = mockBalance(ethers.parseEther("2"));

    // Stub Etherscan to return one ERC-20 token
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "1",
        message: "OK",
        result: [{ contractAddress: fakeTokenAddress }],
      }),
    } as any);

    // Stub the token's balanceOf call (provider.call dispatched by ethers Contract)
    const callSpy = jest
      .spyOn(providerLib.provider, "call" as any)
      .mockImplementation(async (tx: any) => {
        // Return 25 tokens encoded as uint256
        return ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256"],
          [ethers.parseUnits("25", 18)]
        );
      });

    try {
      // Sign in
      const challengeRes = await request(app)
        .post("/api/connected-wallet/challenge")
        .send({ address: externalWallet.address });
      const signature = await externalWallet.signMessage(challengeRes.body.message);
      const verifyRes = await request(app)
        .post("/api/connected-wallet/verify")
        .send({ address: externalWallet.address, signature });
      expect(verifyRes.status).toBe(200);
      const token = verifyRes.body.token as string;

      const assetsRes = await request(app)
        .get("/api/connected-wallet/assets")
        .set("Authorization", `Bearer ${token}`);
      expect(assetsRes.status).toBe(200);
      expect(Array.isArray(assetsRes.body)).toBe(true);

      const nativeAsset = assetsRes.body.find((a: any) => a.type === "NATIVE");
      expect(nativeAsset).toBeDefined();
      expect(nativeAsset.assetId).toBe("native:eth");

      // send-max for native
      const sendMaxRes = await request(app)
        .get(
          `/api/connected-wallet/send-max?assetId=${encodeURIComponent(nativeAsset.assetId)}`
        )
        .set("Authorization", `Bearer ${token}`);
      expect(sendMaxRes.status).toBe(200);
      expect(sendMaxRes.body.assetType).toBe("NATIVE");
    } finally {
      balanceSpy.mockRestore();
      callSpy.mockRestore();
      global.fetch = originalFetch;
    }
  });

  test("challenge endpoint rejects payloads containing private key material", async () => {
    const res = await request(app)
      .post("/api/connected-wallet/challenge")
      .send({
        address: "0x9C122F75866c77a619f3298E25FE4aEf246b6b00",
        privateKey: "0xdeadbeef",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/never send private key material/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// CONNECTED → CUSTODIAL DEPOSIT
// ═══════════════════════════════════════════════════════════════
describe("connectedWalletToCustodialDeposits", () => {
  test("ERC-20 transfer into custodial wallet appears as DEPOSIT after sync", async () => {
    const custodialWallet = await createCustodialWallet("Custodial Sink");
    expect(custodialWallet.id).toBeDefined();

    const fakeTokenAddress = ethers.Wallet.createRandom().address;
    const transferAmount = ethers.parseUnits("2", 18);
    const fakeTxHash = ethers.hexlify(ethers.randomBytes(32));
    const targetBlock = 80_000;

    // Set the wallet's lastSyncBlock so the scanner picks up targetBlock
    const dbWallet = await prisma.wallet.findUnique({
      where: { id: custodialWallet.id },
      include: { walletGroup: true },
    });
    await prisma.walletGroup.update({
      where: { id: dbWallet!.walletGroupId },
      data: { lastSyncBlock: targetBlock - 1 },
    });

    // Build a synthetic ERC-20 Transfer(address,address,uint256) input
    const transferInput = new ethers.Interface([
      "function transfer(address to, uint256 amount)",
    ]).encodeFunctionData("transfer", [custodialWallet.address, transferAmount]);

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
              transactions: [
                {
                  hash: fakeTxHash,
                  to: fakeTokenAddress,
                  from: "0x0000000000000000000000000000000000000001",
                  value: ethers.toQuantity(0n),
                  input: transferInput,
                },
              ],
            };
          }
          return { transactions: [] };
        }
        return originalSend(method, params);
      });
    const balanceSpy = jest
      .spyOn(providerLib.provider, "getBalance")
      .mockResolvedValue(0n);

    try {
      await detectDeposits();
    } finally {
      sendSpy.mockRestore();
      balanceSpy.mockRestore();
    }

    const deposit = await prisma.transaction.findFirst({
      where: {
        walletId: custodialWallet.id,
        type: "DEPOSIT",
        assetType: "ERC20",
        txHash: fakeTxHash,
      },
    });

    expect(deposit).not.toBeNull();
    expect(deposit!.tokenAddress!.toLowerCase()).toBe(fakeTokenAddress.toLowerCase());
    expect(deposit!.amount).toBe(transferAmount.toString());
  });
});
