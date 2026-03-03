import { ethers } from "ethers";
import { Prisma } from "@prisma/client";
import { withPgAdvisoryLock } from "../lib/pgLock";
import { prisma } from "../lib/prisma";
import { broadcastSignedTransaction, provider } from "../lib/provider";
import {
  ensureErc20Asset,
  ensureNativeAsset,
  getWalletAssetBalance,
  setWalletAssetBalance,
} from "./assetService";
import {
  detectDepositsForWallet,
  syncAllDepositsForWallet,
} from "./depositDetector";
import {
  getAccessibleWallet,
  getWalletSigningContext,
} from "./walletService";

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function estimateGasCost(
  gasLimit: bigint,
  overrideGasPrice?: bigint
): Promise<{ gasCost: bigint; effectiveGasPrice: bigint }> {
  if (overrideGasPrice !== undefined) {
    return {
      gasCost: gasLimit * overrideGasPrice,
      effectiveGasPrice: overrideGasPrice,
    };
  }
  const feeData = await provider.getFeeData();
  const effectiveGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  return { gasCost: gasLimit * effectiveGasPrice, effectiveGasPrice };
}

function formatRequiredBalance(amount: bigint, gasCost: bigint) {
  return ethers.formatEther(amount + gasCost);
}

function getInsufficientBalanceMessage(
  amount: bigint,
  gasCost: bigint,
  available: bigint
) {
  return `Insufficient balance: need ${formatRequiredBalance(
    amount,
    gasCost
  )} ETH (amount + gas), have ${ethers.formatEther(available)} ETH`;
}

function getWalletLockKey(walletId: string, walletGroupId: string | null) {
  return walletGroupId ? `wallet-group:${walletGroupId}` : `wallet:${walletId}`;
}

function safeSubtract(balance: bigint, amount: bigint): bigint {
  if (amount <= 0n) return balance;
  return amount > balance ? 0n : balance - amount;
}

async function getNextNonce(
  tx: Prisma.TransactionClient,
  fromAddress: string
): Promise<number> {
  const chainPendingNonce = await provider.getTransactionCount(fromAddress, "pending");
  const maxReserved = await tx.transaction.aggregate({
    where: {
      from: fromAddress,
      status: {
        in: ["PENDING", "BROADCASTING"],
      },
      nonce: {
        not: null,
      },
    },
    _max: { nonce: true },
  });

  const dbNextNonce =
    maxReserved._max.nonce === null || maxReserved._max.nonce === undefined
      ? chainPendingNonce
      : maxReserved._max.nonce + 1;

  return Math.max(chainPendingNonce, dbNextNonce);
}

