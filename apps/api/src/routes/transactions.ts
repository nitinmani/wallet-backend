import { Router, Request, Response } from "express";
import {
  getMaxSendAmount,
  sendAssetTransaction,
  sendTransaction,
  replaceByFee,
  internalTransfer,
  getWalletTransactions,
} from "../services/transactionService";

export const transactionRoutes = Router();

// Send ETH
transactionRoutes.post("/:walletId/send", async (req: Request, res: Response) => {
  try {
    const { to, amount, gasPrice, nonce, assetId } = req.body;
    if (!to || !amount) {
      res.status(400).json({ error: "to and amount are required" });
      return;
    }

    const overrides: { gasPrice?: bigint; nonce?: number } = {};
    if (gasPrice) overrides.gasPrice = BigInt(gasPrice);
    if (nonce !== undefined) overrides.nonce = nonce;

    const normalizedOverrides =
      Object.keys(overrides).length > 0 ? overrides : undefined;

    const result = assetId
      ? await sendAssetTransaction(
          req.params.walletId,
          req.user!.id,
          to,
          amount,
          assetId,
          normalizedOverrides
        )
      : await sendTransaction(
          req.params.walletId,
          req.user!.id,
          to,
          amount,
          normalizedOverrides
        );
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

transactionRoutes.get("/:walletId/send-max", async (req: Request, res: Response) => {
  try {
    const assetId = req.query.assetId;
    const to = req.query.to;
    if (typeof assetId !== "string" || !assetId.trim()) {
      res.status(400).json({ error: "assetId is required" });
      return;
    }

    const result = await getMaxSendAmount(
      req.params.walletId,
      req.user!.id,
      assetId,
      typeof to === "string" ? to : undefined
    );
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Replace-by-fee
transactionRoutes.post("/:walletId/rbf", async (req: Request, res: Response) => {
  try {
    const { originalTxId, gasPrice } = req.body;
    if (!originalTxId || !gasPrice) {
      res.status(400).json({ error: "originalTxId and gasPrice are required" });
      return;
    }

    const result = await replaceByFee(
      req.params.walletId,
      req.user!.id,
      originalTxId,
      BigInt(gasPrice)
    );
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Internal transfer between sub-wallets
transactionRoutes.post("/:walletId/transfer", async (req: Request, res: Response) => {
  try {
    const { toWalletId, amount, assetId } = req.body;
    if (!toWalletId || !amount) {
      res.status(400).json({ error: "toWalletId and amount are required" });
      return;
    }

    const result = await internalTransfer(
      req.params.walletId,
      toWalletId,
      req.user!.id,
      amount,
      assetId
    );
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Get transaction history
transactionRoutes.get("/:walletId/transactions", async (req: Request, res: Response) => {
  try {
    const transactions = await getWalletTransactions(
      req.params.walletId,
      req.user!.id
    );
    res.json(transactions);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
