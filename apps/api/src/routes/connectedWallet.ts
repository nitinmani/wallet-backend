import { Request, Response, Router } from "express";
import { routeHandler } from "../lib/routeHandler";
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

connectedWalletRoutes.post(
  "/challenge",
  routeHandler(async (req: Request, res: Response) => {
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
  })
);

connectedWalletRoutes.post(
  "/verify",
  routeHandler(async (req: Request, res: Response) => {
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
  })
);

connectedWalletRoutes.use(connectedWalletAuthMiddleware);

connectedWalletRoutes.post(
  "/logout",
  routeHandler(async (req: Request, res: Response) => {
    const token = getConnectedWalletBearerToken(req);
    if (token) {
      await revokeConnectedWalletSession(token);
    }
    res.json({ ok: true });
  })
);

connectedWalletRoutes.get(
  "/me",
  routeHandler(async (req: Request, res: Response) => {
    const wallet = await getConnectedWalletByAddress(req.connectedWallet!.address);
    res.json(wallet);
  })
);

connectedWalletRoutes.get(
  "/assets",
  routeHandler(async (req: Request, res: Response) => {
    const assets = await getConnectedWalletAssetBalances(req.connectedWallet!.address);
    res.json(assets);
  })
);

connectedWalletRoutes.post(
  "/sync",
  routeHandler(async (req: Request, res: Response) => {
    const result = await syncConnectedWalletOnChainState(req.connectedWallet!.address);
    res.json(result);
  })
);

connectedWalletRoutes.get(
  "/send-max",
  routeHandler(async (req: Request, res: Response) => {
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
  })
);

connectedWalletRoutes.get(
  "/abi/:contractAddress",
  routeHandler(async (req: Request, res: Response) => {
    const abi = await fetchContractAbiFromEtherscan(req.params.contractAddress);
    res.json({ abi });
  })
);
