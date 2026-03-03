jest.mock("../../src/lib/prisma", () => ({
  prisma: {
    wallet: {
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import { prisma } from "../../src/lib/prisma";
import {
  createWalletInWalletGroup,
  updateWalletName,
} from "../../src/services/walletService";

describe("wallet name validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("rejects duplicate wallet name inside the same wallet group on rename", async () => {
    (prisma.wallet.findFirst as jest.Mock)
      // getAccessibleWallet
      .mockResolvedValueOnce({
        id: "wallet-1",
        ownerId: "user-1",
        walletGroupId: "group-1",
        walletGroup: { id: "group-1", address: "0x0000000000000000000000000000000000000001" },
        accesses: [],
        assetBalances: [],
      })
      // ensureUniqueWalletNameInGroup
      .mockResolvedValueOnce({ id: "wallet-2" });

    await expect(updateWalletName("wallet-1", "user-1", "Treasury")).rejects.toThrow(
      "Wallet name already exists in this wallet group"
    );

    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });

  test("rejects duplicate wallet name when creating a wallet in an existing group", async () => {
    (prisma.wallet.findFirst as jest.Mock)
      // Source wallet lookup in createWalletInWalletGroup
      .mockResolvedValueOnce({ walletGroupId: "group-1" });

    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
      const tx = {
        wallet: {
          // ensureUniqueWalletNameInGroup inside createWalletRecordInGroup
          findFirst: jest.fn().mockResolvedValue({ id: "wallet-2" }),
          create: jest.fn(),
        },
      };
      return callback(tx);
    });

    await expect(
      createWalletInWalletGroup("user-1", "wallet-source", "Treasury")
    ).rejects.toThrow("Wallet name already exists in this wallet group");
  });
});
