import { Request, Response, Router } from "express";
import { getConnectedWalletAssetBalances } from "../services/balanceService";
import {
  getConnectedWalletById,
  issueConnectedWalletChallenge,
  revokeConnectedWalletSession,
  verifyConnectedWalletChallenge,
} from "../services/connectedWalletService";
import { connectedWalletAuthMiddleware, getConnectedWalletBearerToken } from "../middleware/connectedWalletAuth";
import {
  getConnectedWalletTransactions,
  getMaxSendAmountForConnectedWallet,
  registerConnectedWalletBroadcastTx,
  syncConnectedWalletOnChainState,
} from "../services/transactionService";

export const connectedWalletRoutes = Router();

connectedWalletRoutes.post("/challenge", async (req: Request, res: Response) => {
  try {
    const { address } = req.body;
    if (!address || typeof address !== "string") {
      res.status(400).json({ error: "address is required" });
      return;
    }

    const challenge = await issueConnectedWalletChallenge(address);
    res.json(challenge);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

connectedWalletRoutes.post("/verify", async (req: Request, res: Response) => {
  try {
    const { address, signature } = req.body;
    if (!address || typeof address !== "string") {
      res.status(400).json({ error: "address is required" });
      return;
    }
    if (!signature || typeof signature !== "string") {
      res.status(400).json({ error: "signature is required" });
      return;
    }

    const session = await verifyConnectedWalletChallenge(address, signature);
    res.json(session);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

connectedWalletRoutes.use(connectedWalletAuthMiddleware);

connectedWalletRoutes.post("/logout", async (req: Request, res: Response) => {
  try {
    const token = getConnectedWalletBearerToken(req);
    if (token) {
      await revokeConnectedWalletSession(token);
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

connectedWalletRoutes.get("/me", async (req: Request, res: Response) => {
  try {
    const wallet = await getConnectedWalletById(req.connectedWallet!.walletId);
    if (!wallet) {
      res.status(404).json({ error: "Connected wallet not found" });
      return;
    }
    res.json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

connectedWalletRoutes.get("/assets", async (req: Request, res: Response) => {
  try {
    const assets = await getConnectedWalletAssetBalances(req.connectedWallet!.walletId);
    res.json(assets);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

connectedWalletRoutes.get("/transactions", async (req: Request, res: Response) => {
  try {
    const transactions = await getConnectedWalletTransactions(req.connectedWallet!.walletId);
    res.json(transactions);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

connectedWalletRoutes.post("/sync", async (req: Request, res: Response) => {
  try {
    const result = await syncConnectedWalletOnChainState(req.connectedWallet!.walletId);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

connectedWalletRoutes.get("/send-max", async (req: Request, res: Response) => {
  try {
    const assetId = req.query.assetId;
    const to = req.query.to;
    if (typeof assetId !== "string" || !assetId.trim()) {
      res.status(400).json({ error: "assetId is required" });
      return;
    }

    const result = await getMaxSendAmountForConnectedWallet(
      req.connectedWallet!.walletId,
      assetId,
      typeof to === "string" ? to : undefined
    );
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

connectedWalletRoutes.post("/register-tx", async (req: Request, res: Response) => {
  try {
    const { txHash, to, amount, assetId, nonce } = req.body;
    if (!txHash || typeof txHash !== "string") {
      res.status(400).json({ error: "txHash is required" });
      return;
    }
    if (!amount || typeof amount !== "string") {
      res.status(400).json({ error: "amount is required" });
      return;
    }

    const result = await registerConnectedWalletBroadcastTx(
      req.connectedWallet!.walletId,
      {
        txHash,
        to: typeof to === "string" ? to : undefined,
        amount,
        assetId: typeof assetId === "string" ? assetId : undefined,
        nonce: typeof nonce === "number" ? nonce : undefined,
      }
    );
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
