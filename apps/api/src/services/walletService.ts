import { WalletType } from "@prisma/client";
import { ethers } from "ethers";
import { decrypt, encrypt } from "../lib/keyvault";
import { prisma } from "../lib/prisma";
import { provider } from "../lib/provider";

export async function createWallet(
  userId: string,
  name?: string,
  type: WalletType = "STANDARD"
) {
  const wallet = ethers.Wallet.createRandom();
  const encryptedKey = encrypt(wallet.privateKey);
  const lastSyncBlock =
    type === "STANDARD" ? await provider.getBlockNumber() : 0;

  return prisma.wallet.create({
    data: {
      name: name || "Default Wallet",
      address: wallet.address,
      encryptedKey,
      type,
      ownerId: userId,
      lastSyncBlock,
    },
    include: {
      walletGroup: true,
      accesses: {
        include: {
          user: { select: { id: true, email: true } },
        },
      },
    },
  });
}

export async function getAccessibleWallet(walletId: string, userId: string) {
  return prisma.wallet.findFirst({
    where: {
      id: walletId,
      OR: [{ ownerId: userId }, { accesses: { some: { userId } } }],
    },
    include: {
      walletGroup: true,
      accesses: {
        include: {
          user: { select: { id: true, email: true } },
        },
      },
    },
  });
}

export async function createWalletInWalletGroup(
  userId: string,
  sourceWalletId: string,
  name?: string
) {
  const currentBlock = await provider.getBlockNumber();
  const sourceWallet = await prisma.wallet.findFirst({
    where: { id: sourceWalletId, ownerId: userId },
    include: { walletGroup: true },
  });

  if (!sourceWallet) {
    throw new Error("Source wallet not found or does not belong to user");
  }

  if (!sourceWallet.address) {
    throw new Error("Source wallet has no address");
  }

  let walletGroupId = sourceWallet.walletGroupId;

  if (!walletGroupId) {
    if (!sourceWallet.encryptedKey) {
      throw new Error("Source wallet has no private key");
    }

    const group = await prisma.walletGroup.create({
      data: {
        name: `${sourceWallet.name} Group`,
        encryptedKey: sourceWallet.encryptedKey,
        ownerId: userId,
      },
    });

    walletGroupId = group.id;

    await prisma.wallet.update({
      where: { id: sourceWallet.id },
      data: { walletGroupId, type: "GROUPED" },
    });
  }

  return prisma.wallet.create({
    data: {
      name: name || "Grouped Wallet",
      address: sourceWallet.address,
      encryptedKey: null,
      type: "GROUPED",
      walletGroupId,
      ownerId: userId,
      balance: "0",
      lastSyncBlock: currentBlock,
    },
    include: {
      walletGroup: true,
      accesses: {
        include: {
          user: { select: { id: true, email: true } },
        },
      },
    },
  });
}

export async function createWalletGroup(userId: string, name?: string) {
  const signer = ethers.Wallet.createRandom();
  const encryptedKey = encrypt(signer.privateKey);

  return prisma.walletGroup.create({
    data: {
      name: name?.trim() || "Wallet Group",
      encryptedKey,
      ownerId: userId,
    },
    include: {
      wallets: {
        orderBy: { createdAt: "desc" },
      },
    },
  });
}

