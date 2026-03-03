"use strict";

function getHerokuAppRole() {
  const raw = process.env.HEROKU_APP_ROLE || "api";
  const role = raw.trim().toLowerCase();
  if (role !== "api" && role !== "web") {
    console.error(
      `Invalid HEROKU_APP_ROLE="${raw}". Expected "api" or "web".`
    );
    process.exit(1);
  }
  return role;
}

module.exports = { getHerokuAppRole };
