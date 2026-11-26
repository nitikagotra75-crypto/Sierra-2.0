const express = require("express");
const router = express.Router();
const controller = require("../controllers/projectController");
const { validateCreateProject } = require("../validators/projectValidators");

router.get("/stacks" , controller.stacks);
router.post("/" , validateCreateProject , controller.create);
router.get("/" ,  controller.list);
router.get("/:id" , controller.getOne);
router.post("/:id/generate" , controller.generate);
router.get("/:id/events" , controller.events);
router.get("/:id/files" , controller.listFiles);
router.get("/:id/files/*" , controller.getFile);
router.get("/:id/test-results" , controller.testResults);
router.get("/:id/status" , controller.status);
router.get("/:id/schema" , controller.schema);
router.get("/:id/download" , controller.download);

module.exports = router;