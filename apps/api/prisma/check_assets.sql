SELECT "contractAddress", COUNT(*) FROM "Asset" GROUP BY "contractAddress";
SELECT id, type, symbol, "contractAddress" FROM "Asset" ORDER BY "createdAt";
