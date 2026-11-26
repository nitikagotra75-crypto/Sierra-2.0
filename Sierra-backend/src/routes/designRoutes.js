const express = require("express");
const router = express.Router();
const { designSystem, buildFlow } = require("../design/designEngine");
const { generateInfra } = require("../design/infraGenerator");
const { validateInfra } = require("../design/infraValidate");
const { registry } = require("../engine");

router.post("/", (req, res, next) => {
  try {
    res.json(designSystem(req.body || {}));
  } catch (e) { next(e); }
});

router.post("/infra", (req, res, next) => {
  try {
    let { design, stack, name, monitoring } = req.body || {};
    if (stack && !registry.get(stack)) { const e = new Error(`unknown stack '${stack}'`); e.statusCode = 400; throw e; }
    if (design && Array.isArray(design.nodes) && Array.isArray(design.edges)) {
      const ids = new Set(design.nodes.map((n) => n.id));
      const bad = design.edges.find((e) => !ids.has(e.from) || !ids.has(e.to));
      if (bad) { const e = new Error(`edge ${bad.id || ""} references a node that does not exist`); e.statusCode = 400; throw e; }
      // The diagram may have been edited, so derived text is recomputed from the nodes/edges actually sent.
      design = { ...design, requestFlow: buildFlow(design.nodes, design.edges), skipped: design.skipped || [], consistency: design.consistency || [], bottlenecks: design.bottlenecks || [], failureScenarios: design.failureScenarios || [], scalingStrategies: design.scalingStrategies || [] };
      design.nodes = design.nodes.map((n) => ({ rationale: "Added manually in the diagram editor.", tradeoffs: [], config: {}, ...n }));
    }
    const files = generateInfra(design, { stack, name, monitoring: monitoring === false ? false : undefined });
    res.json({ files, validation: validateInfra(files) });
  } catch (e) { next(e); }
});

module.exports = router;