export async function sendTransaction(
  walletId: string,
  userId: string,
  to: string,
  amount: string,
  overrides?: { gasPrice?: bigint; nonce?: number }
) {
  const lockWallet = await getAccessibleWallet(walletId, userId);
  if (!lockWallet) {
    throw new Error("Wallet not found");
  }

  const lockKey = getWalletLockKey(lockWallet.id, lockWallet.walletGroupId);

  const result = await withPgAdvisoryLock(lockKey, async (tx) => {
    const { wallet, signer } = await getWalletSigningContext(walletId, userId);
    const weiAmount = ethers.parseEther(amount);

    const gasLimit = await provider.estimateGas({
      from: signer.address,
      to,
      value: weiAmount,
    });
    const { gasCost, effectiveGasPrice } = await estimateGasCost(
      gasLimit,
      overrides?.gasPrice
    );

    const onchainBalance = await provider.getBalance(signer.address);
    if (weiAmount + gasCost > onchainBalance) {
      throw new Error(
        getInsufficientBalanceMessage(weiAmount, gasCost, onchainBalance)
      );
    }

    const nativeAsset = await ensureNativeAsset(tx);
    const walletNativeBalance = await getWalletAssetBalance(
      wallet.id,
      nativeAsset.id,
      tx
    );
    const totalReserved = weiAmount + gasCost;
    if (totalReserved > walletNativeBalance) {
      throw new Error(
        getInsufficientBalanceMessage(weiAmount, gasCost, walletNativeBalance)
      );
    }

    // Reserve funds within the lock so concurrent sends see the reduced balance.
    await setWalletAssetBalance(
      wallet.id,
      nativeAsset.id,
      walletNativeBalance - totalReserved,
      tx
    );

    const txRecord = await tx.transaction.create({
      data: {
        walletId,
        type: "WITHDRAWAL",
        to,
        from: signer.address,
        amount: weiAmount.toString(),
        gasPrice: effectiveGasPrice.toString(),
        lockedAmount: totalReserved.toString(),
        status: "PENDING",
      },
    });

    try {
      const network = await provider.getNetwork();
      const nonce = overrides?.nonce ?? (await getNextNonce(tx, signer.address));
      const gasPrice = overrides?.gasPrice ?? effectiveGasPrice;
      const txParams: ethers.TransactionRequest = {
        to,
        value: weiAmount,
        gasLimit,
        nonce,
        chainId: network.chainId,
      };

      if (gasPrice > 0n) {
        txParams.gasPrice = gasPrice;
      }

      const signedTx = await signer.signTransaction(txParams);
      const txHash = await broadcastSignedTransaction(signedTx);

      await tx.transaction.update({
        where: { id: txRecord.id },
        data: { txHash, nonce, status: "BROADCASTING" },
      });

      return {
        txHash,
        transactionId: txRecord.id,
        nonce,
        status: "BROADCASTING" as const,
      };
    } catch (err: any) {
      // Broadcast failed before any on-chain effect — restore the reserved balance.
      await setWalletAssetBalance(wallet.id, nativeAsset.id, walletNativeBalance, tx);
      await tx.transaction.update({
        where: { id: txRecord.id },
        data: { status: "FAILED" },
      });
      return {
        error: `Transaction failed: ${err.message}`,
      } as const;
    }
  });

  if ("error" in result) {
    throw new Error(result.error);
  }

  return result;
}

