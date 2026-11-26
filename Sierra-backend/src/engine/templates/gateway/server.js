"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createGateway } = require("./src/app");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "routes.json"), "utf8"));
// Upstream URLs can be overridden per service: UPSTREAM_<NAME>=http://host:port
for (const r of config.routes) { const o = process.env["UPSTREAM_" + r.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")]; if (o) r.target = o; }
const dbPath = process.env.GATEWAY_DB_PATH || "./data/gateway.db";
if (config.auth) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const server = createGateway(config, {
  jwtSecret: process.env.JWT_SECRET,
  dbPath,
  timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 5000),
  jwtTtlSeconds: Number(process.env.JWT_TTL_SECONDS || 3600),
  breaker: { threshold: Number(process.env.BREAKER_THRESHOLD || 5), recoveryMs: Number(process.env.BREAKER_RECOVERY_MS || 10000) },
});
const port = Number(process.env.PORT || 8080);
server.listen(port, "0.0.0.0", () => console.log(`gateway listening on :${port}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
