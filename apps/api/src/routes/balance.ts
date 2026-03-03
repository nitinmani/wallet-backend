import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { provider } from "../lib/provider";
import {
  getWalletAssetBalanceByContract,
  getWalletAssetBalances,
  getWalletNativeBalance,
} from "../services/balanceService";
import { prisma } from "../lib/prisma";

export const balanceRoutes = Router();

async function getAccessibleWallet(addressOrWalletId: string, userId: string) {
  return prisma.wallet.findFirst({
    where: {
      id: addressOrWalletId,
      OR: [{ ownerId: userId }, { accesses: { some: { userId } } }],
    },
  });
}

balanceRoutes.get("/wallet/:walletId/assets", async (req: Request, res: Response) => {
  try {
    const wallet = await getAccessibleWallet(req.params.walletId, req.user!.id);
    if (!wallet) {
      res.status(404).json({ error: "Wallet not found" });
      return;
    }

    const assets = await getWalletAssetBalances(wallet.id);
    res.json(assets);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Get balance by wallet ID (DB-backed) or by raw address (chain fallback)
balanceRoutes.get("/:addressOrWalletId", async (req: Request, res: Response) => {
  try {
    const { addressOrWalletId } = req.params;
    const { asset } = req.query;
    const wallet = await getAccessibleWallet(addressOrWalletId, req.user!.id);

    if (wallet) {
      if (asset && typeof asset === "string" && asset.trim()) {
        if (ethers.isAddress(asset)) {
          const tokenResult = await getWalletAssetBalanceByContract(wallet.id, asset);
          res.json(tokenResult);
          return;
        }

        const assetBalance = await prisma.walletAssetBalance.findFirst({
          where: { walletId: wallet.id, assetId: asset },
          include: { asset: true },
        });
        if (!assetBalance) {
          res.status(404).json({ error: "Asset balance not found" });
          return;
        }

        const value = BigInt(assetBalance.balance);
        res.json({
          balance: assetBalance.balance,
          formatted: ethers.formatUnits(value, assetBalance.asset.decimals),
          symbol: assetBalance.asset.symbol,
          decimals: assetBalance.asset.decimals,
          assetId: assetBalance.assetId,
          tokenAddress: assetBalance.asset.contractAddress,
        });
        return;
      }

      const nativeResult = await getWalletNativeBalance(wallet.id);
      res.json(nativeResult);
      return;
    }

    if (!ethers.isAddress(addressOrWalletId)) {
      res.status(404).json({ error: "Wallet not found" });
      return;
    }

    if (asset && typeof asset === "string" && ethers.isAddress(asset)) {
      const token = new ethers.Contract(
        asset,
        [
          "function balanceOf(address owner) view returns (uint256)",
          "function decimals() view returns (uint8)",
          "function symbol() view returns (string)",
        ],
        provider
      );
      const [balance, decimals, symbol] = await Promise.all([
        token.balanceOf(addressOrWalletId),
        token.decimals(),
        token.symbol(),
      ]);
      res.json({
        address: addressOrWalletId,
        balance: balance.toString(),
        formatted: ethers.formatUnits(balance, decimals),
        symbol,
      });
      return;
    }

    const balance = await provider.getBalance(addressOrWalletId);
    res.json({
      address: addressOrWalletId,
      balance: balance.toString(),
      formatted: ethers.formatEther(balance),
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

