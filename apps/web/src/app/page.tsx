"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, CONNECTED_WALLET_TOKEN_KEY } from "@/lib/api";

const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";

async function ensureSepoliaNetwork(ethereum: any) {
  const currentChainId = await ethereum.request({ method: "eth_chainId" });
  if (typeof currentChainId === "string" && currentChainId.toLowerCase() === SEPOLIA_CHAIN_ID_HEX) {
    return;
  }

  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
    });
  } catch (err: any) {
    throw new Error(
      err?.message || "Please switch your wallet network to Ethereum Sepolia."
    );
  }
}

export default function Home() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [email, setEmail] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");
  const [createdKey, setCreatedKey] = useState("");
  const [connectingWallet, setConnectingWallet] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    localStorage.setItem("vencura_api_key", apiKey);
    try {
      await api.getMe();
      router.push("/dashboard");
    } catch {
      setError("Invalid API key");
      localStorage.removeItem("vencura_api_key");
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const user = await api.createUser(email);
      setCreatedKey(user.apiKey);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleConnectWallet() {
    setError("");
    setConnectingWallet(true);
    try {
      const ethereum = (window as any).ethereum;
      if (!ethereum) {
        throw new Error("No injected wallet found. Install MetaMask and try again.");
      }
      await ensureSepoliaNetwork(ethereum);

      const accounts = await ethereum.request({ method: "eth_requestAccounts" });
      const address = Array.isArray(accounts) ? accounts[0] : undefined;
      if (!address || typeof address !== "string") {
        throw new Error("No wallet account available");
      }

      const challenge = await api.issueConnectedWalletChallenge(address);
      const signature = await ethereum.request({
        method: "personal_sign",
        params: [challenge.message, address],
      });

      const verified = await api.verifyConnectedWalletChallenge(address, signature);
      localStorage.setItem(CONNECTED_WALLET_TOKEN_KEY, verified.token);
      localStorage.setItem("vencura_connected_wallet_address", verified.wallet.address);
      router.push("/connected-wallet");
    } catch (err: any) {
      setError(err.message || "Failed to connect wallet");
    } finally {
      setConnectingWallet(false);
    }
  }

  if (connectingWallet) {
    return (
      <div className="max-w-md mx-auto mt-28 text-center">
        <h1 className="text-2xl font-bold mb-3">Connecting Metamask Wallet</h1>
        <p className="text-gray-400 mb-6">
          Please approve the network/account/signature prompts in MetaMask.
        </p>
        <div className="w-10 h-10 mx-auto rounded-full border-4 border-gray-700 border-t-emerald-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto mt-20">
      <h1 className="text-3xl font-bold mb-2">Vencura Wallet</h1>
      <p className="text-gray-400 mb-8">
        Custodial wallet platform on Ethereum Sepolia
      </p>
      <button
        type="button"
        onClick={handleConnectWallet}
        disabled={connectingWallet}
        className="w-full py-2 mb-6 bg-emerald-600 hover:bg-emerald-700 rounded-lg font-medium transition disabled:opacity-50"
      >
        Connect Metamask Wallet
      </button>

      {!showCreate ? (
        <>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">API Key</label>
              <input
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="venc_..."
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg focus:outline-none focus:border-blue-500"
              />
            </div>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button
              type="submit"
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition"
            >
              Login
            </button>
          </form>
          <p className="mt-4 text-center text-gray-500">
            No account?{" "}
            <button
              onClick={() => setShowCreate(true)}
              className="text-blue-400 hover:underline"
            >
              Create one
            </button>
          </p>
        </>
      ) : (
        <>
          {createdKey ? (
            <div className="space-y-4">
              <p className="text-green-400">Account created! Save your API key:</p>
              <div className="p-3 bg-gray-900 border border-gray-700 rounded-lg font-mono text-sm break-all">
                {createdKey}
              </div>
              <button
                onClick={() => {
                  setApiKey(createdKey);
                  setShowCreate(false);
                  setCreatedKey("");
                }}
                className="w-full py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition"
              >
                Use this key to login
              </button>
            </div>
          ) : (
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg focus:outline-none focus:border-blue-500"
                />
              </div>
              {error && <p className="text-red-400 text-sm">{error}</p>}
              <button
                type="submit"
                className="w-full py-2 bg-green-600 hover:bg-green-700 rounded-lg font-medium transition"
              >
                Create Account
              </button>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="w-full py-2 text-gray-400 hover:text-white transition"
              >
                Back to login
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
