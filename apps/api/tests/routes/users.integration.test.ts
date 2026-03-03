import request from "supertest";
import { prisma } from "../../src/lib/prisma";

let app: any;
let testApiKey: string;

jest.setTimeout(60_000);

async function createUser(email: string) {
  const res = await request(app).post("/api/users").send({ email });
  return res.body;
}

beforeAll(async () => {
  const appModule = await import("../../src/app");
  app = appModule.default;
});

beforeEach(async () => {
  await prisma.transaction.deleteMany();
  await prisma.walletAccess.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.walletGroup.deleteMany();
  await prisma.user.deleteMany();

  const user = await createUser(
    `users-${Date.now()}-${Math.floor(Math.random() * 1000)}@vencura.dev`
  );
  testApiKey = user.apiKey;
});

afterAll(async () => {
  await prisma.transaction.deleteMany();
  await prisma.walletAccess.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.walletGroup.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
});

describe("usersApi", () => {
  test("returns existing users for UI dropdown", async () => {
    const extraUser = await createUser("dropdown-users@vencura.dev");
    expect(extraUser.id).toBeDefined();

    const listRes = await request(app)
      .get("/api/users")
      .set("x-api-key", testApiKey);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.some((u: any) => u.email === "dropdown-users@vencura.dev")).toBe(true);
    expect(listRes.body.every((u: any) => !("apiKey" in u))).toBe(true);
  });
});
