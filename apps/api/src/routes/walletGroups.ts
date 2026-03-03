import { Request, Response, Router } from "express";
import { routeHandler } from "../lib/routeHandler";
import {
  createWalletInExistingWalletGroup,
  getUserWalletGroups,
  getWalletGroupById,
  updateWalletGroupName,
} from "../services/walletService";

export const walletGroupRoutes = Router();

walletGroupRoutes.get(
  "/",
  routeHandler(async (req: Request, res: Response) => {
    const walletGroups = await getUserWalletGroups(req.user!.id);
    res.json(walletGroups);
  })
);

walletGroupRoutes.get(
  "/:walletGroupId",
  routeHandler(async (req: Request, res: Response) => {
    const walletGroup = await getWalletGroupById(req.params.walletGroupId, req.user!.id);
    if (!walletGroup) {
      res.status(404).json({ error: "Wallet group not found" });
      return;
    }
    res.json(walletGroup);
  })
);

walletGroupRoutes.post(
  "/:walletGroupId/wallets",
  routeHandler(async (req: Request, res: Response) => {
    const { name } = req.body;
    if (name !== undefined && (typeof name !== "string" || name.length > 50)) {
      res.status(400).json({ error: "name must be a string of at most 50 characters" });
      return;
    }
    const wallet = await createWalletInExistingWalletGroup(
      req.params.walletGroupId,
      req.user!.id,
      name
    );
    res.status(201).json(wallet);
  })
);

walletGroupRoutes.patch(
  "/:walletGroupId",
  routeHandler(async (req: Request, res: Response) => {
    const { name } = req.body;
    if (typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (name.length > 50) {
      res.status(400).json({ error: "name must be a string of at most 50 characters" });
      return;
    }

    const walletGroup = await updateWalletGroupName(
      req.params.walletGroupId,
      req.user!.id,
      name
    );
    res.json(walletGroup);
  })
);
