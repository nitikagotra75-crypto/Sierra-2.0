const express = require("express");
const router = express.Router();
const auth = require("../services/authService");

router.post("/register", async (req, res, next) => { try { res.status(201).json(await auth.register(req.body)); } catch (e) { next(e); } });
router.post("/login", async (req, res, next) => { try { res.json(await auth.login(req.body)); } catch (e) { next(e); } });
router.get("/me", auth.requireUser, (req, res) => res.json({ user: req.user }));

module.exports = router;
