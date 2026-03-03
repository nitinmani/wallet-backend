-- Remove all duplicate native assets keeping only the most recently updated one
DELETE FROM "Asset"
WHERE type = 'NATIVE'
  AND id NOT IN (
    SELECT id FROM "Asset"
    WHERE type = 'NATIVE'
    ORDER BY "updatedAt" DESC
    LIMIT 1
  );

-- Ensure the remaining native asset has the sentinel value
UPDATE "Asset" SET "contractAddress" = 'native' WHERE type = 'NATIVE';

-- Remove duplicate ERC20 entries keeping the latest
DELETE FROM "Asset" a
WHERE type = 'ERC20'
  AND id NOT IN (
    SELECT DISTINCT ON ("contractAddress") id
    FROM "Asset"
    WHERE type = 'ERC20'
    ORDER BY "contractAddress", "updatedAt" DESC
  );
