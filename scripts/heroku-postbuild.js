"use strict";

const { run } = require("./heroku-run");

run("npm", ["run", "db:generate"]);
run("npm", ["run", "build", "--workspace=apps/api"]);
run("npm", ["run", "build", "--workspace=apps/web"]);
