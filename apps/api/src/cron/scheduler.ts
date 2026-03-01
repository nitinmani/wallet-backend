import { syncBalances } from "../services/balanceService";
import { detectDeposits } from "../services/depositDetector";
import { reconcileBroadcastingTransactions } from "../services/transactionService";

const DEPOSIT_INTERVAL = 60_000; // 60 seconds
const BALANCE_SYNC_INTERVAL = 600_000; // 10 minutes
const TX_RECONCILE_INTERVAL = 15_000; // 15 seconds

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
      console.error("Deposit detector error:", err);
    }
  }, DEPOSIT_INTERVAL);

  // Balance sync - every 10 minutes
  setInterval(async () => {
    try {
      await syncBalances();
    } catch (err) {
      console.error("Balance sync error:", err);
    }
  }, BALANCE_SYNC_INTERVAL);

  // Transaction reconciliation - every 15 seconds.
  // Simple polling loop for interview scope; not intended for high-scale production.
  setInterval(async () => {
    try {
      await reconcileBroadcastingTransactions();
    } catch (err) {
      console.error("Transaction reconcile error:", err);
    }
  }, TX_RECONCILE_INTERVAL);

  console.log("Cron scheduler started");
}
