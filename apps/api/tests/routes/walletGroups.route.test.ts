import express from "express";
import request from "supertest";

jest.mock("../../src/services/walletService", () => ({
  getUserWalletGroups: jest.fn(),
  getWalletGroupById: jest.fn(),
  createWalletInExistingWalletGroup: jest.fn(),
  updateWalletGroupName: jest.fn(),
  // stub other exports so imports inside walletGroups.ts don't blow up
  createWallet: jest.fn(),
  createWalletInWalletGroup: jest.fn(),
  getUserWallets: jest.fn(),
  getWalletById: jest.fn(),
  getWalletSigningContext: jest.fn(),
  shareWalletWithUser: jest.fn(),
  updateWalletName: jest.fn(),
}));

import { walletGroupRoutes } from "../../src/routes/walletGroups";
import {
  getUserWalletGroups,
  getWalletGroupById,
  createWalletInExistingWalletGroup,
  updateWalletGroupName,
} from "../../src/services/walletService";

const app = express();

beforeAll(() => {
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "user-1", email: "test@vencura.dev", apiKey: "venc_key" } as any;
    next();
  });
  app.use("/api/wallet-groups", walletGroupRoutes);
});

beforeEach(() => jest.clearAllMocks());

describe("GET /api/wallet-groups", () => {
  test("returns all wallet groups for the authenticated user", async () => {
    const mockGroups = [
      { id: "group-1", name: "Treasury", wallets: [] },
      { id: "group-2", name: "Ops", wallets: [] },
    ];
    (getUserWalletGroups as jest.Mock).mockResolvedValue(mockGroups);

    const res = await request(app).get("/api/wallet-groups");

    expect(res.status).toBe(200);
    expect(getUserWalletGroups).toHaveBeenCalledWith("user-1");
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe("group-1");
  });

  test("returns 400 on service error", async () => {
    (getUserWalletGroups as jest.Mock).mockRejectedValue(new Error("DB error"));
    const res = await request(app).get("/api/wallet-groups");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("DB error");
  });
});

describe("GET /api/wallet-groups/:walletGroupId", () => {
  test("returns the wallet group when found", async () => {
    const mockGroup = { id: "group-1", name: "Treasury", wallets: [{ id: "w-1" }] };
    (getWalletGroupById as jest.Mock).mockResolvedValue(mockGroup);

    const res = await request(app).get("/api/wallet-groups/group-1");

    expect(res.status).toBe(200);
    expect(getWalletGroupById).toHaveBeenCalledWith("group-1", "user-1");
    expect(res.body.id).toBe("group-1");
  });

  test("returns 404 when wallet group is not found", async () => {
    (getWalletGroupById as jest.Mock).mockResolvedValue(null);

    const res = await request(app).get("/api/wallet-groups/nonexistent");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Wallet group not found");
  });

  test("returns 400 on service error", async () => {
    (getWalletGroupById as jest.Mock).mockRejectedValue(new Error("DB error"));
    const res = await request(app).get("/api/wallet-groups/group-1");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/wallet-groups/:walletGroupId/wallets", () => {
  test("creates a new wallet in the group and returns 201", async () => {
    const mockWallet = { id: "w-2", name: "Sub Wallet", walletGroupId: "group-1" };
    (createWalletInExistingWalletGroup as jest.Mock).mockResolvedValue(mockWallet);

    const res = await request(app)
      .post("/api/wallet-groups/group-1/wallets")
      .send({ name: "Sub Wallet" });

    expect(res.status).toBe(201);
    expect(createWalletInExistingWalletGroup).toHaveBeenCalledWith(
      "group-1",
      "user-1",
      "Sub Wallet"
    );
    expect(res.body.walletGroupId).toBe("group-1");
  });

  test("returns 400 when service rejects (e.g. duplicate name)", async () => {
    (createWalletInExistingWalletGroup as jest.Mock).mockRejectedValue(
      new Error("Wallet name already exists in this wallet group")
    );

    const res = await request(app)
      .post("/api/wallet-groups/group-1/wallets")
      .send({ name: "Existing Name" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/i);
  });
});

describe("PATCH /api/wallet-groups/:walletGroupId", () => {
  test("returns 400 when name is not a string", async () => {
    const res = await request(app)
      .patch("/api/wallet-groups/group-1")
      .send({ name: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("name is required");
    expect(updateWalletGroupName).not.toHaveBeenCalled();
  });

  test("updates wallet group name and returns the updated group", async () => {
    (updateWalletGroupName as jest.Mock).mockResolvedValue({
      id: "group-1",
      name: "Treasury V2",
    });

    const res = await request(app)
      .patch("/api/wallet-groups/group-1")
      .send({ name: "Treasury V2" });

    expect(res.status).toBe(200);
    expect(updateWalletGroupName).toHaveBeenCalledWith("group-1", "user-1", "Treasury V2");
    expect(res.body.name).toBe("Treasury V2");
  });

  test("returns 400 when group is not found or user has no access", async () => {
    (updateWalletGroupName as jest.Mock).mockRejectedValue(
      new Error("Wallet group not found")
    );

    const res = await request(app)
      .patch("/api/wallet-groups/group-1")
      .send({ name: "Unauthorized" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });
});
