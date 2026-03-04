"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";

interface Wallet {
  id: string;
  name: string;
  address: string;
  balance: string;
}

interface WalletGroup {
  id: string;
  name: string;
  wallets: Wallet[];
}

function formatBalance(wei: string): string {
  try {
    return (Number(wei) / 1e18).toFixed(6);
  } catch {
    return "0.000000";
  }
}

function getSepoliaAddressUrl(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}

export default function WalletGroupDetailPage() {
  const params = useParams();
  const router = useRouter();
  const walletGroupId = params.id as string;

  const [walletGroup, setWalletGroup] = useState<WalletGroup | null>(null);
  const [accessibleWalletIds, setAccessibleWalletIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [walletName, setWalletName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [addingWallet, setAddingWallet] = useState(false);
  const [error, setError] = useState("");

  async function loadWalletGroup() {
    try {
      const [data, accessibleWallets] = await Promise.all([
        api.getWalletGroup(walletGroupId),
        api.getWallets(),
      ]);
      setWalletGroup(data);
      setAccessibleWalletIds(accessibleWallets.map((wallet: Wallet) => wallet.id));
    } catch (err: any) {
      const status = err?.status;
      if (status === 401 || status === 403) {
        localStorage.removeItem("vencura_api_key");
        router.push("/");
        return;
      }
      router.push("/dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWalletGroup();
  }, [walletGroupId]);

  async function handleRenameGroup() {
    if (!walletGroup) return;
    const nextName = walletGroup.name.trim();
    if (!nextName) return;

    setRenaming(true);
    setError("");
    try {
      await api.updateWalletGroup(walletGroup.id, nextName);
      await loadWalletGroup();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRenaming(false);
    }
  }

  async function handleAddWallet() {
    setAddingWallet(true);
    setError("");
    try {
      await api.createWalletInWalletGroup(walletGroupId, walletName || undefined);
      setWalletName("");
      await loadWalletGroup();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAddingWallet(false);
    }
  }

  if (loading) return <p className="text-gray-400 mt-10">Loading...</p>;
  if (!walletGroup) return <p className="text-red-400 mt-10">Wallet group not found</p>;

  return (
    <div>
      <button
        onClick={() => router.push("/dashboard")}
        className="text-sm text-gray-400 hover:text-white mb-6 inline-block"
      >
        &larr; Back to Dashboard
      </button>

      <div className="p-6 bg-gray-900 border border-emerald-900 rounded-lg mb-8">
        <h1 className="text-2xl font-bold mb-3">Wallet Group</h1>
        <div className="flex gap-2 items-end flex-wrap">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Group Name</label>
            <input
              type="text"
              value={walletGroup.name}
              onChange={(e) =>
                setWalletGroup((prev) => (prev ? { ...prev, name: e.target.value } : prev))
              }
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>
          <button
            onClick={handleRenameGroup}
            disabled={renaming}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 rounded-lg text-sm font-medium transition disabled:opacity-50"
          >
            {renaming ? "Saving..." : "Update Group"}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 mb-6 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg mb-8">
        <h2 className="font-semibold mb-3">Add Wallet To Group</h2>
        <div className="flex gap-3 items-end flex-wrap">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Wallet Name (optional)</label>
            <input
              type="text"
              value={walletName}
              onChange={(e) => setWalletName(e.target.value)}
              placeholder="Operations Wallet"
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            onClick={handleAddWallet}
            disabled={addingWallet}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition disabled:opacity-50"
          >
            {addingWallet ? "Adding..." : "Add Wallet"}
          </button>
        </div>
      </div>

      <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
        <h2 className="font-semibold mb-3">Wallets In Group</h2>
        {walletGroup.wallets.length === 0 ? (
          <p className="text-gray-500 text-sm">No wallets in this group yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {walletGroup.wallets.map((wallet) => {
              const isAccessible = accessibleWalletIds.includes(wallet.id);
              return (
                <div
                  key={wallet.id}
                  onClick={
                    isAccessible
                      ? () => router.push(`/wallets/${wallet.id}`)
                      : undefined
                  }
                  className={`p-4 bg-gray-900 border border-gray-800 rounded-lg transition ${
                    isAccessible
                      ? "cursor-pointer hover:border-gray-600"
                      : "cursor-not-allowed opacity-70"
                  }`}
                >
                  <h3 className="font-semibold mb-1">{wallet.name}</h3>
                  <a
                    href={getSepoliaAddressUrl(wallet.address)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs text-blue-300 hover:text-blue-200 hover:underline font-mono mb-2 inline-block"
                  >
                    {wallet.address}
                  </a>
                  <p className="text-sm font-mono">
                    {formatBalance(wallet.balance)}{" "}
                    <span className="text-xs text-gray-500">ETH</span>
                  </p>
                  {!isAccessible && (
                    <p className="text-xs text-gray-500 mt-2">
                      You do not have access to this wallet.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
