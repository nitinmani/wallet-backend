import { ethers } from "ethers";
import { provider } from "../lib/provider";
import { prisma } from "../lib/prisma";
import {
  ensureNativeAsset,
  ensureErc20Asset,
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

function parseTokenBalanceHex(value: string | null | undefined): bigint {
  if (!value || typeof value !== "string") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

async function getAlchemyTokenBalances(address: string): Promise<Map<string, bigint>> {
  try {
    const result = (await provider.send("alchemy_getTokenBalances", [
      address,
      "erc20",
    ])) as {
      tokenBalances?: Array<{ contractAddress?: string; tokenBalance?: string }>;
    };

    const balances = new Map<string, bigint>();
    for (const token of result?.tokenBalances || []) {
      if (!token.contractAddress) continue;
      if (!ethers.isAddress(token.contractAddress)) continue;
      const normalized = ethers.getAddress(token.contractAddress);
      const balance = parseTokenBalanceHex(token.tokenBalance);
      if (balance <= 0n) continue;
      balances.set(normalized, balance);
    }
    return balances;
  } catch {
    // Fallback for non-Alchemy providers: discovery via existing tracked tokens only.
    return new Map<string, bigint>();
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

export async function getConnectedWalletAssetBalances(walletId: string) {
  const wallet = await prisma.wallet.findFirst({
    where: {
      id: walletId,
      walletGroup: { custodyType: "NON_CUSTODIAL" },
    },
    include: { walletGroup: true },
  });

  if (!wallet) {
    throw new Error("Connected wallet not found");
  }

  const nativeAsset = await ensureNativeAsset();
  const chainNative = await provider.getBalance(wallet.walletGroup.address);
  await setWalletAssetBalance(wallet.id, nativeAsset.id, chainNative);
  const discoveredTokenBalances = await getAlchemyTokenBalances(wallet.walletGroup.address);

  for (const [tokenAddress, balance] of discoveredTokenBalances.entries()) {
    try {
      const token = new ethers.Contract(
        tokenAddress,
        [
          "function symbol() view returns (string)",
          "function decimals() view returns (uint8)",
        ],
        provider
      );
      const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
      const tokenAsset = await ensureErc20Asset(
        tokenAddress,
        symbol || "ERC20",
        Number(decimals || 18)
      );
      await setWalletAssetBalance(wallet.id, tokenAsset.id, balance);
    } catch {
      const tokenAsset = await ensureErc20Asset(tokenAddress, "ERC20", 18);
      await setWalletAssetBalance(wallet.id, tokenAsset.id, balance);
    }
  }

  const knownTokenTxs = await prisma.transaction.findMany({
    where: {
      walletId,
      assetType: "ERC20",
      tokenAddress: { not: null },
    },
    select: {
      tokenAddress: true,
      assetSymbol: true,
      tokenDecimals: true,
    },
    distinct: ["tokenAddress"],
  });

  for (const tokenTx of knownTokenTxs) {
    if (!tokenTx.tokenAddress) continue;
    const tokenAsset = await ensureErc20Asset(
      tokenTx.tokenAddress,
      tokenTx.assetSymbol || "ERC20",
      tokenTx.tokenDecimals ?? 18
    );
    const existing = await getWalletAssetBalance(wallet.id, tokenAsset.id);
    await setWalletAssetBalance(wallet.id, tokenAsset.id, existing);
  }

  const rows = await prisma.walletAssetBalance.findMany({
    where: { walletId },
    include: { asset: true },
    orderBy: [{ asset: { type: "asc" } }, { asset: { symbol: "asc" } }],
  });

  const nextBalances: Array<{
    assetId: string;
    value: bigint;
  }> = [];

  for (const row of rows) {
    if (row.asset.type === "NATIVE") {
      nextBalances.push({
        assetId: row.assetId,
        value: chainNative,
      });
      continue;
    }

    if (!row.asset.contractAddress) {
      nextBalances.push({ assetId: row.assetId, value: 0n });
      continue;
    }

    const discoveredBalance = discoveredTokenBalances.get(row.asset.contractAddress);
    if (discoveredBalance !== undefined) {
      nextBalances.push({ assetId: row.assetId, value: discoveredBalance });
      continue;
    }

    try {
      const token = new ethers.Contract(
        row.asset.contractAddress,
        [
          "function balanceOf(address owner) view returns (uint256)",
          "function symbol() view returns (string)",
          "function decimals() view returns (uint8)",
        ],
        provider
      );

      const [balance, symbol, decimals] = await Promise.all([
        token.balanceOf(wallet.walletGroup.address),
        token.symbol(),
        token.decimals(),
      ]);

      // Keep metadata fresh for externally-used non-custodial wallets.
      await ensureErc20Asset(
        row.asset.contractAddress,
        symbol || row.asset.symbol,
        Number(decimals || row.asset.decimals)
      );

      nextBalances.push({
        assetId: row.assetId,
        value: BigInt(balance.toString()),
      });
    } catch {
      nextBalances.push({
        assetId: row.assetId,
        value: BigInt(row.balance),
      });
    }
  }

  for (const next of nextBalances) {
    await setWalletAssetBalance(wallet.id, next.assetId, next.value);
  }

  const refreshedRows = await prisma.walletAssetBalance.findMany({
    where: { walletId },
    include: { asset: true },
    orderBy: [{ asset: { type: "asc" } }, { asset: { symbol: "asc" } }],
  });

  return refreshedRows.map((row) => {
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
