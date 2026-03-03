import { Request, Response, Router } from "express";
import {
  getConnectedWalletAssetBalances,
  getConnectedWalletByAddress,
  getMaxSendAmountForConnectedWallet,
  issueConnectedWalletChallenge,
  revokeConnectedWalletSession,
  syncConnectedWalletOnChainState,
  verifyConnectedWalletChallenge,
} from "../services/connectedWalletService";
import { fetchContractAbiFromEtherscan } from "../services/etherscanService";
import {
  connectedWalletAuthMiddleware,
  getConnectedWalletBearerToken,
} from "../middleware/connectedWalletAuth";

export const connectedWalletRoutes = Router();

const FORBIDDEN_KEY_MATERIAL_FIELDS = [
  "privatekey",
  "encryptedkey",
  "mnemonic",
  "seedphrase",
  "seed",
];

function hasForbiddenKeyMaterial(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasForbiddenKeyMaterial(item));
  }
  if (typeof value !== "object") return false;

  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    const normalizedKey = key.toLowerCase().replace(/[\s_-]/g, "");
    const isForbidden = FORBIDDEN_KEY_MATERIAL_FIELDS.some((token) =>
      normalizedKey.includes(token)
    );
    return isForbidden || hasForbiddenKeyMaterial(nested);
  });
}

connectedWalletRoutes.post("/challenge", async (req: Request, res: Response) => {
  try {
    if (hasForbiddenKeyMaterial(req.body)) {
      res.status(400).json({ error: "Never send private key material to this API" });
      return;
    }

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
    if (hasForbiddenKeyMaterial(req.body)) {
      res.status(400).json({ error: "Never send private key material to this API" });
      return;
    }

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
    const initialSync = await syncConnectedWalletOnChainState(
      session.wallet.address
    );
    res.json({
      ...session,
      initialSync,
    });
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
    const wallet = await getConnectedWalletByAddress(req.connectedWallet!.address);
    res.json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

connectedWalletRoutes.get("/assets", async (req: Request, res: Response) => {
  try {
    const assets = await getConnectedWalletAssetBalances(req.connectedWallet!.address);
    res.json(assets);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

connectedWalletRoutes.post("/sync", async (req: Request, res: Response) => {
  try {
    const result = await syncConnectedWalletOnChainState(req.connectedWallet!.address);
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
      req.connectedWallet!.address,
      assetId,
      typeof to === "string" ? to : undefined
    );
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

connectedWalletRoutes.get("/abi/:contractAddress", async (req: Request, res: Response) => {
  try {
    const abi = await fetchContractAbiFromEtherscan(req.params.contractAddress);
    res.json({ abi });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
