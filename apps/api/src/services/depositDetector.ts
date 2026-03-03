import { ethers } from "ethers";
import { provider } from "../lib/provider";
import { prisma } from "../lib/prisma";
import { withPgAdvisoryLock } from "../lib/pgLock";
import {
  ensureErc20Asset,
  ensureNativeAsset,
  getWalletAssetBalance,
  setWalletAssetBalance,
} from "./assetService";
import { getAccessibleWallet } from "./walletService";

const MAX_BLOCKS_PER_WALLET_PER_RUN = 150;
const MAX_BLOCKS_PER_MANUAL_SYNC = 500;
const MAX_MANUAL_SYNC_STEPS = 20;
const BLOCK_FETCH_BATCH_SIZE = 20;
const MAX_BLOCK_FETCH_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

type ChainTxLike = {
  to?: string | null;
  from?: string | null;
  hash?: string | null;
  value?: unknown;
  input?: string | null;
  data?: string | null;
};

type WalletSyncRecord = {
  id: string;
  walletGroupId: string;
  address: string;
  lastSyncBlock: number;
};

type TokenMetadata = {
  symbol: string;
  decimals: number;
};

type ProcessWalletDepositsOptions = {
  creditWalletBalance?: boolean;
};

export type DepositDetectionSummary = {
  currentBlock: number;
  standardWalletsScanned: number;
  groupKeysScanned: number;
  depositsFound: number;
  blocksFetched: number;
  durationMs: number;
};

const ERC20_TRANSFER_INTERFACE = new ethers.Interface([
  "function transfer(address to, uint256 amount)",
]);

const ERC20_METADATA_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

async function getFreshBlockNumber(): Promise<number> {
  const blockHex = await provider.send("eth_blockNumber", []);
  return Number(BigInt(blockHex));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const message = (error as { message?: string }).message || "";
  return (
    message.includes("Too Many Requests") ||
    message.includes("429") ||
    message.includes("-32005")
  );
}

