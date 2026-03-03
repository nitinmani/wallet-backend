import { Request, Response, Router } from "express";
import {
  createWalletInExistingWalletGroup,
  getUserWalletGroups,
  getWalletGroupById,
  updateWalletGroupName,
} from "../services/walletService";

export const walletGroupRoutes = Router();

walletGroupRoutes.get("/", async (req: Request, res: Response) => {
  try {
    const walletGroups = await getUserWalletGroups(req.user!.id);
    res.json(walletGroups);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

walletGroupRoutes.get("/:walletGroupId", async (req: Request, res: Response) => {
  try {
    const walletGroup = await getWalletGroupById(req.params.walletGroupId, req.user!.id);
    if (!walletGroup) {
      res.status(404).json({ error: "Wallet group not found" });
      return;
    }
    res.json(walletGroup);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

walletGroupRoutes.post("/:walletGroupId/wallets", async (req: Request, res: Response) => {
  try {
    const wallet = await createWalletInExistingWalletGroup(
      req.params.walletGroupId,
      req.user!.id,
      req.body.name
    );
    res.status(201).json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

walletGroupRoutes.patch("/:walletGroupId", async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const walletGroup = await updateWalletGroupName(
      req.params.walletGroupId,
      req.user!.id,
      name
    );
    res.json(walletGroup);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
