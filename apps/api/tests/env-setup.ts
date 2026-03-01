import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// Override RPC to local Anvil for tests
process.env.SEPOLIA_RPC_URL = process.env.TEST_RPC_URL || "http://127.0.0.1:8545";
