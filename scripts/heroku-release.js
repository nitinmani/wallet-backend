"use strict";

const { getHerokuAppRole } = require("./heroku-role");
const { run } = require("./heroku-run");

const role = getHerokuAppRole();

if (role === "api") {
  run("npm", ["run", "db:push"]);
  process.exit(0);
}

console.log("Skipping db:push for web role.");