export async function sendERC20Transaction(
  walletId: string,
  userId: string,
  to: string,
  tokenAddress: string,
  amount: string,
  overrides?: { gasPrice?: bigint; nonce?: number }
) {
  const lockWallet = await getAccessibleWallet(walletId, userId);
  if (!lockWallet) {
    throw new Error("Wallet not found");
  }

  const lockKey = getWalletLockKey(lockWallet.id, lockWallet.walletGroupId);

  const result = await withPgAdvisoryLock(lockKey, async (tx) => {
    const { wallet, signer } = await getWalletSigningContext(walletId, userId);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
    const tokenAmount = ethers.parseUnits(amount, decimals);

    const tokenBalance = await token.balanceOf(signer.address);
    if (tokenAmount > tokenBalance) {
      throw new Error(
        `Insufficient token balance: need ${amount}, have ${ethers.formatUnits(
          tokenBalance,
          decimals
        )}`
      );
    }

    const gasLimit = await token.transfer.estimateGas(to, tokenAmount);
    const { gasCost, effectiveGasPrice } = await estimateGasCost(
      gasLimit,
      overrides?.gasPrice
    );

    const onchainBalance = await provider.getBalance(signer.address);
    if (gasCost > onchainBalance) {
      throw new Error(
        `Insufficient ETH for gas: need ${ethers.formatEther(
          gasCost
        )} ETH, have ${ethers.formatEther(onchainBalance)} ETH`
      );
    }

    const nativeAsset = await ensureNativeAsset(tx);
    const walletNativeBalance = await getWalletAssetBalance(
      wallet.id,
      nativeAsset.id,
      tx
    );
    if (gasCost > walletNativeBalance) {
      throw new Error(
        `Insufficient ETH for gas: need ${ethers.formatEther(
          gasCost
        )} ETH, have ${ethers.formatEther(walletNativeBalance)} ETH`
      );
    }

    const trackedTokenAsset = await tx.asset.findFirst({
      where: {
        contractAddress: ethers.getAddress(tokenAddress),
      },
    });
    if (!trackedTokenAsset) {
      throw new Error("Token not tracked for this wallet");
    }

    const walletTokenBalance = await getWalletAssetBalance(
      wallet.id,
      trackedTokenAsset.id,
      tx
    );
    if (tokenAmount > walletTokenBalance) {
      throw new Error(
        `Insufficient token balance: need ${amount}, have ${ethers.formatUnits(
          walletTokenBalance,
          decimals
        )}`
      );
    }

    // Reserve gas cost within the lock so concurrent sends see the reduced balance.
    await setWalletAssetBalance(
      wallet.id,
      nativeAsset.id,
      walletNativeBalance - gasCost,
      tx
    );

    const txRecord = await tx.transaction.create({
      data: {
        walletId,
        type: "WITHDRAWAL",
        assetType: "ERC20",
        assetSymbol: symbol,
        tokenAddress,
        tokenDecimals: Number(decimals),
        to,
        from: signer.address,
        amount: tokenAmount.toString(),
        gasPrice: effectiveGasPrice.toString(),
        lockedAmount: gasCost.toString(),
        status: "PENDING",
      },
    });

    try {
      const network = await provider.getNetwork();
      const nonce = overrides?.nonce ?? (await getNextNonce(tx, signer.address));
      const gasPrice = overrides?.gasPrice ?? effectiveGasPrice;
      const data = token.interface.encodeFunctionData("transfer", [to, tokenAmount]);

      const txParams: ethers.TransactionRequest = {
        to: tokenAddress,
        data,
        value: 0n,
        gasLimit,
        nonce,
        chainId: network.chainId,
      };

      if (gasPrice > 0n) {
        txParams.gasPrice = gasPrice;
      }

      const signedTx = await signer.signTransaction(txParams);
      const txHash = await broadcastSignedTransaction(signedTx);

      await tx.transaction.update({
        where: { id: txRecord.id },
        data: { txHash, nonce, status: "BROADCASTING" },
      });

      return {
        txHash,
        transactionId: txRecord.id,
        nonce,
        status: "BROADCASTING" as const,
      };
    } catch (err: any) {
      // Broadcast failed — restore the reserved gas balance.
      await setWalletAssetBalance(wallet.id, nativeAsset.id, walletNativeBalance, tx);
      await tx.transaction.update({
        where: { id: txRecord.id },
        data: { status: "FAILED" },
      });
      return {
        error: `ERC20 transaction failed: ${err.message}`,
      } as const;
    }
  });

  if ("error" in result) {
    throw new Error(result.error);
  }

  return result;
}

export async function sendAssetTransaction(
  walletId: string,
  userId: string,
  to: string,
  amount: string,
  assetId: string,
  overrides?: { gasPrice?: bigint; nonce?: number }
) {
  const wallet = await getAccessibleWallet(walletId, userId);
  if (!wallet) {
    throw new Error("Wallet not found");
  }

  const assetRow = await prisma.walletAssetBalance.findFirst({
    where: { walletId, assetId },
    include: { asset: true },
  });

  if (!assetRow) {
    throw new Error("Asset not found in wallet");
  }

  if (assetRow.asset.type === "NATIVE") {
    return sendTransaction(walletId, userId, to, amount, overrides);
  }

  const tokenAddress = assetRow.asset.contractAddress;
  if (!tokenAddress) {
    throw new Error("ERC20 asset is missing contract address");
  }

  return sendERC20Transaction(walletId, userId, to, tokenAddress, amount, overrides);
}

