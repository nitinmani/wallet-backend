/**
 * Global provider teardown — runs after each test file.
 *
 * Problem: ethers.JsonRpcProvider starts a network-detection loop on creation.
 * When no local node is available (http://127.0.0.1:8545 in the test env), it
 * retries every ~1 s using setTimeout.  That timer is an open handle that
 * prevents Jest from exiting cleanly after all tests complete, producing:
 *   "Jest did not exit one second after the test run has completed"
 *   "Cannot log after tests are done"
 *
 * Fix: call provider.destroy() in an afterAll hook registered via
 * setupFilesAfterEnv.  Jest isolates module caches per test file, so each
 * file gets its own provider instance, and destroying it here only affects
 * the current file's instance — not future test files.
 */
import { provider } from "../src/lib/provider";

afterAll(async () => {
  // destroy() clears the provider's internal timers and connection pool,
  // which is the only thing keeping the Node.js event loop alive after tests.
  await provider.destroy();
});
