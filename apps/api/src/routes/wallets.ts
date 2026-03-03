import { Request, Response, Router } from "express";
import { routeHandler } from "../lib/routeHandler";
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

walletRoutes.post(
  "/",
  routeHandler(async (req: Request, res: Response) => {
    const wallet = await createWallet(req.user!.id, req.body.name);
    res.status(201).json(wallet);
  })
);

walletRoutes.post(
  "/:walletId/group-wallet",
  routeHandler(async (req: Request, res: Response) => {
    const wallet = await createWalletInWalletGroup(
      req.user!.id,
      req.params.walletId,
      req.body.name
    );
    res.status(201).json(wallet);
  })
);

walletRoutes.post(
  "/:walletId/share",
  routeHandler(async (req: Request, res: Response) => {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: "email is required" });
      return;
    }

    const result = await shareWalletWithUser(req.user!.id, req.params.walletId, email);
    res.json(result);
  })
);

walletRoutes.patch(
  "/:walletId",
  routeHandler(async (req: Request, res: Response) => {
    const { name } = req.body;
    if (typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const wallet = await updateWalletName(req.params.walletId, req.user!.id, name);
    res.json(wallet);
  })
);

walletRoutes.get(
  "/",
  routeHandler(
    async (req: Request, res: Response) => {
    const wallets = await getUserWallets(req.user!.id);
    res.json(wallets);
    },
    { status: 500 }
  )
);

walletRoutes.get(
  "/:walletId",
  routeHandler(
    async (req: Request, res: Response) => {
    const wallet = await getWalletById(req.user!.id, req.params.walletId);
    if (!wallet) {
      res.status(404).json({ error: "Wallet not found" });
      return;
    }
    res.json(wallet);
    },
    { status: 500 }
  )
);

walletRoutes.post(
  "/:walletId/sign",
  routeHandler(async (req: Request, res: Response) => {
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

    const { signer } = await getWalletSigningContext(req.params.walletId, req.user!.id);
    const signature = await signer.signMessage(message);

    res.json({
      signature,
      message,
      address: signer.address,
    });
  })
);
