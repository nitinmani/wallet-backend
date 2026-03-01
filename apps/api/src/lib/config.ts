import dotenv from "dotenv";
import path from "path";

// Resolve .env from project root (works whether run from root or apps/api)
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
if (!process.env.DATABASE_URL) {
  // Fallback: try two levels up from apps/api
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

export const config = {
  databaseUrl: process.env.DATABASE_URL!,
  encryptionKey: process.env.ENCRYPTION_KEY!,
  sepoliaRpcUrl: process.env.SEPOLIA_RPC_URL || "https://sepolia.infura.io/v3/b313741c98fd491090beaf064ce39973",
  port: parseInt(process.env.PORT || "3001", 10),
};

// Validate required env vars at startup
const required = ["DATABASE_URL", "ENCRYPTION_KEY"] as const;
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}
