import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { ethers } from "ethers";
import { config } from "../lib/config";
import { provider } from "../lib/provider";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CONNECTED_WALLET_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const ETHERSCAN_PAGE_SIZE = 1_000;
const ETHERSCAN_MIN_REQUEST_INTERVAL_MS = 220;
const ETHERSCAN_MAX_RETRIES = 4;

type ChallengeRecord = {
  message: string;
  expiresAtMs: number;
};

type EtherscanResponse<T> = {
  status: string;
  message: string;
  result: T | string;
};

type EtherscanErc20TxRow = {
  contractAddress: string;
};

const challengeStore = new Map<string, ChallengeRecord>();
const sessionActivityByTokenHash = new Map<string, number>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(address: string): string {
  if (!ethers.isAddress(address)) {
    throw new Error("Invalid wallet address");
  }
  return ethers.getAddress(address);
}

function getChallengeKey(address: string): string {
  return normalizeAddress(address).toLowerCase();
}

function buildChallengeMessage(address: string, nonce: string): string {
  return [
    "Vencura Non-Custodial Wallet Login",
    "",
    "Sign this message to prove wallet ownership.",
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    "Network: Sepolia",
  ].join("\n");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function signPayload(payloadBase64Url: string): string {
  return createHmac("sha256", config.encryptionKey)
    .update(payloadBase64Url)
    .digest("hex");
}

function parseAndVerifyToken(token: string): { address: string } {
  const [payloadBase64Url, signature] = token.split(".");
  if (!payloadBase64Url || !signature) {
    throw new Error("Invalid connected wallet session");
  }

  const expected = signPayload(payloadBase64Url);
  const provided = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    provided.length !== expectedBuffer.length ||
    !timingSafeEqual(provided, expectedBuffer)
  ) {
    throw new Error("Invalid connected wallet session");
  }

  let payload: { address?: unknown };
  try {
    const raw = Buffer.from(payloadBase64Url, "base64url").toString("utf8");
    payload = JSON.parse(raw) as { address?: unknown };
  } catch {
    throw new Error("Invalid connected wallet session");
  }

  if (typeof payload.address !== "string") {
    throw new Error("Invalid connected wallet session");
  }

  return { address: normalizeAddress(payload.address) };
}

function createSessionToken(address: string): string {
  const payload = {
    address: normalizeAddress(address),
    iat: Date.now(),
  };
  const payloadBase64Url = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const signature = signPayload(payloadBase64Url);
  const token = `${payloadBase64Url}.${signature}`;
  sessionActivityByTokenHash.set(hashToken(token), Date.now());
  return token;
}

function buildAssetId(type: "NATIVE" | "ERC20", contractAddress?: string): string {
  if (type === "NATIVE") return "native:eth";
  if (!contractAddress) {
    throw new Error("Missing ERC20 contract address");
  }
  return `erc20:${ethers.getAddress(contractAddress).toLowerCase()}`;
}

function parseAssetId(assetId: string) {
  if (assetId === "native:eth") {
    return { type: "NATIVE" as const, contractAddress: null };
  }
  if (!assetId.startsWith("erc20:")) {
    throw new Error("Invalid assetId");
  }
  const address = assetId.slice("erc20:".length).trim();
  if (!ethers.isAddress(address)) {
    throw new Error("Invalid ERC20 assetId");
  }
  return { type: "ERC20" as const, contractAddress: ethers.getAddress(address) };
}

async function fetchEtherscanPage<T>(
  params: Record<string, string>
): Promise<T[]> {
  if (!config.etherscanApiKey) {
    return [];
  }

  const query = new URLSearchParams({
    chainid: config.etherscanChainId,
    ...params,
    apikey: config.etherscanApiKey,
  });
  const url = `${config.etherscanBaseUrl}?${query.toString()}`;

  for (let attempt = 1; attempt <= ETHERSCAN_MAX_RETRIES; attempt++) {
    await sleep(ETHERSCAN_MIN_REQUEST_INTERVAL_MS);

    const response = await fetch(url);
    if (!response.ok) {
      const retryable = response.status === 429 && attempt < ETHERSCAN_MAX_RETRIES;
      if (retryable) {
        await sleep(ETHERSCAN_MIN_REQUEST_INTERVAL_MS * attempt * 2);
        continue;
      }
      throw new Error(`Etherscan HTTP error: ${response.status}`);
    }

    const payload = (await response.json()) as EtherscanResponse<T[]>;
    if (Array.isArray(payload.result)) {
      return payload.result;
    }

    const resultText = typeof payload.result === "string" ? payload.result : "";
    const errorText = `${payload.message || ""} ${resultText}`.trim().toLowerCase();
    if (errorText.includes("no transactions found")) {
      return [];
    }
    if (
      (errorText.includes("rate limit") ||
        errorText.includes("max rate limit reached")) &&
      attempt < ETHERSCAN_MAX_RETRIES
    ) {
      await sleep(ETHERSCAN_MIN_REQUEST_INTERVAL_MS * attempt * 2);
      continue;
    }

    throw new Error(
      `Etherscan API error (${params.action || "unknown"}): ${resultText || payload.message}`
    );
  }

  throw new Error(
    `Etherscan API error (${params.action || "unknown"}): max retries exceeded`
  );
}

