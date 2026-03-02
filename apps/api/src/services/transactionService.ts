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
  detectDepositsForSharedKeyWallet,
  detectDepositsForWallet,
} from "./depositDetector";
import {
  getAccessibleWallet,
  getWalletGroupById,
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
    return { gasCost: gasLimit * overrideGasPrice, effectiveGasPrice: overrideGasPrice };
  }
  const feeData = await provider.getFeeData();
  const effectiveGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  return { gasCost: gasLimit * effectiveGasPrice, effectiveGasPrice };
}

function formatRequiredBalance(amount: bigint, gasCost: bigint) {
  return ethers.formatEther(amount + gasCost);
}

function getInsufficientBalanceMessage(amount: bigint, gasCost: bigint, available: bigint) {
  return `Insufficient balance: need ${formatRequiredBalance(
    amount,
    gasCost
  )} ETH (amount + gas), have ${ethers.formatEther(available)} ETH`;
}

function getWalletLockKey(walletId: string, walletGroupId: string | null) {
  return walletGroupId ? `wallet-group:${walletGroupId}` : `wallet:${walletId}`;
}

async function getNonCustodialWalletById(walletId: string) {
  return prisma.wallet.findFirst({
    where: {
      id: walletId,
      walletGroup: { custodyType: "NON_CUSTODIAL" },
    },
    include: { walletGroup: true },
  });
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
    if (weiAmount + gasCost > walletNativeBalance) {
      throw new Error(
        getInsufficientBalanceMessage(weiAmount, gasCost, walletNativeBalance)
      );
    }

    const txRecord = await tx.transaction.create({
      data: {
        walletId,
        type: "WITHDRAWAL",
        to,
        from: signer.address,
        amount: weiAmount.toString(),
        gasPrice: effectiveGasPrice.toString(),
        status: "PENDING",
      },
    });

    try {
      const network = await provider.getNetwork();
      const nonce =
        overrides?.nonce ?? (await getNextNonce(tx, signer.address));
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
        status: "PENDING",
      },
    });

    try {
      const network = await provider.getNetwork();
      const nonce = overrides?.nonce ?? (await getNextNonce(tx, signer.address));
      const gasPrice = overrides?.gasPrice ?? effectiveGasPrice;
      const data = token.interface.encodeFunctionData("transfer", [
        to,
        tokenAmount,
      ]);

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
    // Fallback for estimate failures (e.g. contract recipient without payable fallback).
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

export async function getMaxSendAmountForConnectedWallet(
  walletId: string,
  assetId: string,
  to?: string
) {
  const wallet = await getNonCustodialWalletById(walletId);
  if (!wallet) {
    throw new Error("Connected wallet not found");
  }

  const assetRow = await prisma.walletAssetBalance.findFirst({
    where: { walletId, assetId },
    include: { asset: true },
  });

  if (!assetRow) {
    throw new Error("Asset not found in wallet");
  }

  if (assetRow.asset.type === "ERC20") {
    if (!assetRow.asset.contractAddress) {
      throw new Error("ERC20 asset is missing contract address");
    }
    const token = new ethers.Contract(
      assetRow.asset.contractAddress,
      [
        "function balanceOf(address owner) view returns (uint256)",
      ],
      provider
    );
    const chainTokenBalance = BigInt(
      (await token.balanceOf(wallet.walletGroup.address)).toString()
    );
    await setWalletAssetBalance(walletId, assetRow.assetId, chainTokenBalance);

    return {
      assetId: assetRow.assetId,
      assetType: "ERC20" as const,
      symbol: assetRow.asset.symbol,
      decimals: assetRow.asset.decimals,
      balance: chainTokenBalance.toString(),
      formattedBalance: ethers.formatUnits(chainTokenBalance, assetRow.asset.decimals),
      maxAmount: chainTokenBalance.toString(),
      formattedMax: ethers.formatUnits(chainTokenBalance, assetRow.asset.decimals),
      estimatedGasFee: "0",
      estimatedGasFeeFormatted: "0",
    };
  }

  const chainNativeBalance = await provider.getBalance(wallet.walletGroup.address);
  await setWalletAssetBalance(walletId, assetRow.assetId, chainNativeBalance);
  const recipient = to && ethers.isAddress(to) ? to : wallet.walletGroup.address;

  let gasLimit = 21_000n;
  try {
    gasLimit = await provider.estimateGas({
      from: wallet.walletGroup.address,
      to: recipient,
      value: 0n,
    });
  } catch {
    gasLimit = 21_000n;
  }

  const { gasCost } = await estimateGasCost(gasLimit);
  const maxAmount = chainNativeBalance > gasCost ? chainNativeBalance - gasCost : 0n;

  return {
    assetId: assetRow.assetId,
    assetType: "NATIVE" as const,
    symbol: assetRow.asset.symbol,
    decimals: assetRow.asset.decimals,
    balance: chainNativeBalance.toString(),
    formattedBalance: ethers.formatEther(chainNativeBalance),
    maxAmount: maxAmount.toString(),
    formattedMax: ethers.formatEther(maxAmount),
    estimatedGasFee: gasCost.toString(),
    estimatedGasFeeFormatted: ethers.formatEther(gasCost),
  };
}

export async function registerConnectedWalletBroadcastTx(
  walletId: string,
  input: {
    txHash: string;
    to?: string;
    amount: string;
    assetId?: string;
    nonce?: number;
  }
) {
  const wallet = await getNonCustodialWalletById(walletId);
  if (!wallet) {
    throw new Error("Connected wallet not found");
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(input.txHash)) {
    throw new Error("Invalid txHash");
  }

  if (!input.amount || typeof input.amount !== "string") {
    throw new Error("amount is required");
  }

  const existingTx = await prisma.transaction.findFirst({
    where: {
      walletId,
      txHash: input.txHash,
    },
  });
  if (existingTx) {
    return {
      transactionId: existingTx.id,
      txHash: existingTx.txHash,
      status: existingTx.status,
    };
  }

  let assetRow = input.assetId
    ? await prisma.walletAssetBalance.findFirst({
        where: { walletId, assetId: input.assetId },
        include: { asset: true },
      })
    : null;

  if (input.assetId && !assetRow) {
    throw new Error("Asset not found in wallet");
  }

  if (!assetRow) {
    const nativeAsset = await ensureNativeAsset();
    await setWalletAssetBalance(walletId, nativeAsset.id, await getWalletAssetBalance(walletId, nativeAsset.id));
    assetRow = await prisma.walletAssetBalance.findFirst({
      where: { walletId, assetId: nativeAsset.id },
      include: { asset: true },
    });
  }

  if (!assetRow) {
    throw new Error("Unable to initialize native asset for connected wallet");
  }

  const normalizedAddress = ethers.getAddress(wallet.walletGroup.address);
  const chainTx = await provider.getTransaction(input.txHash);
  if (chainTx?.from && ethers.getAddress(chainTx.from) !== normalizedAddress) {
    throw new Error("Transaction sender does not match connected wallet");
  }

  const parsedAmount =
    assetRow.asset.type === "NATIVE"
      ? ethers.parseEther(input.amount)
      : ethers.parseUnits(input.amount, assetRow.asset.decimals);

  const txRecord = await prisma.transaction.create({
    data: {
      walletId,
      type: "WITHDRAWAL",
      assetType: assetRow.asset.type,
      assetSymbol: assetRow.asset.symbol,
      tokenAddress: assetRow.asset.contractAddress,
      tokenDecimals: assetRow.asset.type === "ERC20" ? assetRow.asset.decimals : null,
      to: chainTx?.to || input.to || null,
      from: normalizedAddress,
      amount: parsedAmount.toString(),
      txHash: input.txHash,
      nonce: input.nonce ?? chainTx?.nonce ?? null,
      gasPrice: chainTx?.gasPrice?.toString() || "0",
      status: "BROADCASTING",
    },
  });

  return {
    transactionId: txRecord.id,
    txHash: txRecord.txHash,
    status: txRecord.status,
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
  status: "BROADCASTING";
  assetType: "NATIVE" | "ERC20";
  tokenAddress: string | null;
  tokenDecimals: number | null;
  assetSymbol: string;
  amount: string;
};

async function reconcileBroadcastingRecord(
  txRecord: BroadcastingTxRecord
): Promise<boolean> {
  if (!txRecord.txHash) return false;

  const receipt = await provider.getTransactionReceipt(txRecord.txHash);
  if (!receipt) {
    return false;
  }

  const chainTx = await provider.getTransaction(txRecord.txHash);
  const gasPrice =
    receipt.gasPrice ??
    chainTx?.gasPrice ??
    0n;
  const gasCost = receipt.gasUsed * gasPrice;
  const value = chainTx?.value ?? 0n;
  const isSuccess = receipt.status === 1;

  const nativeAsset = await ensureNativeAsset();
  const currentNative = await getWalletAssetBalance(txRecord.walletId, nativeAsset.id);
  const nativeDebit = gasCost + (txRecord.assetType === "NATIVE" && isSuccess ? value : 0n);
  const nextNative = safeSubtract(currentNative, nativeDebit);
  await setWalletAssetBalance(txRecord.walletId, nativeAsset.id, nextNative);

  if (txRecord.assetType === "ERC20" && isSuccess && txRecord.tokenAddress) {
    const tokenAsset = await ensureErc20Asset(
      txRecord.tokenAddress,
      txRecord.assetSymbol || "ERC20",
      txRecord.tokenDecimals ?? 18
    );
    const currentToken = await getWalletAssetBalance(txRecord.walletId, tokenAsset.id);
    const nextToken = safeSubtract(currentToken, BigInt(txRecord.amount));
    await setWalletAssetBalance(txRecord.walletId, tokenAsset.id, nextToken);
  }

  await prisma.transaction.updateMany({
    where: {
      id: txRecord.id,
      status: "BROADCASTING",
    },
    data: { status: isSuccess ? "CONFIRMED" : "FAILED" },
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
        await reconcileBroadcastingRecord(txRecord as BroadcastingTxRecord);
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
      const reconciled = await reconcileBroadcastingRecord(
        txRecord as BroadcastingTxRecord
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

  const depositSync = await detectDepositsForWallet(walletId, userId);
  const updatedWallet = await getAccessibleWallet(walletId, userId);

  return {
    wallet: updatedWallet,
    reconciledCount,
    depositSync,
  };
}

export async function syncConnectedWalletOnChainState(walletId: string) {
  const wallet = await getNonCustodialWalletById(walletId);
  if (!wallet) {
    throw new Error("Connected wallet not found");
  }

  const reconciledCount = await reconcileBroadcastingTransactionsForWalletId(
    walletId,
    200
  );

  const depositSync = await detectDepositsForSharedKeyWallet({
    walletGroupId: wallet.walletGroupId,
    id: wallet.id,
    address: wallet.walletGroup.address,
    lastSyncBlock: wallet.walletGroup.lastSyncBlock,
  });

  return {
    reconciledCount,
    depositSync,
  };
}

export async function syncWalletGroupOnChainState(
  walletGroupId: string,
  userId: string
) {
  const walletGroup = await getWalletGroupById(walletGroupId, userId);
  if (!walletGroup) {
    throw new Error("Wallet group not found");
  }

  const groupWallets = walletGroup.wallets;
  if (groupWallets.length === 0) {
    throw new Error("Wallet group has no wallets");
  }

  const primaryWallet = groupWallets.reduce(
    (
      oldest: (typeof groupWallets)[number],
      wallet: (typeof groupWallets)[number]
    ) => {
    return wallet.createdAt < oldest.createdAt ? wallet : oldest;
    },
    groupWallets[0]
  );

  const lockKey = `wallet-group:${walletGroupId}`;

  return withPgAdvisoryLock(lockKey, async () => {
    const broadcasting = await prisma.transaction.findMany({
      where: {
        status: "BROADCASTING",
        txHash: { not: null },
        wallet: { walletGroupId },
      },
      orderBy: { createdAt: "asc" },
      take: 500,
      include: { wallet: true },
    });

    let reconciledCount = 0;
    for (const txRecord of broadcasting) {
      try {
        const reconciled = await reconcileBroadcastingRecord(
          txRecord as BroadcastingTxRecord
        );
        if (reconciled) reconciledCount += 1;
      } catch (err) {
        console.error(
          `Failed to reconcile transaction ${txRecord.id} (${txRecord.txHash}) for wallet group ${walletGroupId}:`,
          err
        );
      }
    }

    const depositSync = await detectDepositsForSharedKeyWallet({
      walletGroupId,
      id: primaryWallet.id,
      address: walletGroup.address,
      lastSyncBlock: walletGroup.lastSyncBlock,
    });

    const refreshedWalletGroup = await getWalletGroupById(walletGroupId, userId);

    return {
      walletGroup: refreshedWalletGroup,
      primaryWalletId: primaryWallet.id,
      reconciledCount,
      depositSync,
    };
  });
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
    const fromBalance = await getWalletAssetBalance(
      fromWalletId,
      transferAsset.id,
      tx
    );

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

export async function getConnectedWalletTransactions(walletId: string) {
  const wallet = await getNonCustodialWalletById(walletId);
  if (!wallet) {
    throw new Error("Connected wallet not found");
  }

  return prisma.transaction.findMany({
    where: { walletId },
    orderBy: { createdAt: "desc" },
  });
}
