"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ethers } from "ethers";
import { api, CONNECTED_WALLET_TOKEN_KEY } from "@/lib/api";

const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";
const SEPOLIA_CHAIN_ID_DEC = 11155111;

interface Wallet {
  id: string;
  name: string;
  address: string;
  balance: string;
  walletGroupId: string | null;
  walletGroup?: {
    id: string;
    name: string;
    custodyType?: "CUSTODIAL" | "NON_CUSTODIAL";
  } | null;
}

interface Transaction {
  id: string;
  type: string;
  assetType: "NATIVE" | "ERC20";
  assetSymbol: string;
  tokenAddress: string | null;
  tokenDecimals: number | null;
  to: string | null;
  from: string | null;
  amount: string;
  txHash: string | null;
  status: string;
  createdAt: string;
}

interface WalletAsset {
  assetId: string;
  type: "NATIVE" | "ERC20";
  symbol: string;
  decimals: number;
  contractAddress: string | null;
  balance: string;
  formatted: string;
}

const statusColor: Record<string, string> = {
  PENDING: "text-yellow-400",
  BROADCASTING: "text-blue-300",
  CONFIRMED: "text-green-400",
  FAILED: "text-red-400",
};

function formatBalance(wei: string): string {
  try {
    return (Number(wei) / 1e18).toFixed(6);
  } catch {
    return "0.000000";
  }
}

function formatUnits(amount: string, decimals: number): string {
  try {
    const value = BigInt(amount);
    const base = BigInt(10) ** BigInt(decimals);
    const whole = value / base;
    const fraction = (value % base)
      .toString()
      .padStart(decimals, "0")
      .slice(0, 6)
      .replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return amount;
  }
}

function formatTransactionAmount(tx: Transaction): string {
  if (tx.assetType === "ERC20") {
    return `${formatUnits(tx.amount, tx.tokenDecimals ?? 18)} ${tx.assetSymbol || "ERC20"}`;
  }
  return `${formatBalance(tx.amount)} ETH`;
}

function getSepoliaAddressUrl(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}

function getSepoliaTxUrl(txHash: string): string {
  return `https://sepolia.etherscan.io/tx/${txHash}`;
}

function getSepoliaTokenUrl(tokenAddress: string, walletAddress?: string): string {
  const base = `https://sepolia.etherscan.io/token/${tokenAddress}`;
  return walletAddress ? `${base}?a=${walletAddress}` : base;
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function isLikelyEthAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function parseJsonArrayInput(rawValue: string, fieldName: string): unknown[] {
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error(`${fieldName} must be a valid JSON array`);
  }
}

function toSerializable(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => toSerializable(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toSerializable(nested);
    }
    return out;
  }
  return value;
}

async function getInjectedSigner(expectedAddress?: string) {
  const ethereum = (window as any).ethereum;
  if (!ethereum) {
    throw new Error("No injected wallet found. Install MetaMask and try again.");
  }
  let provider = new ethers.BrowserProvider(ethereum);
  let network = await provider.getNetwork();
  if (Number(network.chainId) !== SEPOLIA_CHAIN_ID_DEC) {
    try {
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
      });
      provider = new ethers.BrowserProvider(ethereum);
      network = await provider.getNetwork();
    } catch (err: any) {
      throw new Error(
        err?.message || "Please switch your wallet network to Ethereum Sepolia."
      );
    }
    if (Number(network.chainId) !== SEPOLIA_CHAIN_ID_DEC) {
      throw new Error("Wallet network is not Sepolia");
    }
  }
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const signerAddress = await signer.getAddress();
  if (expectedAddress && ethers.getAddress(expectedAddress) !== ethers.getAddress(signerAddress)) {
    throw new Error("Connected browser wallet does not match the linked non-custodial wallet");
  }
  return { provider, signer, signerAddress };
}