function normalizeValue(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  if (value && typeof value === "object" && "toString" in value) {
    try {
      return BigInt(String(value));
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function getTxInputData(tx: ChainTxLike): string | null {
  const data = tx.input || tx.data;
  return typeof data === "string" && data.startsWith("0x") ? data : null;
}

function decodeErc20Transfer(tx: ChainTxLike) {
  const inputData = getTxInputData(tx);
  if (!inputData) return null;

  try {
    const decoded = ERC20_TRANSFER_INTERFACE.decodeFunctionData(
      "transfer",
      inputData
    );
    const to = String(decoded[0]).toLowerCase();
    const amount = BigInt(decoded[1].toString());
    if (!to || amount <= 0n) return null;

    return { to, amount };
  } catch {
    return null;
  }
}

async function getTokenMetadata(
  tokenAddress: string,
  tokenMetadataCache: Map<string, TokenMetadata>
): Promise<TokenMetadata> {
  const key = tokenAddress.toLowerCase();
  const cached = tokenMetadataCache.get(key);
  if (cached) return cached;

  try {
    const token = new ethers.Contract(tokenAddress, ERC20_METADATA_ABI, provider);
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    const metadata = {
      symbol: typeof symbol === "string" && symbol.trim() ? symbol : "ERC20",
      decimals: Number(decimals),
    };
    tokenMetadataCache.set(key, metadata);
    return metadata;
  } catch {
    const fallback = { symbol: "ERC20", decimals: 18 };
    tokenMetadataCache.set(key, fallback);
    return fallback;
  }
}

async function getBlockTransactions(
  blockNumber: number,
  cache: Map<number, ChainTxLike[]>
): Promise<ChainTxLike[]> {
  const cached = cache.get(blockNumber);
  if (cached) return cached;

  for (let attempt = 1; attempt <= MAX_BLOCK_FETCH_RETRIES; attempt++) {
    try {
      const rawBlock = await provider.send("eth_getBlockByNumber", [
        ethers.toQuantity(blockNumber),
        true,
      ]);
      const txs = (rawBlock?.transactions || []) as ChainTxLike[];
      cache.set(blockNumber, txs);
      return txs;
    } catch (error) {
      const shouldRetry =
        attempt < MAX_BLOCK_FETCH_RETRIES && isRateLimitError(error);
      if (!shouldRetry) throw error;
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
  }

  return [];
}

async function processWalletDeposits(
  wallet: WalletSyncRecord,
  currentBlock: number,
  maxBlocks: number,
  cache: Map<number, ChainTxLike[]>,
  tokenMetadataCache: Map<string, TokenMetadata>,
  options?: ProcessWalletDepositsOptions
) {
  // Legacy safety: never backfill from genesis in interview scope.
  if (wallet.lastSyncBlock <= 0) {
    await prisma.walletGroup.update({
      where: { id: wallet.walletGroupId },
      data: { lastSyncBlock: currentBlock },
    });
    return {
      scannedFromBlock: null as number | null,
      scannedToBlock: null as number | null,
      scannedBlocks: 0,
      depositsFound: 0,
      depositedAmount: "0",
    };
  }

  const fromBlock = wallet.lastSyncBlock + 1;
  if (fromBlock > currentBlock) {
    return {
      scannedFromBlock: null as number | null,
      scannedToBlock: null as number | null,
      scannedBlocks: 0,
      depositsFound: 0,
      depositedAmount: "0",
    };
  }

  const toBlock = Math.min(currentBlock, fromBlock + maxBlocks - 1);
  let depositsFound = 0;
  let depositedAmount = 0n;
  // Collect ERC20 credits to apply under the advisory lock at the end.
  type Erc20Credit = { tokenAddress: string; symbol: string; decimals: number; amount: bigint };
  const pendingErc20Credits: Erc20Credit[] = [];

  for (
    let batchStart = fromBlock;
    batchStart <= toBlock;
    batchStart += BLOCK_FETCH_BATCH_SIZE
  ) {
    const batchEnd = Math.min(toBlock, batchStart + BLOCK_FETCH_BATCH_SIZE - 1);
    const blockNumbers: number[] = [];
    for (let n = batchStart; n <= batchEnd; n++) {
      blockNumbers.push(n);
    }

    const blockTxEntries = await Promise.all(
      blockNumbers.map(async (blockNumber) => {
        const transactions = await getBlockTransactions(blockNumber, cache);
        return { blockNumber, transactions };
      })
    );

    for (const { transactions } of blockTxEntries) {
      if (transactions.length === 0) continue;

      for (const tx of transactions) {
        const txHash = tx.hash || null;
        if (!txHash) continue;

        const toAddress = tx.to?.toLowerCase();
        const walletAddress = wallet.address.toLowerCase();

        // Native ETH deposit
        if (toAddress === walletAddress) {
          const value = normalizeValue(tx.value);
          if (value > 0n) {
            const existingNative = await prisma.transaction.findFirst({
              where: {
                txHash,
                walletId: wallet.id,
                assetType: "NATIVE",
              },
            });

            if (!existingNative) {
              await prisma.transaction.create({
                data: {
                  walletId: wallet.id,
                  type: "DEPOSIT",
                  assetType: "NATIVE",
                  assetSymbol: "ETH",
                  from: tx.from || null,
                  to: tx.to || null,
                  amount: value.toString(),
                  txHash,
                  status: "CONFIRMED",
                },
              });
              depositsFound += 1;
              depositedAmount += value;
              console.log(`Deposit detected: ${txHash} -> ${wallet.address}`);
            }
          }
        }

        // ERC-20 transfer deposit (supports assets like USDC on Sepolia)
        if (!toAddress) continue;
        const decodedTransfer = decodeErc20Transfer(tx);
        if (!decodedTransfer) continue;
        if (decodedTransfer.to !== walletAddress) continue;

        const existingToken = await prisma.transaction.findFirst({
          where: {
            txHash,
            walletId: wallet.id,
            assetType: "ERC20",
            tokenAddress: tx.to || null,
          },
        });
        if (existingToken) continue;

        const tokenMetadata = await getTokenMetadata(toAddress, tokenMetadataCache);
        await prisma.transaction.create({
          data: {
            walletId: wallet.id,
            type: "DEPOSIT",
            assetType: "ERC20",
            assetSymbol: tokenMetadata.symbol,
            tokenAddress: tx.to,
            tokenDecimals: tokenMetadata.decimals,
            from: tx.from || null,
            to: decodedTransfer.to,
            amount: decodedTransfer.amount.toString(),
            txHash,
            status: "CONFIRMED",
          },
        });

        if (options?.creditWalletBalance && tx.to) {
          pendingErc20Credits.push({
            tokenAddress: tx.to,
            symbol: tokenMetadata.symbol,
            decimals: tokenMetadata.decimals,
            amount: decodedTransfer.amount,
          });
        }

        depositsFound += 1;
        console.log(
          `Token deposit detected: ${txHash} -> ${wallet.address} ${tokenMetadata.symbol}`
        );
      }
    }
  }

  // Apply all balance credits atomically under the advisory lock so they don't
  // race with concurrent sends or reconciliation runs.
  if (options?.creditWalletBalance && (depositedAmount > 0n || pendingErc20Credits.length > 0)) {
    const lockKey = `wallet-group:${wallet.walletGroupId}`;
    await withPgAdvisoryLock(lockKey, async (lockTx) => {
      if (depositedAmount > 0n) {
        const nativeAsset = await ensureNativeAsset(lockTx);
        const currentNative = await getWalletAssetBalance(wallet.id, nativeAsset.id, lockTx);
        await setWalletAssetBalance(wallet.id, nativeAsset.id, currentNative + depositedAmount, lockTx);
      }
      for (const credit of pendingErc20Credits) {
        const tokenAsset = await ensureErc20Asset(
          credit.tokenAddress,
          credit.symbol,
          credit.decimals,
          lockTx
        );
        const currentToken = await getWalletAssetBalance(wallet.id, tokenAsset.id, lockTx);
        await setWalletAssetBalance(wallet.id, tokenAsset.id, currentToken + credit.amount, lockTx);
      }
    });
  }

  await prisma.walletGroup.update({
    where: { id: wallet.walletGroupId },
    data: { lastSyncBlock: toBlock },
  });

  return {
    scannedFromBlock: fromBlock,
    scannedToBlock: toBlock,
    scannedBlocks: toBlock - fromBlock + 1,
    depositsFound,
    depositedAmount: depositedAmount.toString(),
  };
}

export async function detectDeposits(): Promise<DepositDetectionSummary> {
  const startedAt = Date.now();
  const walletGroups = await prisma.walletGroup.findMany({
    where: { wallets: { some: {} } },
    select: {
      id: true,
      address: true,
      lastSyncBlock: true,
      wallets: {
        select: {
          id: true,
          createdAt: true,
        },
      },
    },
  });

  if (walletGroups.length === 0) {
    return {
      currentBlock: await getFreshBlockNumber(),
      standardWalletsScanned: 0,
      groupKeysScanned: 0,
      depositsFound: 0,
      blocksFetched: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const currentBlock = await getFreshBlockNumber();
  const cache = new Map<number, ChainTxLike[]>();
  const tokenMetadataCache = new Map<string, TokenMetadata>();
  let depositsFound = 0;
  let standardWalletsScanned = 0;

  for (const group of walletGroups) {
    if (group.wallets.length === 0) continue;

    const primaryWallet = group.wallets.reduce((oldest, wallet) => {
      return wallet.createdAt < oldest.createdAt ? wallet : oldest;
    }, group.wallets[0]);

    if (group.wallets.length === 1) {
      standardWalletsScanned += 1;
    }

    const result = await processWalletDeposits(
      {
        id: primaryWallet.id,
        walletGroupId: group.id,
        address: group.address,
        lastSyncBlock: group.lastSyncBlock,
      },
      currentBlock,
      MAX_BLOCKS_PER_WALLET_PER_RUN,
      cache,
      tokenMetadataCache,
      { creditWalletBalance: true }
    );
    depositsFound += result.depositsFound;
  }

  return {
    currentBlock,
    standardWalletsScanned,
    groupKeysScanned: walletGroups.length,
    depositsFound,
    blocksFetched: cache.size,
    durationMs: Date.now() - startedAt,
  };
}

export async function detectDepositsForWallet(walletId: string, userId: string) {
  const wallet = await getAccessibleWallet(walletId, userId);
  if (!wallet) {
    throw new Error("Wallet not found");
  }

  const currentBlock = await getFreshBlockNumber();
  const cache = new Map<number, ChainTxLike[]>();
  const tokenMetadataCache = new Map<string, TokenMetadata>();
  const result = await processWalletDeposits(
    {
      id: wallet.id,
      walletGroupId: wallet.walletGroupId,
      address: wallet.walletGroup.address,
      lastSyncBlock: wallet.walletGroup.lastSyncBlock,
    },
    currentBlock,
    MAX_BLOCKS_PER_MANUAL_SYNC,
    cache,
    tokenMetadataCache,
    { creditWalletBalance: true }
  );

  return {
    ...result,
    currentBlock,
    partial: (result.scannedToBlock ?? currentBlock) < currentBlock,
  };
}

export async function syncAllDepositsForWallet(walletId: string, userId: string) {
  let totalDeposits = 0;
  let totalAmount = 0n;
  let currentBlock = 0;
  let scannedToBlock: number | null = null;
  let partial = false;
  let steps = 0;

  for (let i = 0; i < MAX_MANUAL_SYNC_STEPS; i++) {
    const step = await detectDepositsForWallet(walletId, userId);
    steps += 1;
    totalDeposits += step.depositsFound;
    totalAmount += BigInt(step.depositedAmount);
    currentBlock = step.currentBlock;
    scannedToBlock = step.scannedToBlock;
    partial = step.partial;

    if (!step.partial) {
      break;
    }
  }

  return {
    currentBlock,
    scannedToBlock,
    depositsFound: totalDeposits,
    depositedAmount: totalAmount.toString(),
    partial,
    steps,
  };
}

export async function detectDepositsForSharedKeyWallet(
  wallet: WalletSyncRecord
) {
  const currentBlock = await getFreshBlockNumber();
  const cache = new Map<number, ChainTxLike[]>();
  const tokenMetadataCache = new Map<string, TokenMetadata>();
  const result = await processWalletDeposits(
    wallet,
    currentBlock,
    MAX_BLOCKS_PER_MANUAL_SYNC,
    cache,
    tokenMetadataCache,
    { creditWalletBalance: true }
  );

  return {
    ...result,
    currentBlock,
    partial: (result.scannedToBlock ?? currentBlock) < currentBlock,
  };
}
