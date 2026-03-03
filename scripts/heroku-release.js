"use strict";

const { run } = require("./heroku-run");

run("npm", ["run", "db:push"]);
