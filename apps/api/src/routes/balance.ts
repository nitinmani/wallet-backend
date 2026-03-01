import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { getEthBalance, getTokenBalance } from "../services/balanceService";
import { prisma } from "../lib/prisma";

export const balanceRoutes = Router();

// Get balance by address or wallet ID
balanceRoutes.get("/:addressOrWalletId", async (req: Request, res: Response) => {
  try {
    const { addressOrWalletId } = req.params;
    const { asset } = req.query;

    let address: string;
    let walletBalanceOverride: string | null = null;

    // Determine if it's an Ethereum address or a wallet ID
    if (ethers.isAddress(addressOrWalletId)) {
      address = addressOrWalletId;
    } else {
      // Look up wallet by ID
      const wallet = await prisma.wallet.findFirst({
        where: {
          id: addressOrWalletId,
          OR: [
            { ownerId: req.user!.id },
            { accesses: { some: { userId: req.user!.id } } },
          ],
        },
      });
      if (!wallet || !wallet.address) {
        res.status(404).json({ error: "Wallet not found or has no address" });
        return;
      }
      address = wallet.address;
      if (wallet.type === "GROUPED") {
        walletBalanceOverride = wallet.balance;
      }
    }

    if (asset && typeof asset === "string") {
      // ERC-20 balance
      const result = await getTokenBalance(address, asset);
      res.json({ address, ...result });
    } else {
      if (walletBalanceOverride !== null) {
        const value = BigInt(walletBalanceOverride);
        res.json({
          address,
          balance: walletBalanceOverride,
          formatted: ethers.formatEther(value),
        });
        return;
      }
      // ETH balance
      const result = await getEthBalance(address);
      res.json({ address, ...result });
    }
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
