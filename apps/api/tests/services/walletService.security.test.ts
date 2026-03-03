jest.mock("../../src/lib/provider", () => ({
  provider: {},
}));

jest.mock("../../src/lib/keyvault", () => ({
  encrypt: jest.fn(),
  decrypt: jest.fn(() => `0x${"1".repeat(64)}`),
}));

jest.mock("../../src/services/assetService", () => ({
  ensureNativeAsset: jest.fn(),
  setWalletAssetBalance: jest.fn(),
}));

jest.mock("../../src/lib/prisma", () => ({
  prisma: {
    wallet: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    walletGroup: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    walletAccess: {
      upsert: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import { prisma } from "../../src/lib/prisma";
import {
  getAccessibleWallet,
  getUserWalletGroups,
  updateWalletGroupName,
} from "../../src/services/walletService";

describe("walletService security", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("getAccessibleWallet never exposes encrypted key material", async () => {
    (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
      id: "wallet-1",
      name: "Primary",
      walletGroupId: "group-1",
      ownerId: "user-1",
      walletGroup: {
        id: "group-1",
        name: "Primary Group",
        address: "0x9C122F75866c77a619f3298E25FE4aEf246b6b00",
        encryptedKey: "super-secret",
      },
      accesses: [],
      assetBalances: [],
    });

    const wallet = await getAccessibleWallet("wallet-1", "user-1");
    expect(wallet).not.toBeNull();
    expect((wallet!.walletGroup as any).encryptedKey).toBeUndefined();
    expect((wallet!.walletGroup as any).privateKey).toBeUndefined();
    expect(JSON.stringify(wallet)).not.toMatch(/encryptedKey|privateKey/i);
  });

  test("getUserWalletGroups never exposes encrypted key material", async () => {
    (prisma.walletGroup.findMany as jest.Mock).mockResolvedValue([
      {
        id: "group-1",
        name: "Treasury",
        address: "0x9C122F75866c77a619f3298E25FE4aEf246b6b00",
        encryptedKey: "super-secret",
        wallets: [
          {
            id: "wallet-1",
            name: "Ops",
            walletGroupId: "group-1",
            ownerId: "user-1",
            walletGroup: {
              id: "group-1",
              address: "0x9C122F75866c77a619f3298E25FE4aEf246b6b00",
              encryptedKey: "nested-secret",
            },
            accesses: [],
            assetBalances: [],
          },
        ],
      },
    ]);

    const groups = await getUserWalletGroups("user-1");
    expect(groups.length).toBe(1);
    expect((groups[0] as any).encryptedKey).toBeUndefined();
    expect((groups[0].wallets[0].walletGroup as any).encryptedKey).toBeUndefined();
    expect(JSON.stringify(groups)).not.toMatch(/encryptedKey|privateKey/i);
  });

  test("updateWalletGroupName response never exposes encrypted key material", async () => {
    (prisma.walletGroup.findFirst as jest.Mock).mockResolvedValue({
      id: "group-1",
      ownerId: "user-1",
    });
    (prisma.walletGroup.update as jest.Mock).mockResolvedValue({
      id: "group-1",
      name: "New Group Name",
      address: "0x9C122F75866c77a619f3298E25FE4aEf246b6b00",
      encryptedKey: "super-secret",
    });

    const updated = await updateWalletGroupName("group-1", "user-1", "New Group Name");
    expect((updated as any).encryptedKey).toBeUndefined();
    expect((updated as any).privateKey).toBeUndefined();
    expect(JSON.stringify(updated)).not.toMatch(/encryptedKey|privateKey/i);
  });
});
