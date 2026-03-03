import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

function getAdvisoryLockId(scope: string): bigint {
  const hash = createHash("sha256").update(scope).digest();
  return hash.readBigInt64BE(0);
}

export async function withPgAdvisoryLock<T>(
  scope: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  const advisoryLockId = getAdvisoryLockId(scope);

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${advisoryLockId})`;
      return fn(tx);
    },
    {
      maxWait: 10_000,
      timeout: 30_000,
    }
  );
}
