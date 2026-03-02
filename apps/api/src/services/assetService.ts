import { Prisma } from "@prisma/client";
import { ethers } from "ethers";
import { prisma } from "../lib/prisma";
import { provider } from "../lib/provider";

type DbClient = Prisma.TransactionClient | typeof prisma;

const NATIVE_ASSET_SYMBOL = "ETH";
const NATIVE_ASSET_DECIMALS = 18;

let cachedChainId: number | null = null;

async function getChainId(): Promise<number> {
  if (cachedChainId !== null) return cachedChainId;
  const network = await provider.getNetwork();
  cachedChainId = Number(network.chainId);
  return cachedChainId;
}

function getDb(tx?: Prisma.TransactionClient): DbClient {
  return tx ?? prisma;
}

export async function ensureNativeAsset(tx?: Prisma.TransactionClient) {
  const db = getDb(tx);
  const chainId = await getChainId();
  const existing = await db.asset.findFirst({
    where: {
      chainId,
      type: "NATIVE",
      contractAddress: null,
    },
  });

  if (existing) {
    return db.asset.update({
      where: { id: existing.id },
      data: {
        symbol: NATIVE_ASSET_SYMBOL,
        decimals: NATIVE_ASSET_DECIMALS,
        type: "NATIVE",
      },
    });
  }

  return db.asset.create({
    data: {
      chainId,
      type: "NATIVE",
      symbol: NATIVE_ASSET_SYMBOL,
      decimals: NATIVE_ASSET_DECIMALS,
      contractAddress: null,
    },
  });
}

export async function ensureErc20Asset(
  contractAddress: string,
  symbol: string,
  decimals: number,
  tx?: Prisma.TransactionClient
) {
  const db = getDb(tx);
  const chainId = await getChainId();
  const normalizedAddress = ethers.getAddress(contractAddress);
  return db.asset.upsert({
    where: {
      chainId_contractAddress: {
        chainId,
        contractAddress: normalizedAddress,
      },
    },
    update: {
      type: "ERC20",
      symbol,
      decimals,
    },
    create: {
      chainId,
      type: "ERC20",
      symbol,
      decimals,
      contractAddress: normalizedAddress,
    },
  });
}

export async function getWalletAssetBalance(
  walletId: string,
  assetId: string,
  tx?: Prisma.TransactionClient
): Promise<bigint> {
  const db = getDb(tx);
  const row = await db.walletAssetBalance.findUnique({
    where: { walletId_assetId: { walletId, assetId } },
  });
  return row ? BigInt(row.balance) : 0n;
}

export async function setWalletAssetBalance(
  walletId: string,
  assetId: string,
  balance: bigint,
  tx?: Prisma.TransactionClient
) {
  const db = getDb(tx);
  return db.walletAssetBalance.upsert({
    where: { walletId_assetId: { walletId, assetId } },
    update: { balance: balance.toString() },
    create: {
      walletId,
      assetId,
      balance: balance.toString(),
    },
  });
}

export async function addWalletAssetBalance(
  walletId: string,
  assetId: string,
  delta: bigint,
  tx?: Prisma.TransactionClient
) {
  const current = await getWalletAssetBalance(walletId, assetId, tx);
  const next = current + delta;
  if (next < 0n) {
    throw new Error("Asset balance cannot be negative");
  }
  return setWalletAssetBalance(walletId, assetId, next, tx);
}
