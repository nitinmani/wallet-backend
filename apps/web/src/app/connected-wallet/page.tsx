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

function formatBalance(wei: string): string {
  try {
    return ethers.formatEther(wei);
  } catch {
    return "0";
  }
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

function hasPositiveBalance(balance: string): boolean {
  try {
    return BigInt(balance) > BigInt(0);
  } catch {
    return false;
  }
}

function isLikelyEthAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

interface AbiInputParam {
  name?: string;
  type?: string;
}

interface AbiFunctionOption {
  key: string;
  label: string;
  inputs: AbiInputParam[];
}

function parseAbiFunctionOptions(
  abi: unknown[],
  mode: "read" | "write"
): AbiFunctionOption[] {
  const options: AbiFunctionOption[] = [];

  for (const entry of abi) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "function" || typeof record.name !== "string") continue;

    const stateMutability =
      typeof record.stateMutability === "string" ? record.stateMutability : "nonpayable";
    const isRead = stateMutability === "view" || stateMutability === "pure";
    if (mode === "read" && !isRead) continue;
    if (mode === "write" && isRead) continue;

    const inputs = Array.isArray(record.inputs)
      ? record.inputs
          .filter((input) => input && typeof input === "object")
          .map((input) => {
            const typedInput = input as Record<string, unknown>;
            return {
              name: typeof typedInput.name === "string" ? typedInput.name : undefined,
              type: typeof typedInput.type === "string" ? typedInput.type : undefined,
            };
          })
      : [];

    const signature = `${record.name}(${inputs
      .map((input) => input.type || "unknown")
      .join(",")})`;
    const label = `${record.name}(${inputs
      .map((input, index) => `${input.name || `arg${index + 1}`}: ${input.type || "unknown"}`)
      .join(", ")})`;

    options.push({ key: signature, label, inputs });
  }

  return options;
}