export async function getMaxSendAmount(
  walletId: string,
  userId: string,
  assetId: string,
  to?: string
) {
  const wallet = await getAccessibleWallet(walletId, userId);
  if (!wallet) {
    throw new Error("Wallet not found");
  }

  const assetRow = await prisma.walletAssetBalance.findFirst({
    where: { walletId, assetId },
    include: { asset: true },
  });

  if (!assetRow) {
    throw new Error("Asset not found in wallet");
  }

  const assetBalance = BigInt(assetRow.balance);

  if (assetRow.asset.type === "ERC20") {
    return {
      assetId: assetRow.assetId,
      assetType: "ERC20" as const,
      symbol: assetRow.asset.symbol,
      decimals: assetRow.asset.decimals,
      balance: assetRow.balance,
      formattedBalance: ethers.formatUnits(assetBalance, assetRow.asset.decimals),
      maxAmount: assetRow.balance,
      formattedMax: ethers.formatUnits(assetBalance, assetRow.asset.decimals),
      estimatedGasFee: "0",
      estimatedGasFeeFormatted: "0",
    };
  }

  const { signer } = await getWalletSigningContext(walletId, userId);
  const recipient = to && ethers.isAddress(to) ? to : signer.address;

  let gasLimit = 21_000n;
  try {
    gasLimit = await provider.estimateGas({
      from: signer.address,
      to: recipient,
      value: 0n,
    });
  } catch {
    gasLimit = 21_000n;
  }

  const { gasCost } = await estimateGasCost(gasLimit);
  const onchainBalance = await provider.getBalance(signer.address);
  const spendableBalance = assetBalance < onchainBalance ? assetBalance : onchainBalance;
  const maxAmount = spendableBalance > gasCost ? spendableBalance - gasCost : 0n;

  return {
    assetId: assetRow.assetId,
    assetType: "NATIVE" as const,
    symbol: assetRow.asset.symbol,
    decimals: assetRow.asset.decimals,
    balance: assetRow.balance,
    formattedBalance: ethers.formatEther(assetBalance),
    maxAmount: maxAmount.toString(),
    formattedMax: ethers.formatEther(maxAmount),
    estimatedGasFee: gasCost.toString(),
    estimatedGasFeeFormatted: ethers.formatEther(gasCost),
  };
}

export async function replaceByFee(
  walletId: string,
  userId: string,
  originalTxId: string,
  newGasPrice: bigint
) {
  const original = await prisma.transaction.findFirst({
    where: {
      id: originalTxId,
      walletId,
      wallet: {
        OR: [{ ownerId: userId }, { accesses: { some: { userId } } }],
      },
    },
  });

  if (!original) {
    throw new Error("Original transaction not found");
  }

  if (original.nonce === null) {
    throw new Error("Original transaction has no nonce");
  }

  const oldGasPrice = BigInt(original.gasPrice || "0");
  if (newGasPrice <= oldGasPrice) {
    throw new Error("New gas price must be higher than original for RBF");
  }

  const result = await sendTransaction(
    walletId,
    userId,
    original.to!,
    ethers.formatEther(original.amount),
    { gasPrice: newGasPrice, nonce: original.nonce }
  );

  await prisma.transaction.update({
    where: { id: originalTxId },
    data: { status: "FAILED" },
  });

  return result;
}

// Simple in-process reconciliation guard for interview scope.
// Limitation: if the API runs multiple replicas, each instance may reconcile.
// Production design should use a durable queue + worker leases/distributed locks.
let isReconcilingBroadcasts = false;

type BroadcastingTxRecord = {
  id: string;
  txHash: string | null;
  walletId: string;
  type: "DEPOSIT" | "WITHDRAWAL" | "INTERNAL" | "CONTRACT";
  from: string | null;
  status: "BROADCASTING";
  assetType: "NATIVE" | "ERC20";
  tokenAddress: string | null;
  tokenDecimals: number | null;
  assetSymbol: string;
  amount: string;
  lockedAmount: string;
};

const ERC20_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

function parseIndexedAddress(topic: string): string | null {
  if (typeof topic !== "string" || topic.length !== 66) {
    return null;
  }
  try {
    return ethers.getAddress(`0x${topic.slice(26)}`);
  } catch {
    return null;
  }
}

