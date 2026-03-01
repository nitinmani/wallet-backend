import express from "express";
import cors from "cors";
import { errorHandler } from "./middleware/errorHandler";
import { authMiddleware } from "./middleware/auth";
import { userRoutes } from "./routes/users";
import { walletRoutes } from "./routes/wallets";
import { walletGroupRoutes } from "./routes/walletGroups";
import { balanceRoutes } from "./routes/balance";
import { transactionRoutes } from "./routes/transactions";

const app = express();

app.use(cors());
app.use(express.json());

// Health check (no auth)
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Public routes
app.use("/api/users", userRoutes);

// Protected routes
app.use("/api/wallets", authMiddleware, walletRoutes);
app.use("/api/wallet-groups", authMiddleware, walletGroupRoutes);
app.use("/api/balance", authMiddleware, balanceRoutes);
app.use("/api/wallets", authMiddleware, transactionRoutes);

app.use(errorHandler);

export default app;
