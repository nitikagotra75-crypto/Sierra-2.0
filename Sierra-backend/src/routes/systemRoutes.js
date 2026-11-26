const express = require("express");
const router = express.Router();
const { hasTool } = require("../engine/validate");

// Which toolchains this server can actually use to validate generated code.
router.get("/capabilities", async (req, res) => {
  const tools = ["node", "python3", "go", "java", "mvn", "dotnet", "docker"];
  const found = await Promise.all(tools.map(async (t) => [t, await hasTool(t)]));
  res.json({ toolchains: Object.fromEntries(found), llm: require("../agents/llm").provider });
});

module.exports = router;
