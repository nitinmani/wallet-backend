import request from "supertest";
import { ethers } from "ethers";
import { prisma } from "../src/lib/prisma";
import { decrypt, EncryptedData } from "../src/lib/keyvault";
import { detectDeposits } from "../src/services/depositDetector";
import { reconcileBroadcastingTransactions } from "../src/services/transactionService";

// Provider pointed at Anvil (set by env-setup.ts)
const provider = new ethers.JsonRpcProvider(
  process.env.TEST_RPC_URL || "http://127.0.0.1:8545"
);

// Anvil's default funded account (account #0)
const ANVIL_FUNDER = new ethers.Wallet(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  provider
);

// Load compiled ERC-20 artifact
const tokenArtifact = require("./contracts/TestToken.compiled.json");

let app: any;
let testApiKey: string;
let testUserId: string;
let testToken: ethers.Contract;
let testTokenAddress: string;

beforeAll(async () => {
  // Dynamically import app (after env-setup.ts has overridden RPC URL)
  const appModule = await import("../src/app");
  app = appModule.default;

  // Clean DB
  await prisma.transaction.deleteMany();
  await prisma.walletAccess.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.walletGroup.deleteMany();
  await prisma.user.deleteMany();

  // Create test user
  const res = await request(app)
    .post("/api/users")
    .send({ email: "test@vencura.dev" });
  testApiKey = res.body.apiKey;
  testUserId = res.body.id;

  // Deploy test ERC-20 token on Anvil
  const factory = new ethers.ContractFactory(
    tokenArtifact.abi,
    tokenArtifact.bytecode,
    ANVIL_FUNDER
  );
  const initialSupply = ethers.parseUnits("1000000", 18);
  testToken = (await factory.deploy(
    "TestToken",
    "TST",
    initialSupply
  )) as ethers.Contract;
  await testToken.waitForDeployment();
  testTokenAddress = await testToken.getAddress();
});

afterAll(async () => {
  await prisma.transaction.deleteMany();
  await prisma.walletAccess.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.walletGroup.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
});

// ─── Helpers ────────────────────────────────────────────────────
async function fundWallet(address: string, ethAmount: string) {
  // Get nonce directly from RPC to bypass ethers provider cache
  const rawNonce = await provider.send("eth_getTransactionCount", [
    ANVIL_FUNDER.address,
    "latest",
  ]);
  const nonce = parseInt(rawNonce, 16);
  const tx = await ANVIL_FUNDER.sendTransaction({
    to: address,
    value: ethers.parseEther(ethAmount),
    nonce,
  });
  await tx.wait();
  return tx.hash;
}

async function fundTokens(address: string, amount: string) {
  const rawNonce = await provider.send("eth_getTransactionCount", [
    ANVIL_FUNDER.address,
    "latest",
  ]);
  const nonce = parseInt(rawNonce, 16);
  const tx = await testToken.transfer(address, ethers.parseUnits(amount, 18), {
    nonce,
  });
  await tx.wait();
}

async function createTestWallet(name?: string) {
  const res = await request(app)
    .post("/api/wallets")
    .set("x-api-key", testApiKey)
    .send({ name: name || "Test Wallet" });
  return res.body;
}

async function createUser(email: string) {
  const res = await request(app)
    .post("/api/users")
    .send({ email });
  return res.body;
}

async function createWalletInGroup(apiKey: string, sourceWalletId: string, name?: string) {
  const res = await request(app)
    .post(`/api/wallets/${sourceWalletId}/group-wallet`)
    .set("x-api-key", apiKey)
    .send({ name });
  return res;
}