export default function ConnectedWalletPage() {
  const router = useRouter();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [walletAssets, setWalletAssets] = useState<WalletAsset[]>([]);
  const [loading, setLoading] = useState(true);

  const [signMsg, setSignMsg] = useState("");
  const [signature, setSignature] = useState("");

  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [selectedSendAssetId, setSelectedSendAssetId] = useState("");
  const [sendResult, setSendResult] = useState("");
  const [sendMaxHint, setSendMaxHint] = useState("");
  const [sendingMax, setSendingMax] = useState(false);
  const [sendingAsset, setSendingAsset] = useState(false);

  const [readContractAddress, setReadContractAddress] = useState("");
  const [readAbi, setReadAbi] = useState(`["function symbol() view returns (string)"]`);
  const [readMethod, setReadMethod] = useState("symbol");
  const [readArgs, setReadArgs] = useState("[]");
  const [readResult, setReadResult] = useState("");
  const [readingContract, setReadingContract] = useState(false);

  const [writeContractAddress, setWriteContractAddress] = useState("");
  const [writeAbi, setWriteAbi] = useState(
    `["function transfer(address to, uint256 amount) returns (bool)"]`
  );
  const [writeMethod, setWriteMethod] = useState("transfer");
  const [writeArgs, setWriteArgs] = useState("[]");
  const [writeValueEth, setWriteValueEth] = useState("");
  const [writeResult, setWriteResult] = useState("");
  const [writingContract, setWritingContract] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const token = localStorage.getItem(CONNECTED_WALLET_TOKEN_KEY);
      if (!token) {
        router.push("/");
        return;
      }

      const [me, txs, assets] = await Promise.all([
        api.connectedWalletGetMe(),
        api.connectedWalletGetTransactions(),
        api.connectedWalletGetAssets(),
      ]);
      setWallet(me);
      setTransactions(txs);
      setWalletAssets(assets);
      setSelectedSendAssetId((prev) => {
        if (assets.some((asset: WalletAsset) => asset.assetId === prev)) {
          return prev;
        }
        const native = assets.find((asset: WalletAsset) => asset.type === "NATIVE");
        return native?.assetId || assets[0]?.assetId || "";
      });
    } catch (err: any) {
      localStorage.removeItem(CONNECTED_WALLET_TOKEN_KEY);
      localStorage.removeItem("vencura_connected_wallet_address");
      setError(err.message || "Connected wallet session invalid");
      router.push("/");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleLogout() {
    try {
      await api.connectedWalletLogout();
    } catch {
      // Ignore logout failures and clear local session anyway.
    }
    localStorage.removeItem(CONNECTED_WALLET_TOKEN_KEY);
    localStorage.removeItem("vencura_connected_wallet_address");
    router.push("/");
  }

  async function handleSign() {
    setError("");
    setSignature("");
    try {
      const { signer } = await getInjectedSigner(wallet?.address);
      const signed = await signer.signMessage(signMsg);
      setSignature(signed);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleSendMax() {
    setError("");
    setSendMaxHint("");
    if (!selectedSendAssetId) {
      setError("Select an asset to send");
      return;
    }
    setSendingMax(true);
    try {
      const result = await api.connectedWalletGetMaxSendAmount(
        selectedSendAssetId,
        sendTo || undefined
      );
      setSendAmount(result.formattedMax);
      if (result.assetType === "NATIVE") {
        setSendMaxHint(
          `Max ${result.symbol}: ${result.formattedMax} (estimated gas ${result.estimatedGasFeeFormatted} ETH)`
        );
      } else {
        setSendMaxHint(`Max ${result.symbol}: ${result.formattedMax}`);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSendingMax(false);
    }
  }

  async function handleSend() {
    setError("");
    setSendResult("");
    setSendMaxHint("");
    if (!wallet) {
      setError("Wallet not loaded");
      return;
    }
    if (!selectedSendAssetId) {
      setError("Select an asset to send");
      return;
    }
    if (!isLikelyEthAddress(sendTo)) {
      setError("Enter a valid recipient address");
      return;
    }

    const selectedAsset =
      walletAssets.find((asset) => asset.assetId === selectedSendAssetId) || null;
    if (!selectedAsset) {
      setError("Selected asset not found");
      return;
    }

    setSendingAsset(true);
    try {
      const { signer } = await getInjectedSigner(wallet.address);
      let txHash = "";
      let nonce: number | undefined = undefined;

      if (selectedAsset.type === "NATIVE") {
        const tx = await signer.sendTransaction({
          to: sendTo,
          value: ethers.parseEther(sendAmount),
        });
        txHash = tx.hash;
        nonce = tx.nonce;
      } else {
        if (!selectedAsset.contractAddress) {
          throw new Error("Selected token is missing contract address");
        }
        const token = new ethers.Contract(
          selectedAsset.contractAddress,
          ["function transfer(address to, uint256 amount) returns (bool)"],
          signer
        );
        const amountUnits = ethers.parseUnits(sendAmount, selectedAsset.decimals);
        const tx = await token.transfer(sendTo, amountUnits);
        txHash = tx.hash;
        nonce = tx.nonce;
      }

      await api.connectedWalletRegisterTx(
        txHash,
        sendAmount,
        sendTo,
        selectedSendAssetId,
        nonce
      );
      setSendResult(txHash);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSendingAsset(false);
    }
  }

  async function handleManualSync() {
    setError("");
    setSyncResult("");
    setSyncing(true);
    try {
      const result = await api.connectedWalletSync();
      setSyncResult(
        `Synced. Reconciled ${result.reconciledCount} withdrawal(s), found ${result.depositSync.depositsFound} deposit(s).`
      );
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  }

  async function handleContractRead() {
    setError("");
    setReadResult("");
    setReadingContract(true);
    try {
      if (!isLikelyEthAddress(readContractAddress)) {
        throw new Error("Enter a valid contract address");
      }
      const method = readMethod.trim();
      if (!method) {
        throw new Error("Method is required");
      }

      const abi = parseJsonArrayInput(readAbi, "ABI");
      const args = parseJsonArrayInput(readArgs, "Args");
      const { provider } = await getInjectedSigner(wallet?.address);
      const contract = new ethers.Contract(
        readContractAddress.trim(),
        abi as ethers.InterfaceAbi,
        provider
      );
      const fn = (contract as any)[method];
      if (!fn || typeof fn !== "function") {
        throw new Error(`Method not found in ABI: ${method}`);
      }
      const result = await fn.staticCall(...args);
      setReadResult(JSON.stringify(toSerializable(result), null, 2));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setReadingContract(false);
    }
  }

  async function handleContractWrite() {
    setError("");
    setWriteResult("");
    setWritingContract(true);
    try {
      if (!wallet) {
        throw new Error("Wallet not loaded");
      }
      if (!isLikelyEthAddress(writeContractAddress)) {
        throw new Error("Enter a valid contract address");
      }
      const method = writeMethod.trim();
      if (!method) {
        throw new Error("Method is required");
      }

      const abi = parseJsonArrayInput(writeAbi, "ABI");
      const args = parseJsonArrayInput(writeArgs, "Args");
      const { signer } = await getInjectedSigner(wallet.address);
      const contract = new ethers.Contract(
        writeContractAddress.trim(),
        abi as ethers.InterfaceAbi,
        signer
      );
      const fn = (contract as any)[method];
      if (!fn || typeof fn !== "function") {
        throw new Error(`Method not found in ABI: ${method}`);
      }

      const tx = await fn(
        ...args,
        writeValueEth.trim() ? { value: ethers.parseEther(writeValueEth.trim()) } : {}
      );

      const nativeAsset = walletAssets.find((asset) => asset.type === "NATIVE");
      await api.connectedWalletRegisterTx(
        tx.hash,
        writeValueEth.trim() || "0",
        writeContractAddress.trim(),
        nativeAsset?.assetId,
        tx.nonce
      );

      setWriteResult(tx.hash);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setWritingContract(false);
    }
  }

  if (loading) return <p className="text-gray-400 mt-10">Loading...</p>;
  if (!wallet) return <p className="text-red-400 mt-10">Connected wallet not found</p>;

  const selectedSendAsset =
    walletAssets.find((asset) => asset.assetId === selectedSendAssetId) || null;
  const tokenAssets = walletAssets.filter((asset) => asset.type === "ERC20");

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => router.push("/")}
          className="text-sm text-gray-400 hover:text-white inline-block"
        >
          &larr; Back to Home
        </button>
        <button
          onClick={handleLogout}
          className="text-sm text-red-400 hover:text-red-300 transition"
        >
          Disconnect
        </button>
      </div>

      <div className="p-6 bg-gray-900 border border-gray-800 rounded-lg mb-8">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <h1 className="text-2xl font-bold">{wallet.name}</h1>
          <button
            onClick={handleManualSync}
            disabled={syncing}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-xs font-medium transition disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync Now"}
          </button>
        </div>
        <a
          href={getSepoliaAddressUrl(wallet.address)}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-blue-300 hover:text-blue-200 hover:underline font-mono mb-2 inline-block"
        >
          {wallet.address}
        </a>
        <p className="text-2xl font-mono">
          {formatBalance(wallet.balance)} <span className="text-sm text-gray-500">ETH</span>
        </p>
        <div className="mt-4 p-3 bg-gray-800/50 border border-gray-700 rounded-lg">
          <p className="text-xs text-gray-400 mb-2">Tracked Token Balances</p>
          {tokenAssets.length === 0 ? (
            <p className="text-xs text-gray-500">No ERC-20 balances tracked yet.</p>
          ) : (
            <div className="space-y-2">
              {tokenAssets.map((asset) => (
                <div
                  key={asset.assetId}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <div className="min-w-0">
                    {asset.contractAddress ? (
                      <a
                        href={getSepoliaTokenUrl(asset.contractAddress, wallet.address)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-300 hover:text-blue-200 hover:underline font-medium"
                      >
                        {asset.symbol}
                      </a>
                    ) : (
                      <p className="font-medium">{asset.symbol}</p>
                    )}
                    {asset.contractAddress && (
                      <p className="font-mono text-xs text-gray-500">
                        {truncateAddress(asset.contractAddress)}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="font-mono">
                      {asset.formatted} {asset.symbol}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="p-3 mb-6 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {syncResult && (
        <div className="p-3 mb-6 bg-blue-900/30 border border-blue-800 rounded-lg text-blue-300 text-sm">
          {syncResult}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <h2 className="font-semibold mb-3">Sign Message</h2>
          <input
            type="text"
            value={signMsg}
            onChange={(e) => setSignMsg(e.target.value)}
            placeholder="Message to sign"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleSign}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition"
          >
            Sign
          </button>
          {signature && (
            <div className="mt-3 p-2 bg-gray-800 rounded text-xs font-mono break-all">
              {signature}
            </div>
          )}
        </div>

        <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <h2 className="font-semibold mb-3">Send Asset</h2>
          <input
            type="text"
            value={sendTo}
            onChange={(e) => setSendTo(e.target.value)}
            placeholder="Recipient address (0x...)"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
          />
          <select
            value={selectedSendAssetId}
            onChange={(e) => {
              setSelectedSendAssetId(e.target.value);
              setSendAmount("");
              setSendMaxHint("");
            }}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
          >
            {walletAssets.length === 0 ? (
              <option value="">No assets available</option>
            ) : (
              walletAssets.map((asset) => (
                <option key={asset.assetId} value={asset.assetId}>
                  {asset.symbol} ({asset.formatted})
                </option>
              ))
            )}
          </select>
          {selectedSendAsset && (
            <p className="text-xs text-gray-500 mb-2">
              Available: {selectedSendAsset.formatted} {selectedSendAsset.symbol}
            </p>
          )}
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={sendAmount}
              onChange={(e) => setSendAmount(e.target.value)}
              placeholder={selectedSendAsset ? `Amount in ${selectedSendAsset.symbol}` : "Amount"}
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleSendMax}
              disabled={sendingMax || !selectedSendAssetId}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition disabled:opacity-50"
            >
              {sendingMax ? "..." : "Send Max"}
            </button>
          </div>
          <button
            onClick={handleSend}
            disabled={sendingAsset}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-sm font-medium transition disabled:opacity-50"
          >
            {sendingAsset ? "Sending..." : "Send"}
          </button>
          {sendMaxHint && (
            <div className="mt-3 p-2 bg-gray-800 rounded text-xs text-gray-300">{sendMaxHint}</div>
          )}
          {sendResult && (
            <div className="mt-3 p-2 bg-gray-800 rounded text-xs font-mono break-all">
              Tx Hash:{" "}
              <a
                href={getSepoliaTxUrl(sendResult)}
                target="_blank"
                rel="noreferrer"
                className="text-blue-300 hover:text-blue-200 hover:underline"
              >
                {sendResult}
              </a>
            </div>
          )}
        </div>

        <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <h2 className="font-semibold mb-3">Contract Read</h2>
          <p className="text-xs text-gray-500 mb-2">View/pure calls only (no transaction).</p>
          <input
            type="text"
            value={readContractAddress}
            onChange={(e) => setReadContractAddress(e.target.value)}
            placeholder="Contract address (0x...)"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
          />
          <input
            type="text"
            value={readMethod}
            onChange={(e) => setReadMethod(e.target.value)}
            placeholder="Method (e.g. symbol)"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
          />
          <textarea
            value={readAbi}
            onChange={(e) => setReadAbi(e.target.value)}
            placeholder='ABI JSON array, e.g. ["function symbol() view returns (string)"]'
            rows={3}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs font-mono mb-2 focus:outline-none focus:border-blue-500"
          />
          <textarea
            value={readArgs}
            onChange={(e) => setReadArgs(e.target.value)}
            placeholder='Args JSON array, e.g. [] or ["0x..."]'
            rows={2}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs font-mono mb-2 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleContractRead}
            disabled={readingContract}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 rounded-lg text-sm font-medium transition disabled:opacity-50"
          >
            {readingContract ? "Reading..." : "Read Contract"}
          </button>
          {readResult && (
            <pre className="mt-3 p-2 bg-gray-800 rounded text-xs font-mono whitespace-pre-wrap break-all">
              {readResult}
            </pre>
          )}
        </div>

        <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <h2 className="font-semibold mb-3">Contract Write</h2>
          <p className="text-xs text-gray-500 mb-2">
            Sends a signed transaction from your connected wallet.
          </p>
          <input
            type="text"
            value={writeContractAddress}
            onChange={(e) => setWriteContractAddress(e.target.value)}
            placeholder="Contract address (0x...)"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
          />
          <input
            type="text"
            value={writeMethod}
            onChange={(e) => setWriteMethod(e.target.value)}
            placeholder="Method (e.g. transfer)"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
          />
          <textarea
            value={writeAbi}
            onChange={(e) => setWriteAbi(e.target.value)}
            placeholder='ABI JSON array, e.g. ["function transfer(address to, uint256 amount) returns (bool)"]'
            rows={3}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs font-mono mb-2 focus:outline-none focus:border-blue-500"
          />
          <textarea
            value={writeArgs}
            onChange={(e) => setWriteArgs(e.target.value)}
            placeholder='Args JSON array, e.g. ["0xRecipient", "1000000"]'
            rows={2}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs font-mono mb-2 focus:outline-none focus:border-blue-500"
          />
          <input
            type="text"
            value={writeValueEth}
            onChange={(e) => setWriteValueEth(e.target.value)}
            placeholder="Optional native value in ETH (e.g. 0.01)"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleContractWrite}
            disabled={writingContract}
            className="px-4 py-2 bg-rose-600 hover:bg-rose-700 rounded-lg text-sm font-medium transition disabled:opacity-50"
          >
            {writingContract ? "Writing..." : "Write Contract"}
          </button>
          {writeResult && (
            <div className="mt-3 p-2 bg-gray-800 rounded text-xs font-mono break-all">
              Tx Hash:{" "}
              <a
                href={getSepoliaTxUrl(writeResult)}
                target="_blank"
                rel="noreferrer"
                className="text-blue-300 hover:text-blue-200 hover:underline"
              >
                {writeResult}
              </a>
            </div>
          )}
        </div>
      </div>

      <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
        <h2 className="font-semibold mb-3">Transaction History</h2>
        {transactions.length === 0 ? (
          <p className="text-gray-500 text-sm">No transactions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 border-b border-gray-800">
                  <th className="text-left py-2 pr-4">Type</th>
                  <th className="text-left py-2 pr-4">Amount</th>
                  <th className="text-left py-2 pr-4">To/From</th>
                  <th className="text-left py-2 pr-4">Status</th>
                  <th className="text-left py-2">Tx Hash</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.id} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4">
                      <span
                        className={
                          tx.type === "DEPOSIT"
                            ? "text-green-400"
                            : tx.type === "WITHDRAWAL"
                            ? "text-red-400"
                            : "text-yellow-400"
                        }
                      >
                        {tx.type}
                      </span>
                    </td>
                    <td className="py-2 pr-4 font-mono">{formatTransactionAmount(tx)}</td>
                    <td className="py-2 pr-4 font-mono text-gray-400">
                      {(tx.type === "DEPOSIT" ? tx.from : tx.to)
                        ? `${(tx.type === "DEPOSIT" ? tx.from : tx.to)!.slice(0, 10)}...`
                        : "N/A"}
                    </td>
                    <td className={`py-2 pr-4 ${statusColor[tx.status] || "text-gray-400"}`}>
                      {tx.status}
                    </td>
                    <td className="py-2 font-mono text-xs text-gray-500">
                      {tx.txHash ? (
                        <a
                          href={getSepoliaTxUrl(tx.txHash)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-300 hover:text-blue-200 hover:underline"
                        >
                          {tx.txHash.slice(0, 14)}...
                        </a>
                      ) : (
                        "None"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
