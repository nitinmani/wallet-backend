import { Router, Request, Response } from "express";
import { routeHandler } from "../lib/routeHandler";
import {
  getMaxSendAmount,
  sendAssetTransaction,
  sendTransaction,
  internalTransfer,
  getWalletTransactions,
} from "../services/transactionService";

export const transactionRoutes = Router();

// Send ETH
transactionRoutes.post(
  "/:walletId/send",
  routeHandler(async (req: Request, res: Response) => {
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
  })
);

transactionRoutes.get(
  "/:walletId/send-max",
  routeHandler(async (req: Request, res: Response) => {
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
  })
);

// Internal transfer between sub-wallets
transactionRoutes.post(
  "/:walletId/transfer",
  routeHandler(async (req: Request, res: Response) => {
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
  })
);

// Get transaction history
transactionRoutes.get(
  "/:walletId/transactions",
  routeHandler(async (req: Request, res: Response) => {
    const transactions = await getWalletTransactions(
      req.params.walletId,
      req.user!.id
    );
    res.json(transactions);
  })
);
