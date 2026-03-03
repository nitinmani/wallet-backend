/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  testTimeout: 60000,
  setupFiles: ["<rootDir>/tests/env-setup.ts"],
  // setupFilesAfterEnv runs after jest is installed so afterAll() works.
  // The global-teardown hook destroys the ethers provider after each test file
  // to prevent its network-detection retry timer from keeping the process alive.
  setupFilesAfterEnv: ["<rootDir>/tests/global-provider-teardown.ts"],
  // Integration tests share a real PostgreSQL DB and wipe it in beforeEach/beforeAll.
  // Running files in parallel causes them to delete each other's data.
  // maxWorkers: 1 serialises file execution without disabling the worker pool entirely.
  maxWorkers: 1,
};
