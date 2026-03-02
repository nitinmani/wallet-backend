"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";

interface Wallet {
  id: string;
  name: string;
  address: string;
  balance: string;
  ownerId: string;
  walletGroupId: string | null;
  walletGroup?: {
    id: string;
    name: string;
  } | null;
  accesses?: Array<{
    user: {
      id: string;
      email: string;
    };
  }>;
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

interface UserOption {
  id: string;
  email: string;
}

interface GroupWalletOption {
  id: string;
  name: string;
  address: string;
  balance: string;
}

interface TokenBalance {
  tokenAddress: string;
  symbol: string;
  balance: string;
  formatted: string;
  error?: string;
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

function mergeTokenAddresses(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const address of [...existing, ...incoming]) {
    const normalized = address.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(address);
  }
  return merged;
}

function extractTokenAddresses(transactions: Transaction[]): string[] {
  return mergeTokenAddresses(
    [],
    transactions
      .filter((tx) => tx.assetType === "ERC20" && !!tx.tokenAddress)
      .map((tx) => tx.tokenAddress!)
  );
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

export default function WalletDetail() {
  const params = useParams();
  const router = useRouter();
  const walletId = params.id as string;

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  const [signMsg, setSignMsg] = useState("");
  const [signature, setSignature] = useState("");

  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [selectedSendAssetId, setSelectedSendAssetId] = useState("");
  const [sendResult, setSendResult] = useState("");
  const [sendMaxHint, setSendMaxHint] = useState("");
  const [sendingMax, setSendingMax] = useState(false);

  const [transferTo, setTransferTo] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [selectedTransferAssetId, setSelectedTransferAssetId] = useState("");
  const [transferResult, setTransferResult] = useState("");

  const [users, setUsers] = useState<UserOption[]>([]);
  const [groupWalletOptions, setGroupWalletOptions] = useState<GroupWalletOption[]>([]);
  const [shareEmail, setShareEmail] = useState("");
  const [shareResult, setShareResult] = useState("");
  const [syncResult, setSyncResult] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [trackedTokenAddresses, setTrackedTokenAddresses] = useState<string[]>([]);
  const [tokenBalances, setTokenBalances] = useState<TokenBalance[]>([]);
  const [walletAssets, setWalletAssets] = useState<WalletAsset[]>([]);
  const [tokenBalancesLoading, setTokenBalancesLoading] = useState(false);
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

  const [error, setError] = useState("");

  async function refreshTokenBalances(walletIdentifier: string, tokenAddresses: string[]) {
    if (!tokenAddresses.length) {
      setTokenBalances([]);
      return;
    }

    setTokenBalancesLoading(true);
    try {
      const balances = await Promise.all(
        tokenAddresses.map(async (tokenAddress): Promise<TokenBalance> => {
          try {
            const result = await api.getBalance(walletIdentifier, tokenAddress);
            return {
              tokenAddress,
              symbol: result.symbol || "ERC20",
              balance: result.balance || "0",
              formatted: result.formatted || "0",
            };
          } catch (err: any) {
            return {
              tokenAddress,
              symbol: "ERC20",
              balance: "0",
              formatted: "0",
              error: err.message || "Failed to load token balance",
            };
          }
        })
      );
      setTokenBalances(balances);
    } finally {
      setTokenBalancesLoading(false);
    }
  }

  async function load() {
    try {
      const [w, txs, userList, assets] = await Promise.all([
        api.getWallet(walletId),
        api.getTransactions(walletId),
        api.getUsers(),
        api.getWalletAssets(walletId),
      ]);
      setWallet(w);
      setTransactions(txs);
      setUsers(userList);
      setWalletAssets(assets);
      setSelectedSendAssetId((prev) => {
        if (assets.some((asset: WalletAsset) => asset.assetId === prev)) {
          return prev;
        }
        const native = assets.find((asset: WalletAsset) => asset.type === "NATIVE");
        return native?.assetId || assets[0]?.assetId || "";
      });
      setSelectedTransferAssetId((prev) => {
        if (assets.some((asset: WalletAsset) => asset.assetId === prev)) {
          return prev;
        }
        const native = assets.find((asset: WalletAsset) => asset.type === "NATIVE");
        return native?.assetId || assets[0]?.assetId || "";
      });

      if (w.walletGroupId) {
        const group = await api.getWalletGroup(w.walletGroupId);
        const options = (group.wallets || [])
          .filter((groupWallet: any) => groupWallet.id !== w.id)
          .map((groupWallet: any) => ({
            id: groupWallet.id,
            name: groupWallet.name,
            address: groupWallet.address,
            balance: groupWallet.balance,
          }));
        setGroupWalletOptions(options);
        setTransferTo((prev) => {
          if (!options.length) return "";
          return options.some((option: GroupWalletOption) => option.id === prev)
            ? prev
            : options[0].id;
        });
      } else {
        setGroupWalletOptions([]);
        setTransferTo("");
      }

      const discoveredTokens = extractTokenAddresses(txs);
      const mergedTokens = mergeTokenAddresses(trackedTokenAddresses, discoveredTokens);
      setTrackedTokenAddresses(mergedTokens);
      await refreshTokenBalances(w.id, mergedTokens);
    } catch {
      router.push("/dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [walletId]);

  async function handleSign() {
    setError("");
    setSignature("");
    try {
      const result = await api.signMessage(walletId, signMsg);
      setSignature(result.signature);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleSend() {
    setError("");
    setSendResult("");
    setSendMaxHint("");
    if (!selectedSendAssetId) {
      setError("Select an asset to send");
      return;
    }
    try {
      const result = await api.sendTransaction(
        walletId,
        sendTo,
        sendAmount,
        selectedSendAssetId
      );
      setSendResult(result.txHash);
      await load();
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
      const result = await api.getMaxSendAmount(
        walletId,
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

  async function handleTransfer() {
    setError("");
    setTransferResult("");
    if (!transferTo) {
      setError("Select a destination wallet");
      return;
    }
    if (!selectedTransferAssetId) {
      setError("Select an asset to transfer");
      return;
    }
    try {
      const result = await api.internalTransfer(
        walletId,
        transferTo,
        transferAmount,
        selectedTransferAssetId
      );
      setTransferResult(
        `Internal transfer complete. Withdrawal: ${result.debitTxId}, Deposit: ${result.creditTxId}`
      );
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleShare() {
    setError("");
    setShareResult("");
    if (!shareEmail) {
      setError("Select a user to share with");
      return;
    }
    try {
      const result = await api.shareWallet(walletId, shareEmail);
      setShareEmail("");
      setShareResult(`Shared with ${result.sharedWithEmail}`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleManualSync() {
    setError("");
    setSyncResult("");
    setSyncing(true);
    try {
      const result = await api.syncWallet(walletId);
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

      const result = await api.readContract(readContractAddress.trim(), abi, method, args);
      setReadResult(JSON.stringify(result.result, null, 2));
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
      if (!isLikelyEthAddress(writeContractAddress)) {
        throw new Error("Enter a valid contract address");
      }
      const method = writeMethod.trim();
      if (!method) {
        throw new Error("Method is required");
      }

      const abi = parseJsonArrayInput(writeAbi, "ABI");
      const args = parseJsonArrayInput(writeArgs, "Args");
      const result = await api.writeContract(
        walletId,
        writeContractAddress.trim(),
        abi,
        method,
        args,
        writeValueEth.trim() || undefined
      );

      setWriteResult(result.txHash);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setWritingContract(false);
    }
  }

  if (loading) return <p className="text-gray-400 mt-10">Loading...</p>;
  if (!wallet) return <p className="text-red-400 mt-10">Wallet not found</p>;
  const sharedEmails = new Set((wallet.accesses || []).map((access) => access.user.email));
  const shareableUsers = users.filter(
    (user) => user.id !== wallet.ownerId && !sharedEmails.has(user.email)
  );
  const selectedSendAsset =
    walletAssets.find((asset) => asset.assetId === selectedSendAssetId) || null;
  const selectedTransferAsset =
    walletAssets.find((asset) => asset.assetId === selectedTransferAssetId) || null;

  return (
    <div>
      <button
        onClick={() => router.push("/dashboard")}
        className="text-sm text-gray-400 hover:text-white mb-6 inline-block"
      >
        &larr; Back to Dashboard
      </button>

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
          {tokenBalancesLoading ? (
            <p className="text-xs text-gray-500">Loading token balances...</p>
          ) : tokenBalances.length === 0 ? (
            <p className="text-xs text-gray-500">No ERC-20 balances tracked yet.</p>
          ) : (
            <div className="space-y-2">
              {tokenBalances.map((tokenBalance) => (
                <div
                  key={tokenBalance.tokenAddress.toLowerCase()}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <div className="min-w-0">
                    <a
                      href={getSepoliaTokenUrl(tokenBalance.tokenAddress, wallet.address)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-300 hover:text-blue-200 hover:underline font-medium"
                    >
                      {tokenBalance.symbol}
                    </a>
                    <p className="font-mono text-xs text-gray-500">
                      {truncateAddress(tokenBalance.tokenAddress)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono">
                      {tokenBalance.formatted} {tokenBalance.symbol}
                    </p>
                    {tokenBalance.error && (
                      <p className="text-xs text-red-400">{tokenBalance.error}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {wallet.walletGroup && (
          <button
            onClick={() => router.push(`/wallet-groups/${wallet.walletGroup!.id}`)}
            className="text-sm text-emerald-400 mt-3 hover:underline"
          >
            Wallet Group: {wallet.walletGroup.name}
          </button>
        )}
        {(wallet.accesses?.length || 0) > 0 && (
          <div className="mt-3">
            <p className="text-xs text-gray-500 mb-1">Shared With</p>
            {wallet.accesses!.map((access) => (
              <p key={access.user.id} className="text-xs text-gray-300">
                {access.user.email}
              </p>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="p-3 mb-6 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {shareResult && (
        <div className="p-3 mb-6 bg-emerald-900/30 border border-emerald-800 rounded-lg text-emerald-400 text-sm">
          {shareResult}
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
              placeholder={
                selectedSendAsset
                  ? `Amount in ${selectedSendAsset.symbol}`
                  : "Amount"
              }
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
            className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-sm font-medium transition"
          >
            Send
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
            Sends a signed transaction from this wallet.
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

        {wallet.walletGroupId && (
          <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
            <h2 className="font-semibold mb-3">Internal Group Transfer</h2>
            <select
              value={transferTo}
              onChange={(e) => setTransferTo(e.target.value)}
              disabled={groupWalletOptions.length === 0}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
            >
              {groupWalletOptions.length === 0 ? (
                <option value="">No other wallets in this group</option>
              ) : (
                groupWalletOptions.map((groupWallet) => (
                  <option key={groupWallet.id} value={groupWallet.id}>
                    {groupWallet.name} ({truncateAddress(groupWallet.address)}) -{" "}
                    {formatBalance(groupWallet.balance)} ETH
                  </option>
                ))
              )}
            </select>
            <select
              value={selectedTransferAssetId}
              onChange={(e) => {
                setSelectedTransferAssetId(e.target.value);
                setTransferAmount("");
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
            <input
              type="text"
              value={transferAmount}
              onChange={(e) => setTransferAmount(e.target.value)}
              placeholder={
                selectedTransferAsset
                  ? `Amount in ${selectedTransferAsset.symbol}`
                  : "Amount"
              }
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleTransfer}
              className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 rounded-lg text-sm font-medium transition"
            >
              Transfer
            </button>
            {transferResult && (
              <div className="mt-3 p-2 bg-gray-800 rounded text-xs text-green-400">
                {transferResult}
              </div>
            )}
          </div>
        )}

        <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <h2 className="font-semibold mb-3">Share Wallet Access</h2>
          <select
            value={shareEmail}
            onChange={(e) => setShareEmail(e.target.value)}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-500"
          >
            <option value="">Select existing user</option>
            {shareableUsers.map((user) => (
              <option key={user.id} value={user.email}>
                {user.email}
              </option>
            ))}
          </select>
          <button
            onClick={handleShare}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-sm font-medium transition"
          >
            Share
          </button>
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
                    <td className={`py-2 pr-4 ${statusColor[tx.status]}`}>{tx.status}</td>
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
