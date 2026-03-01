import { ethers } from "ethers";
import { provider } from "../lib/provider";
import { prisma } from "../lib/prisma";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export async function getEthBalance(address: string): Promise<{ balance: string; formatted: string }> {
  const balance = await provider.getBalance(address);
  return {
    balance: balance.toString(),
    formatted: ethers.formatEther(balance),
  };
}

export async function getTokenBalance(
  address: string,
  tokenAddress: string
): Promise<{ balance: string; formatted: string; symbol: string }> {
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [balance, decimals, symbol] = await Promise.all([
    contract.balanceOf(address),
    contract.decimals(),
    contract.symbol(),
  ]);

  return {
    balance: balance.toString(),
    formatted: ethers.formatUnits(balance, decimals),
    symbol,
  };
}

export async function syncBalances(): Promise<void> {
  const wallets = await prisma.wallet.findMany({
    where: { type: "STANDARD" },
  });

  for (const wallet of wallets) {
    try {
      if (!wallet.address) continue;
      const balance = await provider.getBalance(wallet.address);
      await prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: balance.toString() },
      });
    } catch (err) {
      console.error(`Failed to sync balance for wallet ${wallet.id}:`, err);
    }
  }

  console.log(`Synced balances for ${wallets.length} wallets`);
}
