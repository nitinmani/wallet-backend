import { ethers } from "ethers";

jest.mock("../../src/lib/provider", () => ({
  provider: {
    getTransactionReceipt: jest.fn(),
    getTransaction: jest.fn(),
    getNetwork: jest.fn(),
    getFeeData: jest.fn(),
    getTransactionCount: jest.fn(),
    estimateGas: jest.fn(),
    getBalance: jest.fn(),
  },
  broadcastSignedTransaction: jest.fn(),
}));

// The prisma mock must include $transaction because reconcileBroadcastingRecord
// now acquires a pg advisory lock via withPgAdvisoryLock → prisma.$transaction.
jest.mock("../../src/lib/prisma", () => ({
  prisma: {
    $transaction: jest.fn(),
    transaction: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    asset: {
      findFirst: jest.fn(),
    },
  },
}));

jest.mock("../../src/services/assetService", () => ({
  ensureNativeAsset: jest.fn(),
  ensureErc20Asset: jest.fn(),
  getWalletAssetBalance: jest.fn(),
  setWalletAssetBalance: jest.fn(),
}));

import { provider } from "../../src/lib/provider";
import { prisma } from "../../src/lib/prisma";
import {
  ensureNativeAsset,
  getWalletAssetBalance,
  setWalletAssetBalance,
} from "../../src/services/assetService";
import { reconcileBroadcastingTransactions } from "../../src/services/transactionService";

describe("reconcileBroadcastingTransactions (CONTRACT)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("applies gas and ERC20 transfer deltas from receipt logs to internal balances", async () => {
    const walletAddress = ethers.Wallet.createRandom().address;
    const tokenAddress = ethers.Wallet.createRandom().address;
    const recipientAddress = ethers.Wallet.createRandom().address;
    const txHash = ethers.hexlify(ethers.randomBytes(32));
    const txId = "tx-1";
    const walletId = "wallet-1";

    (prisma.transaction.findMany as jest.Mock).mockResolvedValue([
      {
        id: txId,
        walletId,
        type: "CONTRACT",
        from: walletAddress,
        txHash,
        status: "BROADCASTING",
        assetType: "NATIVE",
        tokenAddress: null,
        tokenDecimals: null,
        assetSymbol: "ETH",
        amount: "0",
        // No walletGroupId on wallet → lockKey becomes "wallet:wallet-1"
        wallet: { id: walletId, walletGroupId: null },
      },
    ]);

    const transferAmount = ethers.parseUnits("3", 18);
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    const fromTopic = ethers.zeroPadValue(walletAddress, 32);
    const toTopic = ethers.zeroPadValue(recipientAddress, 32);

    (provider.getTransactionReceipt as jest.Mock).mockResolvedValue({
      status: 1,
      gasUsed: 21_000n,
      gasPrice: 1n,
      logs: [
        {
          address: tokenAddress,
          topics: [transferTopic, fromTopic, toTopic],
          data: ethers.toBeHex(transferAmount),
        },
      ],
    });
    (provider.getTransaction as jest.Mock).mockResolvedValue({
      gasPrice: 1n,
      value: 0n,
    });

    (ensureNativeAsset as jest.Mock).mockResolvedValue({ id: "native-asset-id" });

    // Build the mock tx object that withPgAdvisoryLock passes to its callback.
    // It needs: $executeRaw (for the advisory lock SQL), transaction.findUnique
    // (for the status re-check under lock), transaction.update (for the status
    // flip), and asset.findFirst (for ensureTokenAssetFromChain).
    const mockTx = {
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      transaction: {
        findUnique: jest.fn().mockResolvedValue({ status: "BROADCASTING", lockedAmount: "0" }),
        update: jest.fn().mockResolvedValue({}),
      },
      asset: {
        findFirst: jest.fn().mockResolvedValue({
          id: "token-asset-id",
          contractAddress: ethers.getAddress(tokenAddress),
          symbol: "MOCK",
          decimals: 18,
          type: "ERC20",
        }),
      },
    };

    // Make prisma.$transaction invoke the callback immediately with mockTx.
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)
    );

    // First call: native balance. Second call: token balance.
    (getWalletAssetBalance as jest.Mock)
      .mockResolvedValueOnce(ethers.parseEther("1"))
      .mockResolvedValueOnce(ethers.parseUnits("10", 18));

    await reconcileBroadcastingTransactions(10);

    // lockedAmount is "0", so restoredNative = 1 ETH + 0 = 1 ETH.
    // nativeDebit = gasCost + 0 (CONTRACT type, no ETH value) = 21_000n * 1n = 21_000n.
    expect(setWalletAssetBalance).toHaveBeenCalledWith(
      walletId,
      "native-asset-id",
      ethers.parseEther("1") - 21_000n,
      expect.anything() // the tx arg
    );

    // Token delta: FROM walletAddress → net delta = -3 ETH → next = 10 - 3 = 7 ETH.
    expect(setWalletAssetBalance).toHaveBeenCalledWith(
      walletId,
      "token-asset-id",
      ethers.parseUnits("7", 18),
      expect.anything()
    );

    // Status should flip to CONFIRMED via tx.transaction.update (not prisma.updateMany).
    expect(mockTx.transaction.update).toHaveBeenCalledWith({
      where: { id: txId },
      data: { status: "CONFIRMED" },
    });
  });
});
