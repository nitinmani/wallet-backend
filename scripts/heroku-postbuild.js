"use strict";

const { getHerokuAppRole } = require("./heroku-role");
const { run } = require("./heroku-run");

const role = getHerokuAppRole();

if (role === "api") {
  run("npm", ["run", "db:generate"]);
  run("npm", ["run", "build", "--workspace=apps/api"]);
  process.exit(0);
}

run("npm", ["run", "build", "--workspace=apps/web"]);
