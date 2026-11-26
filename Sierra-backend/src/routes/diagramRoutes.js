const express = require("express");
const router = express.Router();
const { requireUser } = require("../services/authService");
const d = require("../services/diagramService");

router.use(requireUser);
const h = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

router.get("/", h(async (req, res) => res.json({ diagrams: await d.list(req.user.userId, { projectId: req.query.projectId }) })));
router.post("/", h(async (req, res) => res.status(201).json(await d.create(req.user.userId, req.body || {}))));
router.get("/:id", h(async (req, res) => res.json(await d.get(req.user.userId, req.params.id))));
router.put("/:id", h(async (req, res) => res.json(await d.save(req.user.userId, req.params.id, req.body || {}))));
router.delete("/:id", h(async (req, res) => { await d.remove(req.user.userId, req.params.id); res.status(204).end(); }));
router.get("/:id/versions", h(async (req, res) => res.json({ versions: await d.versions(req.user.userId, req.params.id) })));
router.get("/:id/versions/:n", h(async (req, res) => res.json(await d.getVersion(req.user.userId, req.params.id, req.params.n))));
router.post("/:id/restore/:n", h(async (req, res) => res.json(await d.restore(req.user.userId, req.params.id, Number(req.params.n)))));
router.get("/:id/export", h(async (req, res) => {
  const out = await d.exportDiagram(req.user.userId, req.params.id, String(req.query.format || "json"));
  res.set("Content-Type", out.type).set("Content-Disposition", `attachment; filename="${out.filename.replace(/[^\w.\- ]/g, "_")}"`).send(out.body);
}));

module.exports = router;
