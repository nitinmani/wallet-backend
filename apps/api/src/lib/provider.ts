import { ethers } from "ethers";
import { config } from "./config";

export const provider = new ethers.JsonRpcProvider(config.sepoliaRpcUrl);

export async function broadcastSignedTransaction(
  signedTransaction: string
): Promise<string> {
  const response = await provider.broadcastTransaction(signedTransaction);
  return response.hash;
}
