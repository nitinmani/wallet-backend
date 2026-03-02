import { ethers } from "ethers";
import { decrypt, encrypt } from "../lib/keyvault";
import { prisma } from "../lib/prisma";
import { provider } from "../lib/provider";
import { ensureNativeAsset, setWalletAssetBalance } from "./assetService";

const walletInclude = {
  walletGroup: true,
  accesses: {
    include: {
      user: { select: { id: true, email: true } },
    },
  },
  assetBalances: {
    include: { asset: true },
    orderBy: { updatedAt: "desc" as const },
  },
};

function getNativeBalanceFromWallet(wallet: any): string {
  const native = (wallet.assetBalances || []).find(
    (row: any) => row.asset?.type === "NATIVE" && !row.asset?.contractAddress
  );
  return native?.balance || "0";
}

function decorateWallet(wallet: any) {
  return {
    ...wallet,
    address: wallet.walletGroup?.address || null,
    balance: getNativeBalanceFromWallet(wallet),
  };
}

function decorateWalletGroup(walletGroup: any) {
  return {
    ...walletGroup,
    wallets: (walletGroup.wallets || []).map((wallet: any) => decorateWallet(wallet)),
  };
}

async function createWalletRecordInGroup(
  walletGroupId: string,
  userId: string,
  name?: string
) {
  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.create({
      data: {
        name: name?.trim() || "Default Wallet",
        walletGroupId,
        ownerId: userId,
      },
      include: walletInclude,
    });

    const nativeAsset = await ensureNativeAsset(tx);
    await setWalletAssetBalance(wallet.id, nativeAsset.id, 0n, tx);
    return decorateWallet(wallet);
  });
}

export async function createWallet(userId: string, name?: string) {
  const signer = ethers.Wallet.createRandom();
  const encryptedKey = encrypt(signer.privateKey);
  const lastSyncBlock = await provider.getBlockNumber();

  return prisma.$transaction(async (tx) => {
    const walletGroup = await tx.walletGroup.create({
      data: {
        name: `${name?.trim() || "Wallet"} Group`,
        address: signer.address,
        encryptedKey,
        ownerId: userId,
        lastSyncBlock,
      },
    });

    const wallet = await tx.wallet.create({
      data: {
        name: name?.trim() || "Default Wallet",
        walletGroupId: walletGroup.id,
        ownerId: userId,
      },
      include: walletInclude,
    });

    const nativeAsset = await ensureNativeAsset(tx);
    await setWalletAssetBalance(wallet.id, nativeAsset.id, 0n, tx);
    return decorateWallet(wallet);
  });
}

export async function getAccessibleWallet(walletId: string, userId: string) {
  const wallet = await prisma.wallet.findFirst({
    where: {
      id: walletId,
      OR: [{ ownerId: userId }, { accesses: { some: { userId } } }],
    },
    include: walletInclude,
  });
  return wallet ? decorateWallet(wallet) : null;
}

export async function createWalletInWalletGroup(
  userId: string,
  sourceWalletId: string,
  name?: string
) {
  const sourceWallet = await prisma.wallet.findFirst({
    where: { id: sourceWalletId, ownerId: userId },
    select: { walletGroupId: true },
  });

  if (!sourceWallet) {
    throw new Error("Source wallet not found or does not belong to user");
  }

  return createWalletRecordInGroup(sourceWallet.walletGroupId, userId, name);
}

export async function getUserWalletGroups(userId: string) {
  const walletGroups = await prisma.walletGroup.findMany({
    where: {
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
    include: {
      wallets: {
        include: walletInclude,
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return walletGroups.map(decorateWalletGroup);
}

export async function getWalletGroupById(walletGroupId: string, userId: string) {
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
    include: {
      wallets: {
        include: walletInclude,
        orderBy: { createdAt: "desc" },
      },
    },
  });
  return walletGroup ? decorateWalletGroup(walletGroup) : null;
}

export async function createWalletInExistingWalletGroup(
  walletGroupId: string,
  userId: string,
  name?: string
) {
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
  if (walletGroup.custodyType !== "CUSTODIAL") {
    throw new Error("Cannot add wallets to a non-custodial wallet group");
  }

  return createWalletRecordInGroup(walletGroupId, userId, name);
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
  const wallets = await prisma.wallet.findMany({
    where: {
      OR: [{ ownerId: userId }, { accesses: { some: { userId } } }],
    },
    include: walletInclude,
    orderBy: { createdAt: "desc" },
  });
  return wallets.map(decorateWallet);
}

export async function getWalletById(userId: string, walletId: string) {
  return getAccessibleWallet(walletId, userId);
}

export async function getWalletSigningContext(walletId: string, userId: string) {
  const wallet = await getAccessibleWallet(walletId, userId);
  if (!wallet) {
    throw new Error("Wallet not found");
  }

  if (wallet.walletGroup.custodyType !== "CUSTODIAL") {
    throw new Error("Server-side signing is not available for non-custodial wallets");
  }

  const encryptedKey = wallet.walletGroup.encryptedKey;
  if (!encryptedKey) {
    throw new Error("Custodial wallet is missing encrypted key material");
  }
  const privateKey = decrypt(encryptedKey);
  const signer = new ethers.Wallet(privateKey, provider);
  const lockKey = `wallet-group:${wallet.walletGroupId}`;

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

  const updated = await prisma.wallet.update({
    where: { id: walletId },
    data: { name: normalized },
    include: walletInclude,
  });
  return decorateWallet(updated);
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
