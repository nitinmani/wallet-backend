import { createHash, randomBytes } from "crypto";
import { ethers } from "ethers";
import { prisma } from "../lib/prisma";
import { provider } from "../lib/provider";
import { ensureNativeAsset, setWalletAssetBalance } from "./assetService";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CONNECTED_WALLET_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

const connectedWalletInclude = {
  walletGroup: true,
  assetBalances: {
    include: { asset: true },
    orderBy: { updatedAt: "desc" as const },
  },
};

function normalizeAddress(address: string): string {
  if (!ethers.isAddress(address)) {
    throw new Error("Invalid wallet address");
  }
  return ethers.getAddress(address);
}

function getNativeBalanceFromWallet(wallet: any): string {
  const native = (wallet.assetBalances || []).find(
    (row: any) => row.asset?.type === "NATIVE" && !row.asset?.contractAddress
  );
  return native?.balance || "0";
}

function decorateConnectedWallet(wallet: any) {
  return {
    ...wallet,
    address: wallet.walletGroup?.address || null,
    balance: getNativeBalanceFromWallet(wallet),
  };
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

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function ensureConnectedWalletForAddress(address: string) {
  const existingGroup = await prisma.walletGroup.findUnique({
    where: { address },
    include: {
      wallets: {
        include: connectedWalletInclude,
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (existingGroup) {
    if (existingGroup.custodyType !== "NON_CUSTODIAL") {
      throw new Error("Address is already used by a custodial wallet");
    }

    if (existingGroup.wallets.length > 1) {
      throw new Error("Non-custodial wallet group is misconfigured");
    }

    if (existingGroup.wallets.length === 1) {
      return decorateConnectedWallet(existingGroup.wallets[0]);
    }

    return prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.create({
        data: {
          name: "Connected Wallet",
          walletGroupId: existingGroup.id,
          ownerId: null,
        },
        include: connectedWalletInclude,
      });
      const nativeAsset = await ensureNativeAsset(tx);
      await setWalletAssetBalance(wallet.id, nativeAsset.id, 0n, tx);
      return decorateConnectedWallet(wallet);
    });
  }

  const lastSyncBlock = await provider.getBlockNumber();
  return prisma.$transaction(async (tx) => {
    const walletGroup = await tx.walletGroup.create({
      data: {
        name: "Connected Wallet Group",
        address,
        encryptedKey: null,
        custodyType: "NON_CUSTODIAL",
        ownerId: null,
        lastSyncBlock,
      },
    });

    const wallet = await tx.wallet.create({
      data: {
        name: "Connected Wallet",
        walletGroupId: walletGroup.id,
        ownerId: null,
      },
      include: connectedWalletInclude,
    });

    const nativeAsset = await ensureNativeAsset(tx);
    await setWalletAssetBalance(wallet.id, nativeAsset.id, 0n, tx);

    return decorateConnectedWallet(wallet);
  });
}

export async function issueConnectedWalletChallenge(address: string) {
  const normalizedAddress = normalizeAddress(address);
  const nonce = randomBytes(16).toString("hex");
  const message = buildChallengeMessage(normalizedAddress, nonce);
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  await prisma.connectedWalletChallenge.updateMany({
    where: {
      address: normalizedAddress,
      consumedAt: null,
    },
    data: { consumedAt: new Date() },
  });

  await prisma.connectedWalletChallenge.create({
    data: {
      address: normalizedAddress,
      nonce,
      message,
      expiresAt,
    },
  });

  return {
    address: normalizedAddress,
    message,
    expiresAt: expiresAt.toISOString(),
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
  const now = new Date();
  const challenge = await prisma.connectedWalletChallenge.findFirst({
    where: {
      address: normalizedAddress,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!challenge) {
    throw new Error("No active challenge for this wallet");
  }

  const recoveredAddress = ethers.verifyMessage(challenge.message, signature);
  if (ethers.getAddress(recoveredAddress) !== normalizedAddress) {
    throw new Error("Invalid signature");
  }

  const consumed = await prisma.connectedWalletChallenge.updateMany({
    where: {
      id: challenge.id,
      consumedAt: null,
    },
    data: { consumedAt: now },
  });

  if (consumed.count !== 1) {
    throw new Error("Challenge already used");
  }

  const wallet = await ensureConnectedWalletForAddress(normalizedAddress);
  const sessionToken = randomBytes(32).toString("hex");
  await prisma.connectedWalletSession.create({
    data: {
      walletId: wallet.id,
      tokenHash: hashSessionToken(sessionToken),
      lastActivityAt: now,
    },
  });

  return {
    token: sessionToken,
    inactivityTimeoutMs: CONNECTED_WALLET_IDLE_TIMEOUT_MS,
    wallet,
  };
}

export async function authenticateConnectedWalletSession(token: string) {
  if (!token) {
    throw new Error("Missing connected wallet session token");
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - CONNECTED_WALLET_IDLE_TIMEOUT_MS);
  const session = await prisma.connectedWalletSession.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: {
      wallet: {
        include: connectedWalletInclude,
      },
    },
  });

  if (!session) {
    throw new Error("Invalid connected wallet session");
  }

  if (session.wallet.walletGroup.custodyType !== "NON_CUSTODIAL") {
    await prisma.connectedWalletSession.delete({ where: { id: session.id } });
    throw new Error("Invalid connected wallet session");
  }

  if (session.lastActivityAt < cutoff) {
    await prisma.connectedWalletSession.delete({ where: { id: session.id } });
    throw new Error("Connected wallet session expired");
  }

  await prisma.connectedWalletSession.update({
    where: { id: session.id },
    data: { lastActivityAt: now },
  });

  return {
    sessionId: session.id,
    wallet: decorateConnectedWallet(session.wallet),
  };
}

export async function revokeConnectedWalletSession(token: string) {
  if (!token) return;
  await prisma.connectedWalletSession.deleteMany({
    where: { tokenHash: hashSessionToken(token) },
  });
}

export async function getConnectedWalletById(walletId: string) {
  const wallet = await prisma.wallet.findFirst({
    where: {
      id: walletId,
      walletGroup: { custodyType: "NON_CUSTODIAL" },
    },
    include: connectedWalletInclude,
  });
  if (!wallet) return null;

  const nativeAsset = await ensureNativeAsset();
  const chainNativeBalance = await provider.getBalance(wallet.walletGroup.address);
  await setWalletAssetBalance(wallet.id, nativeAsset.id, chainNativeBalance);

  return {
    ...decorateConnectedWallet(wallet),
    balance: chainNativeBalance.toString(),
  };
}
