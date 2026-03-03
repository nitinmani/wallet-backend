import { ethers } from "ethers";
import { config } from "../lib/config";

type EtherscanResponse = {
  status: string;
  message: string;
  result: string;
};

export async function fetchContractAbiFromEtherscan(
  contractAddress: string
): Promise<ethers.InterfaceAbi> {
  if (!ethers.isAddress(contractAddress)) {
    throw new Error("Invalid contractAddress");
  }
  if (!config.etherscanApiKey) {
    throw new Error("ETHERSCAN_API_KEY is not configured");
  }

  const query = new URLSearchParams({
    chainid: config.etherscanChainId,
    module: "contract",
    action: "getabi",
    address: ethers.getAddress(contractAddress),
    apikey: config.etherscanApiKey,
  });
  const url = `${config.etherscanBaseUrl}?${query.toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Etherscan HTTP error: ${response.status}`);
  }

  const payload = (await response.json()) as EtherscanResponse;
  if (!payload || typeof payload.result !== "string") {
    throw new Error("Etherscan returned an invalid ABI response");
  }
  if (payload.status !== "1") {
    throw new Error(
      `Etherscan ABI error: ${payload.message || "NOTOK"} ${payload.result}`.trim()
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.result);
  } catch {
    throw new Error("Failed to parse ABI JSON from Etherscan");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Etherscan ABI response is not an array");
  }

  return parsed as ethers.InterfaceAbi;
}
