"use strict";

const { getHerokuAppRole } = require("./heroku-role");
const { run } = require("./heroku-run");

const role = getHerokuAppRole();
run("npm", ["run", "start", `--workspace=apps/${role}`]);
