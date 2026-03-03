import { ethers } from "ethers";
import { withPgAdvisoryLock } from "../lib/pgLock";
import { prisma } from "../lib/prisma";
import { broadcastSignedTransaction, provider } from "../lib/provider";
import { ensureNativeAsset, getWalletAssetBalance, setWalletAssetBalance } from "./assetService";
import { getAccessibleWallet, getWalletSigningContext } from "./walletService";
import { estimateGasCost, getNextNonce, getWalletLockKey } from "./txHelpers";

type TxOverrides = {
  gasPrice?: bigint;
  nonce?: number;
};

type ContractReadInput = {
  contractAddress: string;
  abi: ethers.InterfaceAbi;
  method: string;
  args?: unknown[];
  blockTag?: ethers.BlockTag;
};

type ContractWriteInput = {
  walletId: string;
  userId: string;
  contractAddress: string;
  abi: ethers.InterfaceAbi;
  method: string;
  args?: unknown[];
  valueEth?: string;
  overrides?: TxOverrides;
};

function normalizeArgs(args?: unknown[]): unknown[] {
  if (args === undefined) return [];
  if (!Array.isArray(args)) {
    throw new Error("args must be an array");
  }
  return args;
}

function toSerializable(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => toSerializable(item));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = toSerializable(nested);
    }
    return output;
  }

  return value;
}

function getInsufficientBalanceMessage(amount: bigint, gasCost: bigint, available: bigint): string {
  return `Insufficient balance: need ${ethers.formatEther(
    amount + gasCost
  )} ETH (value + gas), have ${ethers.formatEther(available)} ETH`;
}

export async function readContract(input: ContractReadInput) {
  const { contractAddress, abi, method, args, blockTag } = input;

  if (!ethers.isAddress(contractAddress)) {
    throw new Error("Invalid contractAddress");
  }

  const methodArgs = normalizeArgs(args);
  const contract = new ethers.Contract(contractAddress, abi, provider) as Record<string, any>;
  const contractMethod = contract[method];

  if (!contractMethod || typeof contractMethod !== "function") {
    throw new Error(`Method not found in ABI: ${method}`);
  }

  const result =
    blockTag !== undefined
      ? await contractMethod.staticCall(...methodArgs, { blockTag })
      : await contractMethod.staticCall(...methodArgs);

  return {
    result: toSerializable(result),
  };
}

export async function writeContract(input: ContractWriteInput) {
  const { walletId, userId, contractAddress, abi, method, args, valueEth, overrides } = input;

  if (!ethers.isAddress(contractAddress)) {
    throw new Error("Invalid contractAddress");
  }

  const methodArgs = normalizeArgs(args);
  const valueWei = valueEth ? ethers.parseEther(valueEth) : 0n;

  const lockWallet = await getAccessibleWallet(walletId, userId);
  if (!lockWallet) {
    throw new Error("Wallet not found");
  }

  const lockKey = getWalletLockKey(lockWallet.id, lockWallet.walletGroupId);

  const result = await withPgAdvisoryLock(lockKey, async (tx) => {
    const { wallet, signer } = await getWalletSigningContext(walletId, userId);
    const contract = new ethers.Contract(contractAddress, abi, signer) as Record<string, any>;
    const contractMethod = contract[method];

    if (!contractMethod || typeof contractMethod !== "function") {
      throw new Error(`Method not found in ABI: ${method}`);
    }

    const contractCallOverrides: Record<string, unknown> = {};
    if (valueWei > 0n) {
      contractCallOverrides.value = valueWei;
    }

    const gasLimit = await contractMethod.estimateGas(
      ...methodArgs,
      contractCallOverrides
    );
    const { gasCost, effectiveGasPrice } = await estimateGasCost(
      gasLimit,
      overrides?.gasPrice
    );

    const onchainBalance = await provider.getBalance(signer.address);
    if (valueWei + gasCost > onchainBalance) {
      throw new Error(getInsufficientBalanceMessage(valueWei, gasCost, onchainBalance));
    }

    const nativeAsset = await ensureNativeAsset(tx);
    const walletNativeBalance = await getWalletAssetBalance(
      wallet.id,
      nativeAsset.id,
      tx
    );
    const totalReserved = valueWei + gasCost;
    if (totalReserved > walletNativeBalance) {
      throw new Error(
        getInsufficientBalanceMessage(valueWei, gasCost, walletNativeBalance)
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
        type: "CONTRACT",
        to: contractAddress,
        from: signer.address,
        amount: valueWei.toString(),
        gasPrice: effectiveGasPrice.toString(),
        lockedAmount: totalReserved.toString(),
        status: "PENDING",
      },
    });

    try {
      const populatedTx = await contractMethod.populateTransaction(
        ...methodArgs,
        contractCallOverrides
      );
      const network = await provider.getNetwork();
      const nonce = overrides?.nonce ?? (await getNextNonce(tx, signer.address));
      const gasPrice = overrides?.gasPrice ?? effectiveGasPrice;

      const { from: _from, ...txFields } = populatedTx;
      const txParams: ethers.TransactionRequest = {
        ...txFields,
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
      // Broadcast failed — restore the reserved balance.
      await setWalletAssetBalance(wallet.id, nativeAsset.id, walletNativeBalance, tx);
      await tx.transaction.update({
        where: { id: txRecord.id },
        data: { status: "FAILED" },
      });
      return {
        error: `Contract write failed: ${err.message}`,
      } as const;
    }
  });

  if ("error" in result) {
    throw new Error(result.error);
  }

  return result;
}
