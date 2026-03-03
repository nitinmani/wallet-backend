import { Prisma } from "@prisma/client";
import { provider } from "../lib/provider";

export function getWalletLockKey(walletId: string, walletGroupId: string | null) {
  return walletGroupId ? `wallet-group:${walletGroupId}` : `wallet:${walletId}`;
}

export async function estimateGasCost(
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

export async function getNextNonce(
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