function collectErc20NetDeltasForAddress(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  address: string
): Map<string, bigint> {
  const target = address.toLowerCase();
  const deltas = new Map<string, bigint>();

  for (const log of logs) {
    if (!log?.address || !ethers.isAddress(log.address)) continue;
    if (!Array.isArray(log.topics) || log.topics.length < 3) continue;
    if (log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase()) continue;

    const fromAddress = parseIndexedAddress(log.topics[1]);
    const toAddress = parseIndexedAddress(log.topics[2]);
    if (!fromAddress && !toAddress) continue;

    let amount: bigint;
    try {
      amount = BigInt(log.data);
    } catch {
      continue;
    }
    if (amount === 0n) continue;

    let delta = 0n;
    if (fromAddress?.toLowerCase() === target) {
      delta -= amount;
    }
    if (toAddress?.toLowerCase() === target) {
      delta += amount;
    }
    if (delta === 0n) continue;

    const tokenAddress = ethers.getAddress(log.address);
    deltas.set(tokenAddress, (deltas.get(tokenAddress) || 0n) + delta);
  }

  return deltas;
}

async function ensureTokenAssetFromChain(
  tokenAddress: string,
  tx?: Prisma.TransactionClient
) {
  const normalized = ethers.getAddress(tokenAddress);
  const db = tx ?? prisma;

  const existing = await db.asset.findFirst({
    where: { contractAddress: normalized },
  });
  if (existing) {
    return existing;
  }

  const token = new ethers.Contract(normalized, ERC20_ABI, provider);
  let symbol = "ERC20";
  let decimals = 18;
  try {
    const [chainSymbol, chainDecimals] = await Promise.all([
      token.symbol(),
      token.decimals(),
    ]);
    if (typeof chainSymbol === "string" && chainSymbol.trim()) {
      symbol = chainSymbol.trim();
    }
    const parsedDecimals = Number(chainDecimals);
    if (!Number.isNaN(parsedDecimals)) {
      decimals = parsedDecimals;
    }
  } catch {
    // Fall back to generic metadata if token metadata calls fail.
  }

  return ensureErc20Asset(normalized, symbol, decimals, tx);
}

async function applyContractTokenDeltasFromReceipt(
  txRecord: BroadcastingTxRecord,
  receipt: ethers.TransactionReceipt,
  tx?: Prisma.TransactionClient
) {
  if (txRecord.type !== "CONTRACT" || !txRecord.from || !ethers.isAddress(txRecord.from)) {
    return;
  }

  const actor = ethers.getAddress(txRecord.from);
  const tokenDeltas = collectErc20NetDeltasForAddress(receipt.logs, actor);

  for (const [tokenAddress, delta] of tokenDeltas.entries()) {
    if (delta === 0n) continue;
    const tokenAsset = await ensureTokenAssetFromChain(tokenAddress, tx);
    const current = await getWalletAssetBalance(txRecord.walletId, tokenAsset.id, tx);
    const next = current + delta;

    if (next < 0n) {
      console.warn(
        `[reconcile] Contract delta underflow walletId=${txRecord.walletId} token=${tokenAddress} current=${current.toString()} delta=${delta.toString()}`
      );
      await setWalletAssetBalance(txRecord.walletId, tokenAsset.id, 0n, tx);
      continue;
    }

    await setWalletAssetBalance(txRecord.walletId, tokenAsset.id, next, tx);
  }
}

