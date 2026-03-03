import { syncBalances } from "../services/balanceService";
import { detectDeposits } from "../services/depositDetector";
import { prisma } from "../lib/prisma";
import { reconcileBroadcastingTransactions } from "../services/transactionService";

const DEPOSIT_INTERVAL = 60_000; // 60 seconds
const BALANCE_SYNC_INTERVAL = 600_000; // 10 minutes
const TX_RECONCILE_INTERVAL = 15_000; // 15 seconds

function isPrismaConnectivityError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  const name = (err as { name?: string }).name || "";
  const message = (err as { message?: string }).message || "";

  if (code === "P1001" || code === "P1002") {
    return true;
  }

  return (
    name.includes("PrismaClientInitializationError") &&
    message.includes("Can't reach database server")
  );
}

async function handleCronError(job: string, err: unknown) {
  if (isPrismaConnectivityError(err)) {
    console.warn(
      `[CRON][${job}] Database unavailable (Prisma connectivity error). Retrying on next tick.`
    );
    try {
      await prisma.$disconnect();
      await prisma.$connect();
      console.log(`[CRON][${job}] Prisma connection restored`);
    } catch {
      // Ignore reconnect errors; cron will retry naturally on next interval.
    }
    return;
  }

  console.error(`[CRON][${job}] Unexpected error:`, err);
}

export function startScheduler(): void {
  console.log("Starting cron scheduler...");

  // Deposit detector - every 60 seconds
  setInterval(async () => {
    try {
      console.log("[CRON][deposit] Tick started");
      const summary = await detectDeposits();
      console.log(
        `[CRON][deposit] Tick finished block=${summary.currentBlock} standardWallets=${summary.standardWalletsScanned} groupKeys=${summary.groupKeysScanned} depositsFound=${summary.depositsFound} blocksFetched=${summary.blocksFetched} durationMs=${summary.durationMs}`
      );
    } catch (err) {
      await handleCronError("deposit", err);
    }
  }, DEPOSIT_INTERVAL);

  // Balance sync - every 10 minutes
  setInterval(async () => {
    try {
      await syncBalances();
    } catch (err) {
      await handleCronError("balance", err);
    }
  }, BALANCE_SYNC_INTERVAL);

  // Transaction reconciliation - every 15 seconds.
  // Simple polling loop for interview scope; not intended for high-scale production.
  setInterval(async () => {
    try {
      await reconcileBroadcastingTransactions();
    } catch (err) {
      await handleCronError("reconcile", err);
    }
  }, TX_RECONCILE_INTERVAL);

  console.log("Cron scheduler started");
}
