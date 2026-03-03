"use strict";

const { spawnSync } = require("node:child_process");

function run(command, args) {
  const bin =
    process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
  const result = spawnSync(bin, args, { stdio: "inherit", shell: true });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

module.exports = { run };
