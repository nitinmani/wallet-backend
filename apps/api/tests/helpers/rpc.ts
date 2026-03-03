import { ethers } from "ethers";

export const TEST_RPC_URL = process.env.TEST_RPC_URL || "http://127.0.0.1:8545";
export const ANVIL_FUNDER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

let providerInstance: ethers.JsonRpcProvider | null = null;
let funderInstance: ethers.Wallet | null = null;

export function getTestProvider() {
  if (!providerInstance) {
    providerInstance = new ethers.JsonRpcProvider(TEST_RPC_URL);
  }
  return providerInstance;
}

export function getAnvilFunder() {
  if (!funderInstance) {
    funderInstance = new ethers.Wallet(
      ANVIL_FUNDER_PRIVATE_KEY,
      getTestProvider()
    );
  }
  return funderInstance;
}