async function reconcileBroadcastingRecord(
  txRecord: BroadcastingTxRecord,
  lockKey: string
): Promise<boolean> {
  if (!txRecord.txHash) return false;

  // Fetch on-chain data OUTSIDE the advisory lock so we don't hold the
  // Prisma transaction open during potentially slow network calls.
  const receipt = await provider.getTransactionReceipt(txRecord.txHash);
  if (!receipt) {
    return false;
  }

  const chainTx = await provider.getTransaction(txRecord.txHash);
  const gasPrice = receipt.gasPrice ?? chainTx?.gasPrice ?? 0n;
  const gasCost = receipt.gasUsed * gasPrice;
  const value = chainTx?.value ?? 0n;
  const isSuccess = receipt.status === 1;

  // Acquire advisory lock for the balance update + status flip.
  // Re-check status under the lock to handle concurrent reconcilers.
  await withPgAdvisoryLock(lockKey, async (tx) => {
    const fresh = await tx.transaction.findUnique({
      where: { id: txRecord.id },
      select: { status: true, lockedAmount: true },
    });
    if (!fresh || fresh.status !== "BROADCASTING") return;

    // Restore the amount that was reserved at send time, then apply the
    // actual on-chain cost. This handles estimated-vs-actual gas differences.
    const lockedAmount = BigInt(fresh.lockedAmount ?? "0");
    const nativeAsset = await ensureNativeAsset(tx);
    const currentNative = await getWalletAssetBalance(txRecord.walletId, nativeAsset.id, tx);
    const restoredNative = currentNative + lockedAmount;
    const nativeDebit = gasCost + (txRecord.assetType === "NATIVE" && isSuccess ? value : 0n);
    const nextNative = safeSubtract(restoredNative, nativeDebit);
    await setWalletAssetBalance(txRecord.walletId, nativeAsset.id, nextNative, tx);

    if (txRecord.assetType === "ERC20" && isSuccess && txRecord.tokenAddress) {
      const tokenAsset = await ensureErc20Asset(
        txRecord.tokenAddress,
        txRecord.assetSymbol || "ERC20",
        txRecord.tokenDecimals ?? 18,
        tx
      );
      const currentToken = await getWalletAssetBalance(txRecord.walletId, tokenAsset.id, tx);
      const nextToken = safeSubtract(currentToken, BigInt(txRecord.amount));
      await setWalletAssetBalance(txRecord.walletId, tokenAsset.id, nextToken, tx);
    }

    if (isSuccess) {
      await applyContractTokenDeltasFromReceipt(txRecord, receipt, tx);
    }

    await tx.transaction.update({
      where: { id: txRecord.id },
      data: { status: isSuccess ? "CONFIRMED" : "FAILED" },
    });
  });

  return true;
}

