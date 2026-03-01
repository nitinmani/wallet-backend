const lockQueue = new Map<string, Promise<void>>();

// Simple in-process mutex for interview scope.
// Limitation: this only serializes work inside one Node.js process.
// In production with multiple instances, replace with a distributed lock.
export async function withKeyMutex<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const prior = lockQueue.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const tail = prior.catch(() => undefined).then(() => gate);
  lockQueue.set(key, tail);

  await prior.catch(() => undefined);

  try {
    return await fn();
  } finally {
    release();
    if (lockQueue.get(key) === tail) {
      lockQueue.delete(key);
    }
  }
}
