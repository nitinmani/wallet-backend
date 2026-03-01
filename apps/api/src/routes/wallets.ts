import { Request, Response, Router } from "express";
import { withKeyMutex } from "../lib/keyMutex";
import { syncWalletOnChainState } from "../services/transactionService";
import {
  createWallet,
  createWalletInWalletGroup,
  getUserWallets,
  getWalletById,
  getWalletSigningContext,
  shareWalletWithUser,
  updateWalletName,
} from "../services/walletService";

export const walletRoutes = Router();

walletRoutes.post("/", async (req: Request, res: Response) => {
  try {
    const wallet = await createWallet(req.user!.id, req.body.name);
    res.status(201).json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

walletRoutes.post("/:walletId/group-wallet", async (req: Request, res: Response) => {
  try {
    const wallet = await createWalletInWalletGroup(
      req.user!.id,
      req.params.walletId,
      req.body.name
    );
    res.status(201).json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

walletRoutes.post("/:walletId/share", async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: "email is required" });
      return;
    }

    const result = await shareWalletWithUser(req.user!.id, req.params.walletId, email);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

walletRoutes.patch("/:walletId", async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const wallet = await updateWalletName(req.params.walletId, req.user!.id, name);
    res.json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

walletRoutes.post("/:walletId/sync", async (req: Request, res: Response) => {
  try {
    const result = await syncWalletOnChainState(req.params.walletId, req.user!.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

walletRoutes.get("/", async (req: Request, res: Response) => {
  try {
    const wallets = await getUserWallets(req.user!.id);
    res.json(wallets);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

walletRoutes.get("/:walletId", async (req: Request, res: Response) => {
  try {
    const wallet = await getWalletById(req.user!.id, req.params.walletId);
    if (!wallet) {
      res.status(404).json({ error: "Wallet not found" });
      return;
    }
    res.json(wallet);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

walletRoutes.post("/:walletId/sign", async (req: Request, res: Response) => {
  try {
    const { message } = req.body;
    if (!message) {
      res.status(400).json({ error: "Message is required" });
      return;
    }

    const lockWallet = await getWalletById(req.user!.id, req.params.walletId);
    if (!lockWallet) {
      res.status(404).json({ error: "Wallet not found" });
      return;
    }

    const lockKey = lockWallet.walletGroupId
      ? `wallet-group:${lockWallet.walletGroupId}`
      : `wallet:${lockWallet.id}`;

    const result = await withKeyMutex(lockKey, async () => {
      const { signer } = await getWalletSigningContext(req.params.walletId, req.user!.id);
      const signature = await signer.signMessage(message);
      return { signature, address: signer.address };
    });

    res.json({
      signature: result.signature,
      message,
      address: result.address,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
