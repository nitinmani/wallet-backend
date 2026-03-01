import { ethers } from "ethers";
import { withKeyMutex } from "../lib/keyMutex";
import { prisma } from "../lib/prisma";
import { broadcastSignedTransaction, provider } from "../lib/provider";
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

function safeSubtract(balance: bigint, amount: bigint): bigint {
  if (amount <= 0n) return balance;
  return amount > balance ? 0n : balance - amount;
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

  return withKeyMutex(lockKey, async () => {
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

    if (wallet.walletGroupId) {
      const walletBalance = BigInt(wallet.balance);
      if (weiAmount + gasCost > walletBalance) {
        throw new Error(
          getInsufficientBalanceMessage(weiAmount, gasCost, walletBalance)
        );
      }
    }

    const txRecord = await prisma.transaction.create({
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
        overrides?.nonce ??
        (await provider.getTransactionCount(signer.address, "pending"));
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

      await prisma.transaction.update({
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
      await prisma.transaction.update({
        where: { id: txRecord.id },
        data: { status: "FAILED" },
      });
      throw new Error(`Transaction failed: ${err.message}`);
    }
  });
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

  return withKeyMutex(lockKey, async () => {
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

    if (wallet.walletGroupId) {
      const walletBalance = BigInt(wallet.balance);
      if (gasCost > walletBalance) {
        throw new Error(
          `Insufficient ETH for gas: need ${ethers.formatEther(
            gasCost
          )} ETH, have ${ethers.formatEther(walletBalance)} ETH`
        );
      }
    }

    const txRecord = await prisma.transaction.create({
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
      const nonce =
        overrides?.nonce ??
        (await provider.getTransactionCount(signer.address, "pending"));
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

      await prisma.transaction.update({
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
      await prisma.transaction.update({
        where: { id: txRecord.id },
        data: { status: "FAILED" },
      });
      throw new Error(`ERC20 transaction failed: ${err.message}`);
    }
  });
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
  wallet: {
    walletGroupId: string | null;
    address: string | null;
  };
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

  if (txRecord.wallet.walletGroupId) {
    const current = await prisma.wallet.findUnique({
      where: { id: txRecord.walletId },
    });
    if (current) {
      const existingBalance = BigInt(current.balance);
      const debit = gasCost + (isSuccess ? value : 0n);
      const nextBalance = safeSubtract(existingBalance, debit);
      await prisma.wallet.update({
        where: { id: txRecord.walletId },
        data: { balance: nextBalance.toString() },
      });
    }
  } else if (txRecord.wallet.address) {
    const refreshedBalance = await provider.getBalance(txRecord.wallet.address);
    await prisma.wallet.update({
      where: { id: txRecord.walletId },
      data: { balance: refreshedBalance.toString() },
    });
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

  if (wallet.type !== "STANDARD") {
    throw new Error("Manual blockchain sync is only supported for standard wallets");
  }

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

  if (wallet.type !== "STANDARD") {
    throw new Error("Manual blockchain sync is only supported for standard wallets");
  }

  if (!wallet.address) {
    throw new Error("Wallet has no address");
  }

  const reconciledCount = await reconcileBroadcastingTransactionsForWallet(
    walletId,
    userId,
    200
  );

  const depositSync = await detectDepositsForWallet(walletId, userId);

  const onchainBalance = await provider.getBalance(wallet.address);
  const updatedWallet = await prisma.wallet.update({
    where: { id: walletId },
    data: { balance: onchainBalance.toString() },
    include: {
      walletGroup: true,
      accesses: {
        include: {
          user: { select: { id: true, email: true } },
        },
      },
    },
  });

  return {
    wallet: updatedWallet,
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

  const groupWallets = walletGroup.wallets.filter((wallet) => !!wallet.address);
  if (groupWallets.length === 0) {
    throw new Error("Wallet group has no wallets with an address");
  }

  const primaryWallet = groupWallets.reduce((oldest, wallet) => {
    return wallet.createdAt < oldest.createdAt ? wallet : oldest;
  }, groupWallets[0]);

  const lockKey = `wallet-group:${walletGroupId}`;

  return withKeyMutex(lockKey, async () => {
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
      id: primaryWallet.id,
      address: primaryWallet.address,
      lastSyncBlock: primaryWallet.lastSyncBlock,
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
  amount: string
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

  return withKeyMutex(lockKey, async () => {
    const freshFrom = await getAccessibleWallet(fromWalletId, userId);
    const freshTo = await getAccessibleWallet(toWalletId, userId);
    if (!freshFrom || !freshTo) {
      throw new Error("Wallet access changed during transfer");
    }

    const weiAmount = ethers.parseEther(amount);
    const fromBalance = BigInt(freshFrom.balance);

    if (fromBalance < weiAmount) {
      throw new Error("Insufficient balance in source wallet");
    }

    const [debit, credit] = await prisma.$transaction([
      prisma.transaction.create({
        data: {
          walletId: fromWalletId,
          type: "WITHDRAWAL",
          to: freshTo.address,
          from: freshFrom.address,
          amount: weiAmount.toString(),
          txHash: null,
          gasPrice: "0",
          status: "CONFIRMED",
        },
      }),
      prisma.transaction.create({
        data: {
          walletId: toWalletId,
          type: "DEPOSIT",
          to: freshTo.address,
          from: freshFrom.address,
          amount: weiAmount.toString(),
          txHash: null,
          gasPrice: "0",
          status: "CONFIRMED",
        },
      }),
      prisma.wallet.update({
        where: { id: fromWalletId },
        data: { balance: (fromBalance - weiAmount).toString() },
      }),
      prisma.wallet.update({
        where: { id: toWalletId },
        data: { balance: (BigInt(freshTo.balance) + weiAmount).toString() },
      }),
    ]);

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