export async function reconcileBroadcastingTransactions(limit = 100) {
  if (isReconcilingBroadcasts) {
    return;
  }

  isReconcilingBroadcasts = true;
  try {
    const broadcasting = await prisma.transaction.findMany({
      where: {
        status: "BROADCASTING",
        txHash: { not: null },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      include: { wallet: true },
    });

    for (const txRecord of broadcasting) {
      try {
        const lockKey = txRecord.wallet?.walletGroupId
          ? `wallet-group:${txRecord.wallet.walletGroupId}`
          : `wallet:${txRecord.walletId}`;
        await reconcileBroadcastingRecord(txRecord as BroadcastingTxRecord, lockKey);
      } catch (err) {
        console.error(
          `Failed to reconcile transaction ${txRecord.id} (${txRecord.txHash}):`,
          err
        );
      }
    }
  } finally {
    isReconcilingBroadcasts = false;
  }
}

export async function reconcileBroadcastingTransactionsForWallet(
  walletId: string,
  userId: string,
  limit = 100
) {
  const wallet = await getAccessibleWallet(walletId, userId);
  if (!wallet) {
    throw new Error("Wallet not found");
  }

  return reconcileBroadcastingTransactionsForWalletId(walletId, limit);
}

async function reconcileBroadcastingTransactionsForWalletId(
  walletId: string,
  limit = 100
) {
  const broadcasting = await prisma.transaction.findMany({
    where: {
      walletId,
      status: "BROADCASTING",
      txHash: { not: null },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: { wallet: true },
  });

  let reconciledCount = 0;
  for (const txRecord of broadcasting) {
    try {
      const lockKey = txRecord.wallet?.walletGroupId
        ? `wallet-group:${txRecord.wallet.walletGroupId}`
        : `wallet:${txRecord.walletId}`;
      const reconciled = await reconcileBroadcastingRecord(
        txRecord as BroadcastingTxRecord,
        lockKey
      );
      if (reconciled) reconciledCount += 1;
    } catch (err) {
      console.error(
        `Failed to reconcile transaction ${txRecord.id} (${txRecord.txHash}) for wallet ${walletId}:`,
        err
      );
    }
  }

  return reconciledCount;
}

export async function syncWalletOnChainState(walletId: string, userId: string) {
  const wallet = await getAccessibleWallet(walletId, userId);
  if (!wallet) {
    throw new Error("Wallet not found");
  }

  const reconciledCount = await reconcileBroadcastingTransactionsForWallet(
    walletId,
    userId,
    200
  );

  const depositSync = await syncAllDepositsForWallet(walletId, userId);
  const updatedWallet = await getAccessibleWallet(walletId, userId);

  return {
    wallet: updatedWallet,
    reconciledCount,
    depositSync,
  };
}

export async function internalTransfer(
  fromWalletId: string,
  toWalletId: string,
  userId: string,
  amount: string,
  assetId?: string
) {
  const fromWallet = await getAccessibleWallet(fromWalletId, userId);
  const toWallet = await getAccessibleWallet(toWalletId, userId);

  if (!fromWallet || !toWallet) {
    throw new Error("Both wallets must belong to the user or be shared with the user");
  }

  if (!fromWallet.walletGroupId || !toWallet.walletGroupId) {
    throw new Error("Both wallets must be in a wallet group");
  }

  if (fromWallet.walletGroupId !== toWallet.walletGroupId) {
    throw new Error("Both wallets must share the same wallet group");
  }

  if (fromWallet.id === toWallet.id) {
    throw new Error("Source and destination wallets must be different");
  }

  const lockKey = getWalletLockKey(fromWallet.id, fromWallet.walletGroupId);

  return withPgAdvisoryLock(lockKey, async (tx) => {
    const freshFrom = await getAccessibleWallet(fromWalletId, userId);
    const freshTo = await getAccessibleWallet(toWalletId, userId);
    if (!freshFrom || !freshTo) {
      throw new Error("Wallet access changed during transfer");
    }

    const nativeAsset = await ensureNativeAsset(tx);
    const selectedAsset = assetId
      ? await tx.walletAssetBalance.findFirst({
          where: { walletId: fromWalletId, assetId },
          include: { asset: true },
        })
      : null;

    if (assetId && !selectedAsset) {
      throw new Error("Asset not found in source wallet");
    }

    const transferAsset = selectedAsset?.asset ?? nativeAsset;
    const parsedAmount =
      transferAsset.type === "NATIVE"
        ? ethers.parseEther(amount)
        : ethers.parseUnits(amount, transferAsset.decimals);
    const fromBalance = await getWalletAssetBalance(fromWalletId, transferAsset.id, tx);

    if (fromBalance < parsedAmount) {
      throw new Error("Insufficient balance in source wallet");
    }

    const assetTxFields =
      transferAsset.type === "ERC20"
        ? {
            assetType: "ERC20" as const,
            assetSymbol: transferAsset.symbol,
            tokenAddress: transferAsset.contractAddress,
            tokenDecimals: transferAsset.decimals,
          }
        : {};

    const debit = await tx.transaction.create({
      data: {
        walletId: fromWalletId,
        type: "WITHDRAWAL",
        to: freshTo.address,
        from: freshFrom.address,
        amount: parsedAmount.toString(),
        txHash: null,
        gasPrice: "0",
        status: "CONFIRMED",
        ...assetTxFields,
      },
    });
    const credit = await tx.transaction.create({
      data: {
        walletId: toWalletId,
        type: "DEPOSIT",
        to: freshTo.address,
        from: freshFrom.address,
        amount: parsedAmount.toString(),
        txHash: null,
        gasPrice: "0",
        status: "CONFIRMED",
        ...assetTxFields,
      },
    });
    await setWalletAssetBalance(
      fromWalletId,
      transferAsset.id,
      fromBalance - parsedAmount,
      tx
    );
    const toBalance = await getWalletAssetBalance(toWalletId, transferAsset.id, tx);
    await setWalletAssetBalance(toWalletId, transferAsset.id, toBalance + parsedAmount, tx);

    return { debitTxId: debit.id, creditTxId: credit.id };
  });
}

export async function getWalletTransactions(walletId: string, userId: string) {
  const wallet = await getAccessibleWallet(walletId, userId);
  if (!wallet) {
    throw new Error("Wallet not found");
  }

  return prisma.transaction.findMany({
    where: { walletId },
    orderBy: { createdAt: "desc" },
  });
}
