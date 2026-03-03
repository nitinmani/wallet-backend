import { ethers } from "ethers";
import { Prisma } from "@prisma/client";
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
    (row: any) => row.asset?.type === "NATIVE"
  );
  return native?.balance || "0";
}

function sanitizeWalletGroup(walletGroup: any) {
  if (!walletGroup) return walletGroup;
  const { encryptedKey: _encryptedKey, privateKey: _privateKey, ...safeGroup } =
    walletGroup;
  return safeGroup;
}

function decorateWallet(wallet: any) {
  return {
    ...wallet,
    walletGroup: sanitizeWalletGroup(wallet.walletGroup),
    address: wallet.walletGroup?.address || null,
    balance: getNativeBalanceFromWallet(wallet),
  };
}

function decorateWalletGroup(walletGroup: any) {
  const safeGroup = sanitizeWalletGroup(walletGroup);
  return {
    ...safeGroup,
    wallets: (walletGroup.wallets || []).map((wallet: any) => decorateWallet(wallet)),
  };
}

function getDb(tx?: Prisma.TransactionClient) {
  return tx ?? prisma;
}

function normalizeWalletName(name: string): string {
  return name.trim().toLowerCase();
}

function isWalletNameUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== "P2002") return false;

  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (!Array.isArray(target)) return false;

  return target.includes("walletGroupId") && target.includes("nameNormalized");
}

async function ensureUniqueWalletNameInGroup(
  walletGroupId: string,
  walletName: string,
  excludeWalletId?: string,
  tx?: Prisma.TransactionClient
) {
  const db = getDb(tx);
  const normalizedName = normalizeWalletName(walletName);
  const existing = await db.wallet.findFirst({
    where: {
      walletGroupId,
      ...(excludeWalletId ? { id: { not: excludeWalletId } } : {}),
      nameNormalized: normalizedName,
    },
    select: { id: true },
  });

  if (existing) {
    throw new Error("Wallet name already exists in this wallet group");
  }
}

async function createWalletRecordInGroup(
  walletGroupId: string,
  userId: string,
  name?: string
) {
  const normalizedName = name?.trim() || "Default Wallet";
  const normalizedNameKey = normalizeWalletName(normalizedName);

  try {
    return await prisma.$transaction(async (tx) => {
      await ensureUniqueWalletNameInGroup(walletGroupId, normalizedName, undefined, tx);

      const wallet = await tx.wallet.create({
        data: {
          name: normalizedName,
          nameNormalized: normalizedNameKey,
          walletGroupId,
          ownerId: userId,
        },
        include: walletInclude,
      });

      const nativeAsset = await ensureNativeAsset(tx);
      await setWalletAssetBalance(wallet.id, nativeAsset.id, 0n, tx);
      return decorateWallet(wallet);
    });
  } catch (err) {
    if (isWalletNameUniqueConstraintError(err)) {
      throw new Error("Wallet name already exists in this wallet group");
    }
    throw err;
  }
}

export async function createWallet(userId: string, name?: string) {
  const walletName = name?.trim() || "Default Wallet";
  const walletNameNormalized = normalizeWalletName(walletName);
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
        name: walletName,
        nameNormalized: walletNameNormalized,
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

  const walletGroupId = wallet.walletGroupId;
  if (!walletGroupId) {
    throw new Error("Wallet is missing wallet group");
  }

  const walletGroup = await prisma.walletGroup.findUnique({
    where: { id: walletGroupId },
    select: { encryptedKey: true },
  });

  const encryptedKey = walletGroup?.encryptedKey;
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
  const normalizedKey = normalizeWalletName(normalized);

  const wallet = await getAccessibleWallet(walletId, userId);
  if (!wallet) {
    throw new Error("Wallet not found");
  }

  await ensureUniqueWalletNameInGroup(wallet.walletGroupId, normalized, walletId);

  const updated = await prisma.wallet.update({
    where: { id: walletId },
    data: { name: normalized, nameNormalized: normalizedKey },
    include: walletInclude,
  }).catch((err) => {
    if (isWalletNameUniqueConstraintError(err)) {
      throw new Error("Wallet name already exists in this wallet group");
    }
    throw err;
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

  const updated = await prisma.walletGroup.update({
    where: { id: walletGroupId },
    data: { name: normalized },
  });

  return decorateWalletGroup(updated);
}
