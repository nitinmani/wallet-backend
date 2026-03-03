import { ethers } from "ethers";

jest.mock("../../src/lib/provider", () => ({
  provider: {
    getBalance: jest.fn().mockResolvedValue(0n),
  },
}));

import {
  authenticateConnectedWalletSession,
  issueConnectedWalletChallenge,
  verifyConnectedWalletChallenge,
} from "../../src/services/connectedWalletService";

describe("connectedWalletService security", () => {
  test("connected-wallet session token and payload never include private key material", async () => {
    const wallet = ethers.Wallet.createRandom();

    const challenge = await issueConnectedWalletChallenge(wallet.address);
    const signature = await wallet.signMessage(challenge.message);
    const verified = await verifyConnectedWalletChallenge(wallet.address, signature);

    expect((verified.wallet as any).privateKey).toBeUndefined();
    expect((verified.wallet as any).encryptedKey).toBeUndefined();
    expect(JSON.stringify(verified)).not.toMatch(/privateKey|encryptedKey|mnemonic|seed/i);

    const [payload] = String(verified.token).split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

    expect(decoded.address).toBe(wallet.address);
    expect(typeof decoded.iat).toBe("number");
    expect(decoded.privateKey).toBeUndefined();
    expect(decoded.encryptedKey).toBeUndefined();
    expect(decoded.mnemonic).toBeUndefined();
    expect(decoded.seedPhrase).toBeUndefined();

    const session = await authenticateConnectedWalletSession(verified.token);
    expect((session.wallet as any).privateKey).toBeUndefined();
    expect((session.wallet as any).encryptedKey).toBeUndefined();
  });
});
