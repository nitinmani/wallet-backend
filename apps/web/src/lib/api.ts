const API_BASE = "/api";
export const CONNECTED_WALLET_TOKEN_KEY = "vencura_connected_wallet_token";

function formatWeiToEth(wei: string): string {
  try {
    const value = BigInt(wei);
    const base = BigInt(10) ** BigInt(18);
    const whole = value / base;
    const fraction = (value % base)
      .toString()
      .padStart(18, "0")
      .slice(0, 6)
      .replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return wei;
  }
}

function normalizeApiErrorMessage(message: string): string {
  const raw = (message || "").trim();
  const lower = raw.toLowerCase();

  if (
    lower.includes("insufficient funds for gas * price + value") ||
    lower.includes("insufficient funds")
  ) {
    const haveMatch = raw.match(/have\s+(\d+)/i);
    const wantMatch = raw.match(/want\s+(\d+)/i);

    if (haveMatch?.[1] && wantMatch?.[1]) {
      const haveEth = formatWeiToEth(haveMatch[1]);
      const wantEth = formatWeiToEth(wantMatch[1]);
      return `Insufficient funds: wallet has ${haveEth} ETH but needs about ${wantEth} ETH (amount + gas).`;
    }

    return "Insufficient funds: wallet cannot cover amount plus gas.";
  }

  return raw || "Request failed";
}

function getApiKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("vencura_api_key") || "";
}

function getConnectedWalletToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(CONNECTED_WALLET_TOKEN_KEY) || "";
}

async function apiFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getApiKey(),
      ...options.headers,
    },
  });

  const rawBody = await res.text();
  let data: any = {};

  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch {
      data = { error: rawBody };
    }
  }

  if (!res.ok) {
    const message =
      typeof data?.error === "string"
        ? data.error
        : typeof data?.message === "string"
        ? data.message
        : `Request failed (${res.status})`;
    throw new Error(normalizeApiErrorMessage(message));
  }

  return data;
}

async function connectedWalletFetch(path: string, options: RequestInit = {}) {
  const token = getConnectedWalletToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string> | undefined) || {}),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const rawBody = await res.text();
  let data: any = {};

  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch {
      data = { error: rawBody };
    }
  }

  if (!res.ok) {
    const message =
      typeof data?.error === "string"
        ? data.error
        : typeof data?.message === "string"
        ? data.message
        : `Request failed (${res.status})`;
    throw new Error(normalizeApiErrorMessage(message));
  }

  return data;
}

