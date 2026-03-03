import { Request, Response, Router } from "express";
import { ethers } from "ethers";
import { readContract, writeContract } from "../services/contractService";
import { fetchContractAbiFromEtherscan } from "../services/etherscanService";

export const contractRoutes = Router();

function parseAbi(abiInput: unknown): ethers.InterfaceAbi {
  if (Array.isArray(abiInput)) {
    return abiInput as ethers.InterfaceAbi;
  }

  if (typeof abiInput === "string") {
    try {
      const parsed = JSON.parse(abiInput);
      if (!Array.isArray(parsed)) {
        throw new Error("ABI JSON must be an array");
      }
      return parsed as ethers.InterfaceAbi;
    } catch (err: any) {
      throw new Error(`Invalid abi: ${err.message}`);
    }
  }

  throw new Error("abi is required and must be an array or JSON string");
}

contractRoutes.get("/abi/:contractAddress", async (req: Request, res: Response) => {
  try {
    const abi = await fetchContractAbiFromEtherscan(req.params.contractAddress);
    res.json({ abi });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

contractRoutes.post("/read", async (req: Request, res: Response) => {
  try {
    const { contractAddress, abi, method, args, blockTag } = req.body;

    if (!contractAddress || !abi || !method) {
      res.status(400).json({ error: "contractAddress, abi, and method are required" });
      return;
    }

    const result = await readContract({
      contractAddress,
      abi: parseAbi(abi),
      method,
      args,
      blockTag,
    });

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

contractRoutes.post("/:walletId/write", async (req: Request, res: Response) => {
  try {
    const { contractAddress, abi, method, args, value, gasPrice, nonce } = req.body;

    if (!contractAddress || !abi || !method) {
      res.status(400).json({ error: "contractAddress, abi, and method are required" });
      return;
    }

    const overrides: { gasPrice?: bigint; nonce?: number } = {};
    if (gasPrice !== undefined && gasPrice !== null) {
      overrides.gasPrice = BigInt(gasPrice);
    }
    if (nonce !== undefined) {
      overrides.nonce = Number(nonce);
    }

    const result = await writeContract({
      walletId: req.params.walletId,
      userId: req.user!.id,
      contractAddress,
      abi: parseAbi(abi),
      method,
      args,
      valueEth: value,
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    });

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
