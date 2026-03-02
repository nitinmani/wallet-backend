"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

interface Wallet {
  id: string;
  name: string;
  address: string;
  balance: string;
  walletGroupId: string | null;
  walletGroup?: {
    id: string;
    name: string;
  } | null;
  accesses?: Array<{ user: { id: string; email: string } }>;
}

interface WalletGroup {
  id: string;
  name: string;
  ownerId: string | null;
  wallets: Wallet[];
}

function formatBalance(wei: string): string {
  try {
    const eth = Number(wei) / 1e18;
    return eth.toFixed(6);
  } catch {
    return "0.000000";
  }
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function getSepoliaAddressUrl(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}

export default function Dashboard() {
  const router = useRouter();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [walletGroups, setWalletGroups] = useState<WalletGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const [creatingWallet, setCreatingWallet] = useState(false);
  const [walletName, setWalletName] = useState("");

  async function loadDashboard() {
    try {
      const [walletData, walletGroupData] = await Promise.all([
        api.getWallets(),
        api.getWalletGroups(),
      ]);
      setWallets(walletData);
      setWalletGroups(walletGroupData);
    } catch {
      router.push("/");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDashboard();
  }, []);

  async function handleCreateWallet() {
    setCreatingWallet(true);
    try {
      await api.createWallet(walletName || undefined);
      setWalletName("");
      await loadDashboard();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setCreatingWallet(false);
    }
  }

  if (loading) {
    return <p className="text-gray-400 mt-10">Loading...</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">Wallet Dashboard</h1>
        <button
          onClick={() => {
            localStorage.removeItem("vencura_api_key");
            router.push("/");
          }}
          className="text-sm text-gray-400 hover:text-white transition"
        >
          Logout
        </button>
      </div>

      <div className="mb-8">
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <h2 className="text-lg font-semibold mb-3">Create Wallet</h2>
          <p className="text-xs text-gray-400 mb-3">
            Each new wallet automatically creates its own wallet group. Add more wallets to that
            group from the wallet group page.
          </p>
          <div className="flex gap-3 items-end flex-wrap">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Name (optional)</label>
              <input
                type="text"
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
                placeholder="My Wallet"
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <button
              onClick={handleCreateWallet}
              disabled={creatingWallet}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition disabled:opacity-50"
            >
              {creatingWallet ? "Creating..." : "Create Wallet"}
            </button>
          </div>
        </div>
      </div>

      <div className="mb-10">
        <h2 className="text-xl font-semibold mb-3">Wallet Groups</h2>
        {walletGroups.length === 0 ? (
          <p className="text-gray-500">No wallet groups yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {walletGroups.map((group) => (
              <div
                key={group.id}
                onClick={() => router.push(`/wallet-groups/${group.id}`)}
                className="p-4 bg-gray-900 border border-emerald-900 rounded-lg cursor-pointer hover:border-emerald-600 transition"
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">{group.name}</h3>
                  <span className="text-xs px-2 py-0.5 rounded-full text-white bg-emerald-600">
                    GROUP
                  </span>
                </div>
                <p className="text-sm text-gray-400">
                  {group.wallets.length} wallet(s)
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="text-xl font-semibold mb-3">Wallets</h2>
        {wallets.length === 0 ? (
          <p className="text-gray-500">No wallets yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {wallets.map((w) => (
              <div
                key={w.id}
                onClick={() => router.push(`/wallets/${w.id}`)}
                className="p-4 bg-gray-900 border border-gray-800 rounded-lg cursor-pointer hover:border-gray-600 transition"
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">{w.name}</h3>
                </div>
                <a
                  href={getSepoliaAddressUrl(w.address)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-sm text-blue-300 hover:text-blue-200 hover:underline font-mono mb-2 inline-block"
                >
                  {truncateAddress(w.address)}
                </a>
                <p className="text-lg font-mono">
                  {formatBalance(w.balance)} <span className="text-sm text-gray-500">ETH</span>
                </p>
                {w.walletGroup && (
                  <p className="text-xs text-emerald-400 mt-2">
                    Wallet Group: {w.walletGroup.name}
                  </p>
                )}
                {(w.accesses?.length || 0) > 0 && (
                  <p className="text-xs text-gray-500 mt-1">
                    Shared with {w.accesses!.length} user(s)
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
