const express = require("express");
const cors = require("cors");
const projectRoutes = require("./routes/projectRoutes");
const runRoutes = require("./routes/runRoutes");
const designRoutes = require("./routes/designRoutes");
const systemRoutes = require("./routes/systemRoutes");
const authRoutes = require("./routes/authRoutes");
const diagramRoutes = require("./routes/diagramRoutes");
const { errorHandler } = require("./middleware/errorHandler");

function createApp() {
  const app = express();
  app.use(cors({ exposedHeaders: ["Content-Disposition", "Retry-After"] }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.use("/api/projects", projectRoutes);
  app.use("/api/runs", runRoutes);
  app.use("/api/design", designRoutes);
  app.use("/api/system", systemRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/diagrams", diagramRoutes);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
