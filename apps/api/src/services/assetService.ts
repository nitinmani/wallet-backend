import { Prisma } from "@prisma/client";
import { ethers } from "ethers";
import { prisma } from "../lib/prisma";

// Sentinel used in the DB for the native ETH asset so the unique constraint
// on contractAddress works without nullable-NULL gymnastics.
export const NATIVE_CONTRACT_ADDRESS = "native";

const NATIVE_ASSET_SYMBOL = "ETH";
const NATIVE_ASSET_DECIMALS = 18;

type DbClient = Prisma.TransactionClient | typeof prisma;

function getDb(tx?: Prisma.TransactionClient): DbClient {
  return tx ?? prisma;
}

export async function ensureNativeAsset(tx?: Prisma.TransactionClient) {
  const db = getDb(tx);
  return db.asset.upsert({
    where: { contractAddress: NATIVE_CONTRACT_ADDRESS },
    update: {},
    create: {
      type: "NATIVE",
      symbol: NATIVE_ASSET_SYMBOL,
      decimals: NATIVE_ASSET_DECIMALS,
      contractAddress: NATIVE_CONTRACT_ADDRESS,
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
  const normalizedAddress = ethers.getAddress(contractAddress);
  return db.asset.upsert({
    where: { contractAddress: normalizedAddress },
    update: { type: "ERC20", symbol, decimals },
    create: {
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
