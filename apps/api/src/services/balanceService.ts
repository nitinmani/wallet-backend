import { ethers } from "ethers";
import { provider } from "../lib/provider";
import { prisma } from "../lib/prisma";
import {
  ensureNativeAsset,
  getWalletAssetBalance,
  setWalletAssetBalance,
} from "./assetService";

function formatUnitsSafe(value: bigint, decimals: number): string {
  try {
    return ethers.formatUnits(value, decimals);
  } catch {
    return value.toString();
  }
}

export async function getWalletNativeBalance(walletId: string) {
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId },
    include: { walletGroup: true },
  });
  if (!wallet) {
    throw new Error("Wallet not found");
  }

  const nativeAsset = await ensureNativeAsset();
  const balanceRaw = await getWalletAssetBalance(walletId, nativeAsset.id);

  return {
    address: wallet.walletGroup.address,
    balance: balanceRaw.toString(),
    formatted: ethers.formatEther(balanceRaw),
    symbol: nativeAsset.symbol,
    assetId: nativeAsset.id,
  };
}

export async function getWalletAssetBalanceByContract(
  walletId: string,
  contractAddress: string
) {
  const normalized = ethers.getAddress(contractAddress);
  const row = await prisma.walletAssetBalance.findFirst({
    where: {
      walletId,
      asset: {
        contractAddress: normalized,
      },
    },
    include: { asset: true },
  });

  if (!row) {
    return {
      balance: "0",
      formatted: "0",
      symbol: "ERC20",
      decimals: 18,
      assetId: null,
      tokenAddress: normalized,
    };
  }

  const value = BigInt(row.balance);
  return {
    balance: row.balance,
    formatted: formatUnitsSafe(value, row.asset.decimals),
    symbol: row.asset.symbol,
    decimals: row.asset.decimals,
    assetId: row.assetId,
    tokenAddress: row.asset.contractAddress,
  };
}

export async function getWalletAssetBalances(walletId: string) {
  const rows = await prisma.walletAssetBalance.findMany({
    where: { walletId },
    include: { asset: true },
    orderBy: [{ asset: { type: "asc" } }, { asset: { symbol: "asc" } }],
  });

  return rows.map((row) => {
    const value = BigInt(row.balance);
    return {
      assetId: row.assetId,
      type: row.asset.type,
      symbol: row.asset.symbol,
      decimals: row.asset.decimals,
      contractAddress: row.asset.contractAddress,
      balance: row.balance,
      formatted: formatUnitsSafe(value, row.asset.decimals),
    };
  });
}

export async function syncBalances(): Promise<void> {
  const wallets = await prisma.wallet.findMany({
    include: {
      walletGroup: {
        include: {
          wallets: {
            select: { id: true },
          },
        },
      },
    },
  });

  const nativeAsset = await ensureNativeAsset();
  let syncedCount = 0;
  for (const wallet of wallets) {
    try {
      // For shared-key groups with multiple wallets, balances are internal allocations.
      // Avoid overriding allocations with full on-chain address balance.
      if (wallet.walletGroup.wallets.length > 1) {
        continue;
      }
      const chainBalance = await provider.getBalance(wallet.walletGroup.address);
      await setWalletAssetBalance(wallet.id, nativeAsset.id, chainBalance);
      syncedCount += 1;
    } catch (err) {
      console.error(`Failed to sync balance for wallet ${wallet.id}:`, err);
    }
  }

  console.log(`Synced balances for ${syncedCount} wallets`);
}