async function settleBroadcastingTxs(iterations = 12) {
  for (let i = 0; i < iterations; i++) {
    await reconcileBroadcastingTransactions(500);
    const pending = await prisma.transaction.count({
      where: { status: "BROADCASTING" },
    });
    if (pending === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForTxFinalStatus(
  txId: string,
  expected: Array<"CONFIRMED" | "FAILED"> = ["CONFIRMED"]
) {
  for (let i = 0; i < 20; i++) {
    await reconcileBroadcastingTransactions(500);
    const tx = await prisma.transaction.findUnique({
      where: { id: txId },
    });
    if (tx && expected.includes(tx.status as "CONFIRMED" | "FAILED")) {
      return tx;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const current = await prisma.transaction.findUnique({ where: { id: txId } });
  throw new Error(
    `Transaction ${txId} did not reach expected status. Current: ${current?.status}`
  );
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
    expect(res.body.type).toBe("STANDARD");

    // Verify it's in the DB
    const dbWallet = await prisma.wallet.findUnique({
      where: { id: res.body.id },
    });
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
    });
    expect(dbWallet).not.toBeNull();
    expect(dbWallet!.encryptedKey).toBeDefined();

    // encryptedKey must be JSON with ciphertext/iv/tag — NOT a raw hex private key
    const parsed: EncryptedData = JSON.parse(dbWallet!.encryptedKey!);
    expect(parsed.ciphertext).toBeDefined();
    expect(parsed.iv).toBeDefined();
    expect(parsed.tag).toBeDefined();

    // Must NOT start with 0x (raw private key format)
    expect(dbWallet!.encryptedKey!.startsWith("0x")).toBe(false);

    // Decrypting should yield a valid private key that matches the wallet address
    const privateKey = decrypt(dbWallet!.encryptedKey!);
    expect(privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    const reconstructed = new ethers.Wallet(privateKey);
    expect(reconstructed.address).toBe(res.body.address);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. GET BALANCE
// ═══════════════════════════════════════════════════════════════
describe("getBalance", () => {
  test("returns balance for a random (non-wallet) address", async () => {
    const randomAddr = ethers.Wallet.createRandom().address;
    const res = await request(app)
      .get(`/api/balance/${randomAddr}`)
      .set("x-api-key", testApiKey);

    expect(res.status).toBe(200);
    expect(res.body.address).toBe(randomAddr);
    expect(res.body.balance).toBeDefined();
    expect(res.body.formatted).toBeDefined();
  });

  test("returns balance for a wallet address (by wallet ID)", async () => {
    const wallet = await createTestWallet("Balance Wallet");
    await fundWallet(wallet.address, "1.5");

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

  test("deposit to wallet address creates a DEPOSIT transaction within 10 minutes", async () => {
    const wallet = await createTestWallet("Deposit Detection Wallet");

    // Record current block as the wallet's lastSyncBlock
    const currentBlock = await provider.getBlockNumber();
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { lastSyncBlock: currentBlock },
    });

    // Send ETH to our wallet from the Anvil funder (on-chain deposit)
    const depositTx = await ANVIL_FUNDER.sendTransaction({
      to: wallet.address,
      value: ethers.parseEther("0.25"),
    });
    await depositTx.wait();

    // Run deposit detector
    await detectDeposits();

    // Check that a DEPOSIT transaction was created
    const transactions = await prisma.transaction.findMany({
      where: { walletId: wallet.id, type: "DEPOSIT" },
    });

    expect(transactions.length).toBeGreaterThanOrEqual(1);
    const deposit = transactions.find((t) => t.txHash === depositTx.hash);
    expect(deposit).toBeDefined();
    expect(deposit!.status).toBe("CONFIRMED");
    expect(deposit!.amount).toBe(ethers.parseEther("0.25").toString());

    // Verify it was created within 10 minutes of now
    const timeDiff = Date.now() - deposit!.createdAt.getTime();
    expect(timeDiff).toBeLessThan(10 * 60 * 1000);
  });

  test("ERC-20 deposit to wallet address creates a token DEPOSIT transaction", async () => {
    const wallet = await createTestWallet("Token Deposit Detection Wallet");

    const currentBlock = await provider.getBlockNumber();
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { lastSyncBlock: currentBlock },
    });

    const tokenDepositTx = await testToken.transfer(
      wallet.address,
      ethers.parseUnits("25", 18)
    );
    await tokenDepositTx.wait();

    await detectDeposits();

    const tokenDeposit = await prisma.transaction.findFirst({
      where: {
        walletId: wallet.id,
        type: "DEPOSIT",
        assetType: "ERC20",
        txHash: tokenDepositTx.hash,
      },
    });

    expect(tokenDeposit).not.toBeNull();
    expect(tokenDeposit!.assetSymbol).toBe("TST");
    expect(tokenDeposit!.tokenAddress!.toLowerCase()).toBe(
      testTokenAddress.toLowerCase()
    );
    expect(tokenDeposit!.tokenDecimals).toBe(18);
    expect(tokenDeposit!.amount).toBe(ethers.parseUnits("25", 18).toString());
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. SIGN MESSAGE
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

    // Verify: recover the signer address from the signature
    const recoveredAddress = ethers.verifyMessage(message, res.body.signature);
    expect(recoveredAddress).toBe(wallet.address);
  });

  test("signed value matches expected output for a known message", async () => {
    const wallet = await createTestWallet("Deterministic Sign Wallet");

    // Get the private key to compute expected signature locally
    const dbWallet = await prisma.wallet.findUnique({
      where: { id: wallet.id },
    });
    const privateKey = decrypt(dbWallet!.encryptedKey!);
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

    const res1 = await request(app)
      .post(`/api/wallets/${wallet.id}/sign`)
      .set("x-api-key", testApiKey)
      .send({ message: "message A" });

    const res2 = await request(app)
      .post(`/api/wallets/${wallet.id}/sign`)
      .set("x-api-key", testApiKey)
      .send({ message: "message B" });

    expect(res1.body.signature).not.toBe(res2.body.signature);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. SEND TRANSACTION
// ═══════════════════════════════════════════════════════════════
describe("sendTransaction", () => {
  const recipient = ethers.Wallet.createRandom().address;

  test("withdrawal of native ETH returns BROADCASTING first, then reaches CONFIRMED", async () => {
    const wallet = await createTestWallet("ETH Send Wallet");
    await fundWallet(wallet.address, "10");

    const res = await request(app)
      .post(`/api/wallets/${wallet.id}/send`)
      .set("x-api-key", testApiKey)
      .send({ to: recipient, amount: "0.1" });

    expect(res.status).toBe(200);
    expect(res.body.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(res.body.transactionId).toBeDefined();
    expect(res.body.nonce).toBeDefined();
    expect(res.body.status).toBe("BROADCASTING");

    // Verify on chain
    const receipt = await provider.getTransactionReceipt(res.body.txHash);
    expect(receipt).not.toBeNull();
    expect(receipt!.status).toBe(1);

    // Verify DB record transitions from BROADCASTING to CONFIRMED
    const initialTxRecord = await prisma.transaction.findUnique({
      where: { id: res.body.transactionId },
    });
    expect(initialTxRecord).not.toBeNull();
    expect(initialTxRecord!.status).toBe("BROADCASTING");

    const txRecord = await waitForTxFinalStatus(res.body.transactionId, ["CONFIRMED"]);
    expect(txRecord!.status).toBe("CONFIRMED");
    expect(txRecord!.type).toBe("WITHDRAWAL");
    expect(txRecord!.to).toBe(recipient);
    expect(txRecord!.txHash).toBe(res.body.txHash);
    expect(txRecord!.nonce).not.toBeNull();
    expect(txRecord!.gasPrice).not.toBeNull();
  });

  test("withdrawal of ERC-20 token", async () => {
    const wallet = await createTestWallet("ERC20 Send Wallet");
    await fundWallet(wallet.address, "1"); // ETH for gas
    await fundTokens(wallet.address, "100"); // 100 TST

    const tokenRecipient = ethers.Wallet.createRandom().address;

    const res = await request(app)
      .post(`/api/wallets/${wallet.id}/send-token`)
      .set("x-api-key", testApiKey)
      .send({
        to: tokenRecipient,
        tokenAddress: testTokenAddress,
        amount: "50",
      });

    expect(res.status).toBe(200);
    expect(res.body.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(res.body.status).toBe("BROADCASTING");

    // Verify token balance on-chain
    const tokenContract = new ethers.Contract(
      testTokenAddress,
      ["function balanceOf(address) view returns (uint256)"],
      provider
    );
    const recipientBalance = await tokenContract.balanceOf(tokenRecipient);
    expect(recipientBalance).toBe(ethers.parseUnits("50", 18));

    // Verify DB record after reconciliation
    const txRecord = await waitForTxFinalStatus(res.body.transactionId, ["CONFIRMED"]);
    expect(txRecord!.status).toBe("CONFIRMED");
    expect(txRecord!.type).toBe("WITHDRAWAL");
    expect(txRecord!.assetType).toBe("ERC20");
    expect(txRecord!.assetSymbol).toBe("TST");
    expect(txRecord!.tokenAddress!.toLowerCase()).toBe(testTokenAddress.toLowerCase());
  });

  test("error when withdrawing more ETH than wallet balance", async () => {
    const poorWallet = await createTestWallet("Poor Wallet");
    await fundWallet(poorWallet.address, "0.01");

    const res = await request(app)
      .post(`/api/wallets/${poorWallet.id}/send`)
      .set("x-api-key", testApiKey)
      .send({ to: recipient, amount: "100" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Insufficient balance/i);

    // No CONFIRMED tx should exist
    const txs = await prisma.transaction.findMany({
      where: { walletId: poorWallet.id, status: "CONFIRMED" },
    });
    expect(txs.length).toBe(0);
  });

  test("gas + withdrawal amount must not exceed balance", async () => {
    const tightWallet = await createTestWallet("Tight Balance Wallet");
    // Fund with a tiny amount — enough for value but not value + gas
    await fundWallet(tightWallet.address, "0.0001");

    const res = await request(app)
      .post(`/api/wallets/${tightWallet.id}/send`)
      .set("x-api-key", testApiKey)
      .send({ to: recipient, amount: "0.0001" });

    // Should fail because 0.0001 ETH + gas > 0.0001 ETH balance
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Insufficient balance/i);
  });

  test("idempotency — submitting duplicate nonce: only one tx confirms, other fails", async () => {
    const idempWallet = await createTestWallet("Idempotency Wallet");
    await fundWallet(idempWallet.address, "5");

    // Get the current nonce
    const dbWallet = await prisma.wallet.findUnique({
      where: { id: idempWallet.id },
    });
    const pk = decrypt(dbWallet!.encryptedKey!);
    const signer = new ethers.Wallet(pk, provider);
    const currentNonce = await provider.getTransactionCount(
      signer.address,
      "pending"
    );

    // Send first tx with explicit nonce
    const res1 = await request(app)
      .post(`/api/wallets/${idempWallet.id}/send`)
      .set("x-api-key", testApiKey)
      .send({ to: recipient, amount: "0.01", nonce: currentNonce });

    expect(res1.status).toBe(200);

    // Second tx with same nonce should fail (nonce already used)
    const res2 = await request(app)
      .post(`/api/wallets/${idempWallet.id}/send`)
      .set("x-api-key", testApiKey)
      .send({ to: recipient, amount: "0.01", nonce: currentNonce });

    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/failed/i);

    await settleBroadcastingTxs();

    // Verify DB states
    const allTxs = await prisma.transaction.findMany({
      where: { walletId: idempWallet.id },
      orderBy: { createdAt: "asc" },
    });

    const confirmed = allTxs.filter((t) => t.status === "CONFIRMED");
    const failed = allTxs.filter((t) => t.status === "FAILED");

    expect(confirmed.length).toBe(1);
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  test("RBF — replace low-gas tx with higher gas, same nonce", async () => {
    const rbfWallet = await createTestWallet("RBF Wallet");
    await fundWallet(rbfWallet.address, "5");

    const dbWallet = await prisma.wallet.findUnique({
      where: { id: rbfWallet.id },
    });
    const pk = decrypt(dbWallet!.encryptedKey!);
    const signer = new ethers.Wallet(pk, provider);
    const nonce = await provider.getTransactionCount(
      signer.address,
      "pending"
    );

    const lowGasPrice = 1_000_000_000n; // 1 gwei
    const highGasPrice = 10_000_000_000n; // 10 gwei

    // Send first tx directly with low gas price
    const tx1 = await signer.sendTransaction({
      to: recipient,
      value: ethers.parseEther("0.01"),
      nonce,
      gasPrice: lowGasPrice,
    });

    // Record it in DB as BROADCASTING
    const txRecord1 = await prisma.transaction.create({
      data: {
        walletId: rbfWallet.id,
        type: "WITHDRAWAL",
        to: recipient,
        from: signer.address,
        amount: ethers.parseEther("0.01").toString(),
        nonce,
        gasPrice: lowGasPrice.toString(),
        txHash: tx1.hash,
        status: "BROADCASTING",
      },
    });

    // Attempt RBF via API
    const rbfRes = await request(app)
      .post(`/api/wallets/${rbfWallet.id}/rbf`)
      .set("x-api-key", testApiKey)
      .send({
        originalTxId: txRecord1.id,
        gasPrice: highGasPrice.toString(),
      });

    // On Anvil with automining, the first tx is instantly mined.
    // Two valid outcomes:
    if (rbfRes.status === 200) {
      // RBF succeeded → original marked FAILED, replacement eventually CONFIRMED
      const original = await prisma.transaction.findUnique({
        where: { id: txRecord1.id },
      });
      expect(original!.status).toBe("FAILED");

      const replacement = await waitForTxFinalStatus(rbfRes.body.transactionId, [
        "CONFIRMED",
        "FAILED",
      ]);
      expect(replacement!.status).toBe("CONFIRMED");
      expect(replacement!.nonce).toBe(nonce);
    } else {
      // Nonce already consumed (Anvil automined first tx) → first tx confirmed on-chain
      expect(rbfRes.status).toBe(400);
      const receipt = await provider.getTransactionReceipt(tx1.hash);
      expect(receipt).not.toBeNull();
      expect(receipt!.status).toBe(1);

      // The failed replacement should have a FAILED record
      const failedTxs = await prisma.transaction.findMany({
        where: { walletId: rbfWallet.id, status: "FAILED" },
      });
      expect(failedTxs.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("successful tx has CONFIRMED state with txHash, nonce, and gasPrice set", async () => {
    const stateWallet = await createTestWallet("State Wallet");
    await fundWallet(stateWallet.address, "1");

    const res = await request(app)
      .post(`/api/wallets/${stateWallet.id}/send`)
      .set("x-api-key", testApiKey)
      .send({ to: recipient, amount: "0.001" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("BROADCASTING");

    const txRecord = await waitForTxFinalStatus(res.body.transactionId, ["CONFIRMED"]);
    expect(txRecord).not.toBeNull();
    expect(txRecord!.status).toBe("CONFIRMED");
    expect(txRecord!.nonce).not.toBeNull();
    expect(txRecord!.gasPrice).not.toBeNull();
    expect(txRecord!.txHash).not.toBeNull();
  });

  test("failed transaction (zero balance) ends in FAILED state with no CONFIRMED record", async () => {
    const emptyWallet = await createTestWallet("Empty TX Wallet");

    const res = await request(app)
      .post(`/api/wallets/${emptyWallet.id}/send`)
      .set("x-api-key", testApiKey)
      .send({ to: recipient, amount: "1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Insufficient balance/i);

    // No tx record should be CONFIRMED
    const txs = await prisma.transaction.findMany({
      where: { walletId: emptyWallet.id, status: "CONFIRMED" },
    });
    expect(txs.length).toBe(0);
  });
});

describe("walletGroups", () => {
  test("internal transfer between wallets that share a private key stays off-chain and records withdrawal+deposit with zero gas", async () => {
    const source = await createTestWallet("Group Source");
    await fundWallet(source.address, "5");

    await prisma.wallet.update({
      where: { id: source.id },
      data: { balance: ethers.parseEther("3").toString() },
    });

    const groupedRes = await createWalletInGroup(testApiKey, source.id, "Group Destination");
    expect(groupedRes.status).toBe(201);
    const destination = groupedRes.body;

    const transferRes = await request(app)
      .post(`/api/wallets/${source.id}/transfer`)
      .set("x-api-key", testApiKey)
      .send({ toWalletId: destination.id, amount: "1" });

    expect(transferRes.status).toBe(200);

    const debit = await prisma.transaction.findUnique({
      where: { id: transferRes.body.debitTxId },
    });
    const credit = await prisma.transaction.findUnique({
      where: { id: transferRes.body.creditTxId },
    });

    expect(debit).not.toBeNull();
    expect(credit).not.toBeNull();
    expect(debit!.type).toBe("WITHDRAWAL");
    expect(credit!.type).toBe("DEPOSIT");
    expect(debit!.gasPrice).toBe("0");
    expect(credit!.gasPrice).toBe("0");
    expect(debit!.txHash).toBeNull();
    expect(credit!.txHash).toBeNull();

    const [dbSource, dbDestination] = await Promise.all([
      prisma.wallet.findUnique({ where: { id: source.id } }),
      prisma.wallet.findUnique({ where: { id: destination.id } }),
    ]);

    expect(dbSource!.balance).toBe(ethers.parseEther("2").toString());
    expect(dbDestination!.balance).toBe(ethers.parseEther("1").toString());
  });

  test("grouped wallet internal transfer cannot exceed source wallet balance", async () => {
    const source = await createTestWallet("Low Group Source");
    await fundWallet(source.address, "2");
    await prisma.wallet.update({
      where: { id: source.id },
      data: { balance: ethers.parseEther("0.25").toString() },
    });

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
    await fundWallet(groupedSource.address, "5");

    await prisma.wallet.update({
      where: { id: groupedSource.id },
      data: { balance: ethers.parseEther("0.05").toString() },
    });

    const groupedRes = await createWalletInGroup(
      testApiKey,
      groupedSource.id,
      "Grouped External Dest"
    );
    expect(groupedRes.status).toBe(201);

    const recipient = ethers.Wallet.createRandom().address;
    const sendRes = await request(app)
      .post(`/api/wallets/${groupedSource.id}/send`)
      .set("x-api-key", testApiKey)
      .send({ to: recipient, amount: "0.05" });

    expect(sendRes.status).toBe(400);
    expect(sendRes.body.error).toMatch(/Insufficient balance/i);
  });

  test("only one wallet in the same wallet group can withdraw at a time with a shared private key", async () => {
    const walletA = await createTestWallet("Group Lock A");
    await fundWallet(walletA.address, "20");

    await prisma.wallet.update({
      where: { id: walletA.id },
      data: { balance: ethers.parseEther("12").toString() },
    });

    const walletBRes = await createWalletInGroup(testApiKey, walletA.id, "Group Lock B");
    expect(walletBRes.status).toBe(201);
    const walletB = walletBRes.body;

    await prisma.wallet.update({
      where: { id: walletB.id },
      data: { balance: ethers.parseEther("12").toString() },
    });

    const recipientA = ethers.Wallet.createRandom().address;
    const recipientB = ethers.Wallet.createRandom().address;

    const [sendA, sendB] = await Promise.all([
      request(app)
        .post(`/api/wallets/${walletA.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: recipientA, amount: "11" }),
      request(app)
        .post(`/api/wallets/${walletB.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: recipientB, amount: "11" }),
    ]);

    const statuses = [sendA.status, sendB.status].sort();
    expect(statuses).toEqual([200, 400]);

    await settleBroadcastingTxs();

    const confirmed = await prisma.transaction.findMany({
      where: {
        walletId: { in: [walletA.id, walletB.id] },
        status: "CONFIRMED",
        type: "WITHDRAWAL",
      },
    });
    expect(confirmed.length).toBe(1);
  });

  test("cron-style deposit detector picks grouped-wallet deposits and credits the primary wallet", async () => {
    const source = await createTestWallet("Grouped Deposit Source");
    const groupedRes = await createWalletInGroup(testApiKey, source.id, "Grouped Deposit Member");
    expect(groupedRes.status).toBe(201);

    const groupId = groupedRes.body.walletGroupId as string;
    const depositTxHash = await fundWallet(source.address, "0.12");

    await detectDeposits();

    const groupWallets = await prisma.wallet.findMany({
      where: { walletGroupId: groupId },
      orderBy: { createdAt: "asc" },
    });
    expect(groupWallets.length).toBeGreaterThanOrEqual(1);
    const primaryWallet = groupWallets[0];

    const deposit = await prisma.transaction.findFirst({
      where: {
        walletId: primaryWallet.id,
        type: "DEPOSIT",
        txHash: depositTxHash,
      },
    });

    expect(deposit).not.toBeNull();
    expect(deposit!.status).toBe("CONFIRMED");

    const refreshedPrimary = await prisma.wallet.findUnique({
      where: { id: primaryWallet.id },
    });
    expect(refreshedPrimary).not.toBeNull();
    expect(BigInt(refreshedPrimary!.balance)).toBeGreaterThanOrEqual(
      ethers.parseEther("0.12")
    );
  });
});

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

  test("shared users cannot over-withdraw the same wallet balance concurrently", async () => {
    const user2 = await createUser("shared-lock@vencura.dev");
    const sharedWallet = await createTestWallet("Concurrent Shared Wallet");
    await fundWallet(sharedWallet.address, "20");

    const shareRes = await request(app)
      .post(`/api/wallets/${sharedWallet.id}/share`)
      .set("x-api-key", testApiKey)
      .send({ email: user2.email });
    expect(shareRes.status).toBe(200);

    const recipient1 = ethers.Wallet.createRandom().address;
    const recipient2 = ethers.Wallet.createRandom().address;

    const [user1Send, user2Send] = await Promise.all([
      request(app)
        .post(`/api/wallets/${sharedWallet.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: recipient1, amount: "11" }),
      request(app)
        .post(`/api/wallets/${sharedWallet.id}/send`)
        .set("x-api-key", user2.apiKey)
        .send({ to: recipient2, amount: "11" }),
    ]);

    const statuses = [user1Send.status, user2Send.status].sort();
    expect(statuses).toEqual([200, 400]);

    await settleBroadcastingTxs();

    const successful = await prisma.transaction.findMany({
      where: {
        walletId: sharedWallet.id,
        status: "CONFIRMED",
        type: "WITHDRAWAL",
      },
    });
    expect(successful.length).toBe(1);

    const [signRes, sendRes] = await Promise.all([
      request(app)
        .post(`/api/wallets/${sharedWallet.id}/sign`)
        .set("x-api-key", user2.apiKey)
        .send({ message: "shared wallet mutex check" }),
      request(app)
        .post(`/api/wallets/${sharedWallet.id}/send`)
        .set("x-api-key", testApiKey)
        .send({ to: ethers.Wallet.createRandom().address, amount: "0.001" }),
    ]);

    expect(signRes.status).toBe(200);
    expect(sendRes.status).toBe(200);
  });
});

describe("manualWalletSync", () => {
  test("manual sync detects new deposits, refreshes balance, and updates transaction state", async () => {
    const wallet = await createTestWallet("Manual Sync Wallet");
    const depositTxHash = await fundWallet(wallet.address, "0.2");

    const syncRes = await request(app)
      .post(`/api/wallets/${wallet.id}/sync`)
      .set("x-api-key", testApiKey);

    expect(syncRes.status).toBe(200);
    expect(syncRes.body.wallet.id).toBe(wallet.id);
    expect(syncRes.body.depositSync).toBeDefined();

    const deposit = await prisma.transaction.findFirst({
      where: {
        walletId: wallet.id,
        type: "DEPOSIT",
        txHash: depositTxHash,
      },
    });
    expect(deposit).not.toBeNull();
    expect(deposit!.status).toBe("CONFIRMED");

    const onchainBalance = await provider.getBalance(wallet.address);
    expect(syncRes.body.wallet.balance).toBe(onchainBalance.toString());
  });

  test("manual sync reconciles a wallet's broadcasting withdrawal to final status", async () => {
    const wallet = await createTestWallet("Manual Reconcile Wallet");
    await fundWallet(wallet.address, "1");

    const sendRes = await request(app)
      .post(`/api/wallets/${wallet.id}/send`)
      .set("x-api-key", testApiKey)
      .send({ to: ethers.Wallet.createRandom().address, amount: "0.1" });

    expect(sendRes.status).toBe(200);
    expect(sendRes.body.status).toBe("BROADCASTING");

    const syncRes = await request(app)
      .post(`/api/wallets/${wallet.id}/sync`)
      .set("x-api-key", testApiKey);

    expect(syncRes.status).toBe(200);
    expect(syncRes.body.reconciledCount).toBeGreaterThanOrEqual(1);

    const txRecord = await prisma.transaction.findUnique({
      where: { id: sendRes.body.transactionId },
    });
    expect(txRecord).not.toBeNull();
    expect(["CONFIRMED", "FAILED"]).toContain(txRecord!.status);
  });

  test("manual sync is rejected for grouped wallets", async () => {
    const source = await createTestWallet("Grouped Sync Source");
    const groupedRes = await createWalletInGroup(testApiKey, source.id, "Grouped Sync Wallet");
    expect(groupedRes.status).toBe(201);

    const syncRes = await request(app)
      .post(`/api/wallets/${groupedRes.body.id}/sync`)
      .set("x-api-key", testApiKey);

    expect(syncRes.status).toBe(400);
    expect(syncRes.body.error).toMatch(/standard wallets/i);
  });
});

describe("manualWalletGroupSync", () => {
  test("manual wallet-group sync detects deposits for the shared key and credits the primary wallet", async () => {
    const source = await createTestWallet("Group Sync Source");
    const groupedRes = await createWalletInGroup(testApiKey, source.id, "Group Sync Member");
    expect(groupedRes.status).toBe(201);

    const groupId = groupedRes.body.walletGroupId;
    expect(groupId).toBeDefined();

    await prisma.wallet.update({
      where: { id: source.id },
      data: { balance: "0" },
    });

    const depositTxHash = await fundWallet(source.address, "0.15");

    const syncRes = await request(app)
      .post(`/api/wallet-groups/${groupId}/sync`)
      .set("x-api-key", testApiKey);

    expect(syncRes.status).toBe(200);
    expect(syncRes.body.primaryWalletId).toBeDefined();
    expect(syncRes.body.depositSync.depositsFound).toBeGreaterThanOrEqual(1);

    const creditedWallet = await prisma.wallet.findUnique({
      where: { id: syncRes.body.primaryWalletId },
    });
    expect(creditedWallet).not.toBeNull();
    expect(BigInt(creditedWallet!.balance)).toBeGreaterThanOrEqual(
      ethers.parseEther("0.15")
    );

    const deposit = await prisma.transaction.findFirst({
      where: {
        walletId: syncRes.body.primaryWalletId,
        type: "DEPOSIT",
        txHash: depositTxHash,
      },
    });
    expect(deposit).not.toBeNull();
    expect(deposit!.status).toBe("CONFIRMED");
  });
});

describe("walletMetadataUpdates", () => {
  test("can update wallet name", async () => {
    const wallet = await createTestWallet("Old Wallet Name");

    const res = await request(app)
      .patch(`/api/wallets/${wallet.id}`)
      .set("x-api-key", testApiKey)
      .send({ name: "New Wallet Name" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New Wallet Name");

    const dbWallet = await prisma.wallet.findUnique({ where: { id: wallet.id } });
    expect(dbWallet!.name).toBe("New Wallet Name");
  });

  test("can update wallet group name", async () => {
    const wallet = await createTestWallet("Wallet For Group Name");
    const groupedRes = await createWalletInGroup(testApiKey, wallet.id, "Grouped Member");
    expect(groupedRes.status).toBe(201);

    const groupId = groupedRes.body.walletGroupId;
    expect(groupId).toBeDefined();

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

describe("walletGroupsApi", () => {
  test("can create wallet group from dashboard flow and add wallets inside it", async () => {
    const createGroupRes = await request(app)
      .post("/api/wallet-groups")
      .set("x-api-key", testApiKey)
      .send({ name: "Dashboard Group" });

    expect(createGroupRes.status).toBe(201);
    expect(createGroupRes.body.name).toBe("Dashboard Group");
    expect(createGroupRes.body.id).toBeDefined();

    const groupId = createGroupRes.body.id;

    const addWalletRes = await request(app)
      .post(`/api/wallet-groups/${groupId}/wallets`)
      .set("x-api-key", testApiKey)
      .send({ name: "Group Wallet A" });

    expect(addWalletRes.status).toBe(201);
    expect(addWalletRes.body.walletGroupId).toBe(groupId);
    expect(addWalletRes.body.type).toBe("GROUPED");

    const groupDetailRes = await request(app)
      .get(`/api/wallet-groups/${groupId}`)
      .set("x-api-key", testApiKey);

    expect(groupDetailRes.status).toBe(200);
    expect(groupDetailRes.body.wallets.length).toBeGreaterThanOrEqual(1);
    expect(groupDetailRes.body.wallets.some((w: any) => w.id === addWalletRes.body.id)).toBe(true);
  });
});

describe("usersApi", () => {
  test("returns existing users for UI dropdown", async () => {
    const extraUser = await createUser("dropdown-users@vencura.dev");
    expect(extraUser.id).toBeDefined();

    const listRes = await request(app)
      .get("/api/users")
      .set("x-api-key", testApiKey);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.some((u: any) => u.email === "test@vencura.dev")).toBe(true);
    expect(listRes.body.some((u: any) => u.email === "dropdown-users@vencura.dev")).toBe(true);
  });
});
