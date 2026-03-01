"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [email, setEmail] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");
  const [createdKey, setCreatedKey] = useState("");

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

  return (
    <div className="max-w-md mx-auto mt-20">
      <h1 className="text-3xl font-bold mb-2">Vencura Wallet</h1>
      <p className="text-gray-400 mb-8">
        Custodial wallet platform on Ethereum Sepolia
      </p>

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