function toContractArgValue(raw: string, inputType?: string): unknown {
  const normalizedType = (inputType || "").trim().toLowerCase();
  const trimmed = raw.trim();

  if (!normalizedType) return raw;

  if (normalizedType.endsWith("[]") || normalizedType.startsWith("tuple")) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Argument (${inputType}) must be valid JSON`);
    }
  }

  if (normalizedType === "bool") {
    if (trimmed.toLowerCase() === "true") return true;
    if (trimmed.toLowerCase() === "false") return false;
    throw new Error("Boolean argument must be true or false");
  }

  if (normalizedType.startsWith("uint") || normalizedType.startsWith("int")) {
    if (!trimmed) {
      throw new Error(`Argument (${inputType}) cannot be empty`);
    }
    return trimmed;
  }

  return raw;
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
  const [readAbi, setReadAbi] = useState<unknown[]>([]);
  const [readFunctions, setReadFunctions] = useState<AbiFunctionOption[]>([]);
  const [selectedReadFunction, setSelectedReadFunction] = useState("");
  const [readArgValues, setReadArgValues] = useState<string[]>([]);
  const [loadingReadAbi, setLoadingReadAbi] = useState(false);
  const [readResult, setReadResult] = useState("");
  const [readingContract, setReadingContract] = useState(false);

  const [writeContractAddress, setWriteContractAddress] = useState("");
  const [writeAbi, setWriteAbi] = useState<unknown[]>([]);
  const [writeFunctions, setWriteFunctions] = useState<AbiFunctionOption[]>([]);
  const [selectedWriteFunction, setSelectedWriteFunction] = useState("");
  const [writeArgValues, setWriteArgValues] = useState<string[]>([]);
  const [loadingWriteAbi, setLoadingWriteAbi] = useState(false);
  const [writeValueEth, setWriteValueEth] = useState("");
  const [writeResult, setWriteResult] = useState("");
  const [writingContract, setWritingContract] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState("");
  const [error, setError] = useState("");

  function normalizeSelectedAsset(assets: WalletAsset[], preferred: string) {
    const visibleAssets = assets.filter((asset) => hasPositiveBalance(asset.balance));
    if (visibleAssets.some((asset) => asset.assetId === preferred)) return preferred;
    const native = visibleAssets.find((asset) => asset.type === "NATIVE");
    return native?.assetId || visibleAssets[0]?.assetId || "";
  }

  async function load() {
    try {
      const token = localStorage.getItem(CONNECTED_WALLET_TOKEN_KEY);
      if (!token) {
        router.push("/");
        return;
      }

      const [me, assets] = await Promise.all([
        api.connectedWalletGetMe(),
        api.connectedWalletGetAssets(),
      ]);
      setWallet(me);
      setWalletAssets(assets);
      setSelectedSendAssetId((prev) => normalizeSelectedAsset(assets, prev));
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

      if (selectedAsset.type === "NATIVE") {
        const tx = await signer.sendTransaction({
          to: sendTo,
          value: ethers.parseEther(sendAmount),
        });
        txHash = tx.hash;
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
      }

      setSendResult(txHash);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSendingAsset(false);
    }
  }

  async function handleRefreshBalances() {
    setError("");
    setSyncResult("");
    setSyncing(true);
    try {
      const result = await api.connectedWalletSync();
      setWallet(result.wallet);
      setWalletAssets(result.assets || []);
      setSelectedSendAssetId((prev) =>
        normalizeSelectedAsset(result.assets || [], prev)
      );
      setSyncResult("Balances refreshed.");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  }

  function handleReadFunctionSelection(signature: string, options = readFunctions) {
    setSelectedReadFunction(signature);
    const selected = options.find((option) => option.key === signature);
    setReadArgValues(new Array(selected?.inputs.length || 0).fill(""));
  }

  function handleWriteFunctionSelection(signature: string, options = writeFunctions) {
    setSelectedWriteFunction(signature);
    const selected = options.find((option) => option.key === signature);
    setWriteArgValues(new Array(selected?.inputs.length || 0).fill(""));
  }

  async function handleLoadReadAbi() {
    setError("");
    setReadResult("");
    setLoadingReadAbi(true);
    try {
      if (!isLikelyEthAddress(readContractAddress)) {
        throw new Error("Enter a valid contract address");
      }

      const { abi } = await api.connectedWalletGetContractAbi(readContractAddress.trim());
      const readOptions = parseAbiFunctionOptions(abi, "read");
      if (!readOptions.length) {
        throw new Error("No read functions found in ABI");
      }

      setReadAbi(abi);
      setReadFunctions(readOptions);
      handleReadFunctionSelection(readOptions[0].key, readOptions);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingReadAbi(false);
    }
  }

  async function handleLoadWriteAbi() {
    setError("");
    setWriteResult("");
    setLoadingWriteAbi(true);
    try {
      if (!isLikelyEthAddress(writeContractAddress)) {
        throw new Error("Enter a valid contract address");
      }

      const { abi } = await api.connectedWalletGetContractAbi(writeContractAddress.trim());
      const writeOptions = parseAbiFunctionOptions(abi, "write");
      if (!writeOptions.length) {
        throw new Error("No write functions found in ABI");
      }

      setWriteAbi(abi);
      setWriteFunctions(writeOptions);
      handleWriteFunctionSelection(writeOptions[0].key, writeOptions);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingWriteAbi(false);
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
      if (!selectedReadFunction) {
        throw new Error("Load ABI and select a function");
      }
      if (!readAbi.length) {
        throw new Error("Load ABI first");
      }
      const selected = readFunctions.find((option) => option.key === selectedReadFunction);
      if (!selected) {
        throw new Error("Selected read function not found");
      }

      const args = selected.inputs.map((input, index) =>
        toContractArgValue(readArgValues[index] || "", input.type)
      );
      const { provider } = await getInjectedSigner(wallet?.address);
      const contract = new ethers.Contract(
        readContractAddress.trim(),
        readAbi as ethers.InterfaceAbi,
        provider
      );
      const fn = (contract as any)[selectedReadFunction];
      if (!fn || typeof fn !== "function") {
        throw new Error(`Method not found in ABI: ${selectedReadFunction}`);
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
      if (!selectedWriteFunction) {
        throw new Error("Load ABI and select a function");
      }
      if (!writeAbi.length) {
        throw new Error("Load ABI first");
      }
      const selected = writeFunctions.find((option) => option.key === selectedWriteFunction);
      if (!selected) {
        throw new Error("Selected write function not found");
      }

      const args = selected.inputs.map((input, index) =>
        toContractArgValue(writeArgValues[index] || "", input.type)
      );
      const { signer } = await getInjectedSigner(wallet.address);
      const contract = new ethers.Contract(
        writeContractAddress.trim(),
        writeAbi as ethers.InterfaceAbi,
        signer
      );
      const fn = (contract as any)[selectedWriteFunction];
      if (!fn || typeof fn !== "function") {
        throw new Error(`Method not found in ABI: ${selectedWriteFunction}`);
      }

      const tx = await fn(
        ...args,
        writeValueEth.trim() ? { value: ethers.parseEther(writeValueEth.trim()) } : {}
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

  const visibleWalletAssets = walletAssets.filter((asset) =>
    hasPositiveBalance(asset.balance)
  );
  const selectedSendAsset =
    visibleWalletAssets.find((asset) => asset.assetId === selectedSendAssetId) || null;
  const tokenAssets = visibleWalletAssets.filter((asset) => asset.type === "ERC20");

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
            onClick={handleRefreshBalances}
            disabled={syncing}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-xs font-medium transition disabled:opacity-50"
          >
            {syncing ? "Refreshing..." : "Refresh Balances"}
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
            <p className="text-xs text-gray-500">No ERC-20 balances found.</p>
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
            {visibleWalletAssets.length === 0 ? (
              <option value="">No assets available</option>
            ) : (
              visibleWalletAssets.map((asset) => (
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
            <div className="mt-3 p-2 bg-gray-800 rounded text-xs text-gray-300">
              {sendMaxHint}
            </div>
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
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={readContractAddress}
              onChange={(e) => {
                setReadContractAddress(e.target.value);
                setReadFunctions([]);
                setSelectedReadFunction("");
                setReadArgValues([]);
                setReadResult("");
              }}
              placeholder="Contract address (0x...)"
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleLoadReadAbi}
              disabled={loadingReadAbi}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition disabled:opacity-50"
            >
              {loadingReadAbi ? "Loading..." : "Load ABI"}
            </button>
          </div>
          <select
            value={selectedReadFunction}
            onChange={(e) => handleReadFunctionSelection(e.target.value)}
            disabled={readFunctions.length === 0}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
          >
            {readFunctions.length === 0 ? (
              <option value="">Load ABI to choose a read function</option>
            ) : (
              readFunctions.map((fn) => (
                <option key={fn.key} value={fn.key}>
                  {fn.label}
                </option>
              ))
            )}
          </select>
          {(readFunctions.find((fn) => fn.key === selectedReadFunction)?.inputs || []).map(
            (input, index) => (
              <input
                key={`${selectedReadFunction}-arg-${index}`}
                type="text"
                value={readArgValues[index] || ""}
                onChange={(e) =>
                  setReadArgValues((prev) => {
                    const next = [...prev];
                    next[index] = e.target.value;
                    return next;
                  })
                }
                placeholder={`${input.name || `arg${index + 1}`} (${input.type || "unknown"})`}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
              />
            )
          )}
          <button
            onClick={handleContractRead}
            disabled={readingContract || !selectedReadFunction}
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
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={writeContractAddress}
              onChange={(e) => {
                setWriteContractAddress(e.target.value);
                setWriteFunctions([]);
                setSelectedWriteFunction("");
                setWriteArgValues([]);
                setWriteResult("");
              }}
              placeholder="Contract address (0x...)"
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleLoadWriteAbi}
              disabled={loadingWriteAbi}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition disabled:opacity-50"
            >
              {loadingWriteAbi ? "Loading..." : "Load ABI"}
            </button>
          </div>
          <select
            value={selectedWriteFunction}
            onChange={(e) => handleWriteFunctionSelection(e.target.value)}
            disabled={writeFunctions.length === 0}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
          >
            {writeFunctions.length === 0 ? (
              <option value="">Load ABI to choose a write function</option>
            ) : (
              writeFunctions.map((fn) => (
                <option key={fn.key} value={fn.key}>
                  {fn.label}
                </option>
              ))
            )}
          </select>
          {(writeFunctions.find((fn) => fn.key === selectedWriteFunction)?.inputs || []).map(
            (input, index) => (
              <input
                key={`${selectedWriteFunction}-arg-${index}`}
                type="text"
                value={writeArgValues[index] || ""}
                onChange={(e) =>
                  setWriteArgValues((prev) => {
                    const next = [...prev];
                    next[index] = e.target.value;
                    return next;
                  })
                }
                placeholder={`${input.name || `arg${index + 1}`} (${input.type || "unknown"})`}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
              />
            )
          )}
          <input
            type="text"
            value={writeValueEth}
            onChange={(e) => setWriteValueEth(e.target.value)}
            placeholder="Optional native value in ETH (e.g. 0.01)"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleContractWrite}
            disabled={writingContract || !selectedWriteFunction}
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
    </div>
  );
}
