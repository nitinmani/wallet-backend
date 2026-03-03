-- Migrate native asset rows to use the sentinel value
UPDATE "Asset" SET "contractAddress" = 'native' WHERE "contractAddress" IS NULL;

-- Drop old composite unique index
DROP INDEX IF EXISTS "Asset_chainId_contractAddress_key";

-- Add lockedAmount column if it doesn't exist yet (idempotent)
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "lockedAmount" TEXT NOT NULL DEFAULT '0';

-- Add deposit-dedup unique constraint; skips rows where txHash IS NULL (internal txs)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Transaction_walletId_txHash_assetType_key'
  ) THEN
    ALTER TABLE "Transaction"
      ADD CONSTRAINT "Transaction_walletId_txHash_assetType_key"
      UNIQUE ("walletId", "txHash", "assetType") DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