export async function getUserWalletGroups(userId: string) {
  return prisma.walletGroup.findMany({
    where: {
      OR: [
        { ownerId: userId },
        {
          wallets: {
            some: {
              OR: [
                { ownerId: userId },
                { accesses: { some: { userId } } },
              ],
            },
          },
        },
      ],
    },
    include: {
      wallets: {
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getWalletGroupById(walletGroupId: string, userId: string) {
  return prisma.walletGroup.findFirst({
    where: {
      id: walletGroupId,
      OR: [
        { ownerId: userId },
        {
          wallets: {
            some: {
              OR: [
                { ownerId: userId },
                { accesses: { some: { userId } } },
              ],
            },
          },
        },
      ],
    },
    include: {
      wallets: {
        include: {
          accesses: {
            include: {
              user: {
                select: { id: true, email: true },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
}

export async function createWalletInExistingWalletGroup(
  walletGroupId: string,
  userId: string,
  name?: string
) {
  const currentBlock = await provider.getBlockNumber();
  const walletGroup = await prisma.walletGroup.findFirst({
    where: {
      id: walletGroupId,
      OR: [
        { ownerId: userId },
        {
          wallets: {
            some: {
              OR: [
                { ownerId: userId },
                { accesses: { some: { userId } } },
              ],
            },
          },
        },
      ],
    },
  });

  if (!walletGroup) {
    throw new Error("Wallet group not found");
  }

  const privateKey = decrypt(walletGroup.encryptedKey);
  const signer = new ethers.Wallet(privateKey);

  return prisma.wallet.create({
    data: {
      name: name?.trim() || "Grouped Wallet",
      address: signer.address,
      encryptedKey: null,
      type: "GROUPED",
      walletGroupId,
      ownerId: userId,
      balance: "0",
      lastSyncBlock: currentBlock,
    },
    include: {
      walletGroup: true,
      accesses: {
        include: {
          user: { select: { id: true, email: true } },
        },
      },
    },
  });
}

export async function shareWalletWithUser(
  ownerUserId: string,
  walletId: string,
  targetUserEmail: string
) {
  const wallet = await prisma.wallet.findFirst({
    where: { id: walletId, ownerId: ownerUserId },
  });

  if (!wallet) {
    throw new Error("Wallet not found or does not belong to user");
  }

  const user = await prisma.user.findUnique({
    where: { email: targetUserEmail },
  });

  if (!user) {
    throw new Error("Target user not found");
  }

  if (user.id === ownerUserId) {
    throw new Error("Cannot share wallet with yourself");
  }

  await prisma.walletAccess.upsert({
    where: {
      walletId_userId: {
        walletId,
        userId: user.id,
      },
    },
    update: {},
    create: {
      walletId,
      userId: user.id,
    },
  });

  return {
    walletId,
    sharedWithUserId: user.id,
    sharedWithEmail: user.email,
  };
}

export async function getUserWallets(userId: string) {
  return prisma.wallet.findMany({
    where: {
      OR: [{ ownerId: userId }, { accesses: { some: { userId } } }],
    },
    include: {
      walletGroup: true,
      accesses: {
        include: {
          user: { select: { id: true, email: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getWalletById(userId: string, walletId: string) {
  return getAccessibleWallet(walletId, userId);
}

export async function getWalletSigningContext(walletId: string, userId: string) {
  const wallet = await getAccessibleWallet(walletId, userId);
  if (!wallet) {
    throw new Error("Wallet not found");
  }

  const encryptedKey = wallet.walletGroup?.encryptedKey || wallet.encryptedKey;
  if (!encryptedKey) {
    throw new Error("No encrypted key available for wallet");
  }

  const privateKey = decrypt(encryptedKey);
  const signer = new ethers.Wallet(privateKey, provider);
  const lockKey = wallet.walletGroupId
    ? `wallet-group:${wallet.walletGroupId}`
    : `wallet:${wallet.id}`;

  return { wallet, signer, lockKey };
}

export async function getWalletSigner(
  walletId: string,
  userId: string
): Promise<ethers.Wallet> {
  const { signer } = await getWalletSigningContext(walletId, userId);
  return signer;
}

export async function updateWalletName(
  walletId: string,
  userId: string,
  name: string
) {
  const normalized = name.trim();
  if (!normalized) {
    throw new Error("name is required");
  }

  const wallet = await getAccessibleWallet(walletId, userId);
  if (!wallet) {
    throw new Error("Wallet not found");
  }

  return prisma.wallet.update({
    where: { id: walletId },
    data: { name: normalized },
    include: {
      walletGroup: true,
      accesses: {
        include: {
          user: { select: { id: true, email: true } },
        },
      },
    },
  });
}

export async function updateWalletGroupName(
  walletGroupId: string,
  userId: string,
  name: string
) {
  const normalized = name.trim();
  if (!normalized) {
    throw new Error("name is required");
  }

  const walletGroup = await prisma.walletGroup.findFirst({
    where: {
      id: walletGroupId,
      OR: [
        { ownerId: userId },
        {
          wallets: {
            some: {
              OR: [{ ownerId: userId }, { accesses: { some: { userId } } }],
            },
          },
        },
      ],
    },
  });

  if (!walletGroup) {
    throw new Error("Wallet group not found");
  }

  return prisma.walletGroup.update({
    where: { id: walletGroupId },
    data: { name: normalized },
  });
}