async function fetchEtherscanAccountRecords<T>(
  action: "tokentx",
  address: string
): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;

  while (true) {
    const pageRows = await fetchEtherscanPage<T>({
      module: "account",
      action,
      address,
      startblock: "0",
      endblock: "99999999",
      page: String(page),
      offset: String(ETHERSCAN_PAGE_SIZE),
      sort: "desc",
    });

    if (pageRows.length === 0) break;
    rows.push(...pageRows);
    if (pageRows.length < ETHERSCAN_PAGE_SIZE) break;
    page += 1;
  }

  return rows;
}

async function getTrackedTokenContracts(address: string): Promise<string[]> {
  const rows = await fetchEtherscanAccountRecords<EtherscanErc20TxRow>(
    "tokentx",
    address
  );
  const contracts = new Set<string>();
  for (const row of rows) {
    if (!row.contractAddress || !ethers.isAddress(row.contractAddress)) continue;
    contracts.add(ethers.getAddress(row.contractAddress));
  }
  return [...contracts];
}

export async function getConnectedWalletByAddress(address: string) {
  const normalizedAddress = normalizeAddress(address);
  const balance = await provider.getBalance(normalizedAddress);
  return {
    id: normalizedAddress.toLowerCase(),
    name: "Connected Wallet",
    address: normalizedAddress,
    balance: balance.toString(),
  };
}

export async function getConnectedWalletAssetBalances(address: string) {
  const normalizedAddress = normalizeAddress(address);
  const nativeBalance = await provider.getBalance(normalizedAddress);
  const assets: Array<{
    assetId: string;
    type: "NATIVE" | "ERC20";
    symbol: string;
    decimals: number;
    contractAddress: string | null;
    balance: string;
    formatted: string;
  }> = [
    {
      assetId: buildAssetId("NATIVE"),
      type: "NATIVE",
      symbol: "ETH",
      decimals: 18,
      contractAddress: null,
      balance: nativeBalance.toString(),
      formatted: ethers.formatEther(nativeBalance),
    },
  ];

  const contracts = await getTrackedTokenContracts(normalizedAddress);
  for (const contractAddress of contracts) {
    try {
      const token = new ethers.Contract(
        contractAddress,
        [
          "function balanceOf(address owner) view returns (uint256)",
          "function symbol() view returns (string)",
          "function decimals() view returns (uint8)",
        ],
        provider
      );
      const [balance, symbol, decimals] = await Promise.all([
        token.balanceOf(normalizedAddress),
        token.symbol(),
        token.decimals(),
      ]);
      const tokenBalance = BigInt(balance.toString());
      if (tokenBalance <= 0n) continue;

      const tokenSymbol =
        typeof symbol === "string" && symbol.trim() ? symbol.trim() : "ERC20";
      const tokenDecimals = Number(decimals);
      assets.push({
        assetId: buildAssetId("ERC20", contractAddress),
        type: "ERC20",
        symbol: tokenSymbol,
        decimals: Number.isNaN(tokenDecimals) ? 18 : tokenDecimals,
        contractAddress,
        balance: tokenBalance.toString(),
        formatted: ethers.formatUnits(
          tokenBalance,
          Number.isNaN(tokenDecimals) ? 18 : tokenDecimals
        ),
      });
    } catch {
      continue;
    }
  }

  return assets;
}

