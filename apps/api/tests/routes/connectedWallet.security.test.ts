import express from "express";
import request from "supertest";

jest.mock("../../src/services/connectedWalletService", () => ({
  getConnectedWalletAssetBalances: jest.fn(),
  getConnectedWalletByAddress: jest.fn(),
  getMaxSendAmountForConnectedWallet: jest.fn(),
  issueConnectedWalletChallenge: jest.fn(),
  revokeConnectedWalletSession: jest.fn(),
  syncConnectedWalletOnChainState: jest.fn(),
  verifyConnectedWalletChallenge: jest.fn(),
}));

jest.mock("../../src/services/etherscanService", () => ({
  fetchContractAbiFromEtherscan: jest.fn(),
}));

import { connectedWalletRoutes } from "../../src/routes/connectedWallet";
import {
  issueConnectedWalletChallenge,
  syncConnectedWalletOnChainState,
  verifyConnectedWalletChallenge,
} from "../../src/services/connectedWalletService";

describe("connectedWalletRoutes key material security", () => {
  const app = express();

  beforeAll(() => {
    app.use(express.json());
    app.use("/api/connected-wallet", connectedWalletRoutes);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("challenge rejects payloads containing private key material", async () => {
    const res = await request(app).post("/api/connected-wallet/challenge").send({
      address: "0x9C122F75866c77a619f3298E25FE4aEf246b6b00",
      privateKey: "0xabc",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/never send private key material/i);
    expect(issueConnectedWalletChallenge).not.toHaveBeenCalled();
  });

  test("verify rejects nested payloads containing private key material", async () => {
    const res = await request(app).post("/api/connected-wallet/verify").send({
      address: "0x9C122F75866c77a619f3298E25FE4aEf246b6b00",
      signature: "0xsignature",
      meta: {
        seed_phrase: "test test test test test test test test test test test junk",
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/never send private key material/i);
    expect(verifyConnectedWalletChallenge).not.toHaveBeenCalled();
    expect(syncConnectedWalletOnChainState).not.toHaveBeenCalled();
  });
});
