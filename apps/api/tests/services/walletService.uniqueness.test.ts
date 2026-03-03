jest.mock("../../src/lib/provider", () => ({
  provider: {
    getBlockNumber: jest.fn(),
  },
}));

jest.mock("../../src/lib/keyvault", () => ({
  encrypt: jest.fn(),
  decrypt: jest.fn(),
}));

jest.mock("../../src/services/assetService", () => ({
  ensureNativeAsset: jest.fn(),
  setWalletAssetBalance: jest.fn(),
}));

jest.mock("../../src/lib/prisma", () => ({
  prisma: {
    $transaction: jest.fn(),
  },
}));

import { provider } from "../../src/lib/provider";
import { encrypt } from "../../src/lib/keyvault";
import { ensureNativeAsset, setWalletAssetBalance } from "../../src/services/assetService";
import { prisma } from "../../src/lib/prisma";
import { createWallet } from "../../src/services/walletService";

describe("wallet group uniqueness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (provider.getBlockNumber as jest.Mock).mockResolvedValue(123456);
    (encrypt as jest.Mock).mockReturnValue("encrypted-private-key");
    (ensureNativeAsset as jest.Mock).mockResolvedValue({ id: "native-asset-id" });
    (setWalletAssetBalance as jest.Mock).mockResolvedValue(undefined);
  });

  test("creates a unique default wallet group name when legacy rows have null nameNormalized", async () => {
    const tx = {
      walletGroup: {
        // Called by getUniqueWalletGroupName + ensureUniqueWalletGroupName.
        findMany: jest.fn().mockResolvedValue([
          { name: "Wallet Group", nameNormalized: null },
        ]),
        create: jest.fn().mockResolvedValue({
          id: "group-2",
          name: "Wallet Group 2",
          nameNormalized: "wallet group 2",
          address: "0x0000000000000000000000000000000000000001",
          encryptedKey: "encrypted-private-key",
          ownerId: "user-1",
          lastSyncBlock: 123456,
        }),
      },
      wallet: {
        create: jest.fn().mockResolvedValue({
          id: "wallet-2",
          name: "Default Wallet",
          nameNormalized: "default wallet",
          walletGroupId: "group-2",
          ownerId: "user-1",
          walletGroup: {
            id: "group-2",
            name: "Wallet Group 2",
            nameNormalized: "wallet group 2",
            address: "0x0000000000000000000000000000000000000001",
            encryptedKey: "encrypted-private-key",
            ownerId: "user-1",
            lastSyncBlock: 123456,
          },
          accesses: [],
          assetBalances: [],
        }),
      },
    };

    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) =>
      callback(tx)
    );

    const wallet = await createWallet("user-1");

    expect(tx.walletGroup.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Wallet Group 2",
          nameNormalized: "wallet group 2",
        }),
      })
    );
    expect(wallet.walletGroup.name).toBe("Wallet Group 2");
  });
});