export const api = {
  // Users
  createUser: (email: string) =>
    apiFetch("/users", { method: "POST", body: JSON.stringify({ email }) }),

  getMe: () => apiFetch("/users/me"),
  getUsers: () => apiFetch("/users"),

  // Wallets
  getWallets: () => apiFetch("/wallets"),

  getWallet: (id: string) => apiFetch(`/wallets/${id}`),

  createWallet: (name?: string) =>
    apiFetch("/wallets", { method: "POST", body: JSON.stringify({ name }) }),

  createWalletInGroup: (sourceWalletId: string, name?: string) =>
    apiFetch(`/wallets/${sourceWalletId}/group-wallet`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  // Wallet Groups
  getWalletGroups: () => apiFetch("/wallet-groups"),
  getWalletGroup: (id: string) => apiFetch(`/wallet-groups/${id}`),
  createWalletInWalletGroup: (walletGroupId: string, name?: string) =>
    apiFetch(`/wallet-groups/${walletGroupId}/wallets`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  syncWalletGroup: (walletGroupId: string) =>
    apiFetch(`/wallet-groups/${walletGroupId}/sync`, {
      method: "POST",
    }),

  updateWallet: (walletId: string, name: string) =>
    apiFetch(`/wallets/${walletId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  syncWallet: (walletId: string) =>
    apiFetch(`/wallets/${walletId}/sync`, {
      method: "POST",
    }),

  updateWalletGroup: (walletGroupId: string, name: string) =>
    apiFetch(`/wallet-groups/${walletGroupId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  shareWallet: (walletId: string, email: string) =>
    apiFetch(`/wallets/${walletId}/share`, {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  // Signing
  signMessage: (walletId: string, message: string) =>
    apiFetch(`/wallets/${walletId}/sign`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),

  // Transactions
  sendTransaction: (
    walletId: string,
    to: string,
    amount: string,
    assetId?: string
  ) =>
    apiFetch(`/wallets/${walletId}/send`, {
      method: "POST",
      body: JSON.stringify({ to, amount, assetId }),
    }),
  getMaxSendAmount: (walletId: string, assetId: string, to?: string) =>
    apiFetch(
      `/wallets/${walletId}/send-max?assetId=${encodeURIComponent(assetId)}${
        to ? `&to=${encodeURIComponent(to)}` : ""
      }`
    ),

  internalTransfer: (
    walletId: string,
    toWalletId: string,
    amount: string,
    assetId?: string
  ) =>
    apiFetch(`/wallets/${walletId}/transfer`, {
      method: "POST",
      body: JSON.stringify({ toWalletId, amount, assetId }),
    }),

  getTransactions: (walletId: string) =>
    apiFetch(`/wallets/${walletId}/transactions`),

  // Generic contract interactions
  readContract: (
    contractAddress: string,
    abi: unknown[],
    method: string,
    args: unknown[] = [],
    blockTag?: string | number
  ) =>
    apiFetch("/contracts/read", {
      method: "POST",
      body: JSON.stringify({ contractAddress, abi, method, args, blockTag }),
    }),

  writeContract: (
    walletId: string,
    contractAddress: string,
    abi: unknown[],
    method: string,
    args: unknown[] = [],
    value?: string,
    gasPrice?: string,
    nonce?: number
  ) =>
    apiFetch(`/contracts/${walletId}/write`, {
      method: "POST",
      body: JSON.stringify({ contractAddress, abi, method, args, value, gasPrice, nonce }),
    }),

  // Balance
  getWalletAssets: (walletId: string) => apiFetch(`/balance/wallet/${walletId}/assets`),
  getBalance: (addressOrId: string, asset?: string) =>
    apiFetch(
      asset
        ? `/balance/${addressOrId}?asset=${encodeURIComponent(asset)}`
        : `/balance/${addressOrId}`
    ),

  // Non-custodial connected wallet
  issueConnectedWalletChallenge: (address: string) =>
    connectedWalletFetch("/connected-wallet/challenge", {
      method: "POST",
      body: JSON.stringify({ address }),
    }),
  verifyConnectedWalletChallenge: (address: string, signature: string) =>
    connectedWalletFetch("/connected-wallet/verify", {
      method: "POST",
      body: JSON.stringify({ address, signature }),
    }),
  connectedWalletLogout: () =>
    connectedWalletFetch("/connected-wallet/logout", {
      method: "POST",
    }),
  connectedWalletGetMe: () => connectedWalletFetch("/connected-wallet/me"),
  connectedWalletGetAssets: () => connectedWalletFetch("/connected-wallet/assets"),
  connectedWalletGetTransactions: () =>
    connectedWalletFetch("/connected-wallet/transactions"),
  connectedWalletSync: () =>
    connectedWalletFetch("/connected-wallet/sync", { method: "POST" }),
  connectedWalletGetMaxSendAmount: (assetId: string, to?: string) =>
    connectedWalletFetch(
      `/connected-wallet/send-max?assetId=${encodeURIComponent(assetId)}${
        to ? `&to=${encodeURIComponent(to)}` : ""
      }`
    ),
  connectedWalletRegisterTx: (
    txHash: string,
    amount: string,
    to?: string,
    assetId?: string,
    nonce?: number
  ) =>
    connectedWalletFetch("/connected-wallet/register-tx", {
      method: "POST",
      body: JSON.stringify({ txHash, amount, to, assetId, nonce }),
    }),
};
