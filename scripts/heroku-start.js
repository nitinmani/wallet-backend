"use strict";

const { spawn } = require("node:child_process");

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const internalApiPort = process.env.INTERNAL_API_PORT || "3001";
const publicPort = process.env.PORT || "3000";

function spawnNpm(args, envOverrides) {
  return spawn(npmBin, args, {
    stdio: "inherit",
    env: { ...process.env, ...envOverrides },
    shell: true,
  });
}

const apiProcess = spawnNpm(
  ["run", "start", "--workspace=apps/api"],
  { PORT: internalApiPort }
);
const webProcess = spawnNpm(
  ["run", "start", "--workspace=apps/web"],
  { PORT: publicPort }
);

function shutdown(signal) {
  if (!apiProcess.killed) {
    apiProcess.kill(signal);
  }
  if (!webProcess.killed) {
    webProcess.kill(signal);
  }
}

function handleExit(who, code) {
  console.error(`[heroku-start] ${who} exited with code ${code ?? 1}`);
  shutdown("SIGTERM");
  process.exit(code ?? 1);
}

apiProcess.on("exit", (code) => handleExit("api", code));
webProcess.on("exit", (code) => handleExit("web", code));

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
  process.exit(0);
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
  process.exit(0);
});