export async function getMaxSendAmountForConnectedWallet(
  address: string,
  assetId: string,
  to?: string
) {
  const normalizedAddress = normalizeAddress(address);
  const parsed = parseAssetId(assetId);
  const assets = await getConnectedWalletAssetBalances(normalizedAddress);
  const selected = assets.find((asset) => asset.assetId === assetId);
  if (!selected) {
    throw new Error("Asset not found in connected wallet");
  }

  if (parsed.type === "ERC20") {
    return {
      assetId: selected.assetId,
      assetType: "ERC20" as const,
      symbol: selected.symbol,
      decimals: selected.decimals,
      balance: selected.balance,
      formattedBalance: selected.formatted,
      maxAmount: selected.balance,
      formattedMax: selected.formatted,
      estimatedGasFee: "0",
      estimatedGasFeeFormatted: "0",
    };
  }

  const balance = BigInt(selected.balance);
  const recipient = to && ethers.isAddress(to) ? to : normalizedAddress;
  let gasLimit = 21_000n;
  try {
    gasLimit = await provider.estimateGas({
      from: normalizedAddress,
      to: recipient,
      value: 0n,
    });
  } catch {
    gasLimit = 21_000n;
  }

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const gasCost = gasLimit * gasPrice;
  const maxAmount = balance > gasCost ? balance - gasCost : 0n;

  return {
    assetId: selected.assetId,
    assetType: "NATIVE" as const,
    symbol: selected.symbol,
    decimals: selected.decimals,
    balance: selected.balance,
    formattedBalance: selected.formatted,
    maxAmount: maxAmount.toString(),
    formattedMax: ethers.formatEther(maxAmount),
    estimatedGasFee: gasCost.toString(),
    estimatedGasFeeFormatted: ethers.formatEther(gasCost),
  };
}

export async function syncConnectedWalletOnChainState(address: string) {
  const [wallet, assets] = await Promise.all([
    getConnectedWalletByAddress(address),
    getConnectedWalletAssetBalances(address),
  ]);

  return {
    wallet,
    assets,
  };
}

export async function issueConnectedWalletChallenge(address: string) {
  const normalizedAddress = normalizeAddress(address);
  const nonce = randomBytes(16).toString("hex");
  const message = buildChallengeMessage(normalizedAddress, nonce);
  const expiresAtMs = Date.now() + CHALLENGE_TTL_MS;

  challengeStore.set(getChallengeKey(normalizedAddress), {
    message,
    expiresAtMs,
  });

  return {
    address: normalizedAddress,
    message,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export async function verifyConnectedWalletChallenge(
  address: string,
  signature: string
) {
  if (!signature || typeof signature !== "string") {
    throw new Error("signature is required");
  }

  const normalizedAddress = normalizeAddress(address);
  const challengeKey = getChallengeKey(normalizedAddress);
  const challenge = challengeStore.get(challengeKey);
  if (!challenge) {
    throw new Error("No active challenge for this wallet");
  }
  if (challenge.expiresAtMs <= Date.now()) {
    challengeStore.delete(challengeKey);
    throw new Error("Challenge expired");
  }

  const recoveredAddress = ethers.verifyMessage(challenge.message, signature);
  if (ethers.getAddress(recoveredAddress) !== normalizedAddress) {
    throw new Error("Invalid signature");
  }

  challengeStore.delete(challengeKey);
  const token = createSessionToken(normalizedAddress);
  const wallet = await getConnectedWalletByAddress(normalizedAddress);

  return {
    token,
    inactivityTimeoutMs: CONNECTED_WALLET_IDLE_TIMEOUT_MS,
    wallet,
  };
}

export async function authenticateConnectedWalletSession(token: string) {
  if (!token) {
    throw new Error("Missing connected wallet session token");
  }

  const parsed = parseAndVerifyToken(token);
  const tokenHash = hashToken(token);
  const now = Date.now();
  const lastActivity = sessionActivityByTokenHash.get(tokenHash);
  if (!lastActivity) {
    throw new Error("Invalid connected wallet session");
  }
  if (now - lastActivity > CONNECTED_WALLET_IDLE_TIMEOUT_MS) {
    sessionActivityByTokenHash.delete(tokenHash);
    throw new Error("Connected wallet session expired");
  }

  sessionActivityByTokenHash.set(tokenHash, now);
  return {
    sessionId: tokenHash,
    wallet: {
      id: parsed.address.toLowerCase(),
      address: parsed.address,
    },
  };
}

export async function revokeConnectedWalletSession(token: string) {
  if (!token) return;
  sessionActivityByTokenHash.delete(hashToken(token));
}
