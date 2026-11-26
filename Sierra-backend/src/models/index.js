const mongoose = require("mongoose");
const { Schema } = mongoose;

const ProjectSchema = new Schema(
  {
    projectId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    requirement: { type: String, required: true },
    techStack: {
      backend: { type: String, default: "Node.js + Express" },
      stack: { type: String, default: "node-express" },
      architecture: { type: String, default: "monolith" },
      features: { type: Object, default: {} },
      database: { type: String, default: null },
      testing: { type: String, default: "Jest + Supertest" },
    },
    architecture: { type: Schema.Types.Mixed, default: null },
    analysis: { type: Schema.Types.Mixed, default: null },
    generatedFiles: { type: [String], default: [] },
    workspacePath: { type: String, default: null },
    port: { type: Number, default: null },
    envVars: { type: [String], default: [] },
    apisCreated: { type: [String], default: [] },
    modelsCreated: { type: [String], default: [] },
    fixAttempts: { type: Schema.Types.Mixed, default: [] },
    filesChangedDuringDebug: { type: [String], default: [] },
    finalStatus: { type: String, enum: ["PENDING", "RUNNING", "VERIFIED", "FAILED", "NOT_VERIFIED"], default: "PENDING" },
    report: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

const ProjectFileSchema = new Schema(
  {
    projectId: { type: String, required: true, index: true },
    path: { type: String, required: true },
    // empty files (e.g. Python __init__.py) are legitimate; `required` would reject ""
    content: { type: String, default: "", required: function () { return this.content === undefined || this.content === null; } },
  },
  { timestamps: true }
);
ProjectFileSchema.index({ projectId: 1, path: 1 }, { unique: true });

const TestRunSchema = new Schema(
  {
    projectId: { type: String, required: true, index: true },
    phase: { type: String, required: true }, // initial | retest | regression
    attempt: { type: Number, default: 0 },
    results: { type: Schema.Types.Mixed, default: [] },
    passed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    rawOutput: { type: String, default: "" },
  },
  { timestamps: true }
);

const AgentRunSchema = new Schema(
  {
    projectId: { type: String, required: true, index: true },
    agent: { type: String, required: true },
    input: { type: Schema.Types.Mixed, default: null },
    output: { type: Schema.Types.Mixed, default: null },
    durationMs: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const UserSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true, index: true },
    salt: { type: String, required: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

const DiagramSchema = new Schema(
  {
    diagramId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    projectId: { type: String, default: null, index: true },
    name: { type: String, required: true },
    currentVersion: { type: Number, default: 1 },
  },
  { timestamps: true }
);

const DiagramVersionSchema = new Schema(
  {
    diagramId: { type: String, required: true, index: true },
    version: { type: Number, required: true },
    graph: { type: Schema.Types.Mixed, required: true },
    requirements: { type: Schema.Types.Mixed, default: null },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);
DiagramVersionSchema.index({ diagramId: 1, version: 1 }, { unique: true });

const mongooseModels = {
  User: mongoose.model("User", UserSchema),
  Diagram: mongoose.model("Diagram", DiagramSchema),
  DiagramVersion: mongoose.model("DiagramVersion", DiagramVersionSchema),
  Project: mongoose.model("Project", ProjectSchema),
  ProjectFile: mongoose.model("ProjectFile", ProjectFileSchema),
  TestRun: mongoose.model("TestRun", TestRunSchema),
  AgentRun: mongoose.model("AgentRun", AgentRunSchema),
};

const localStore = require("../localStorage");

// Dynamically delegate to real Mongoose models (production / whenever a real
// MongoDB is reachable) or to the sandbox-only in-memory store, decided at
// call time via a global flag set once in index.js after the real connection
// attempt has actually resolved or failed. See localStore.js for why this
// fallback exists — it is only ever used when a real Mongo connection could
// not be established.
function proxyFor(name) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const backend = global.__SIERRA_LOCAL_MODE__ ? localStore[name] : mongooseModels[name];
        return backend[prop] ? backend[prop].bind(backend) : backend[prop];
      },
    }
  );
}

module.exports = {
  Project: proxyFor("Project"),
  ProjectFile: proxyFor("ProjectFile"),
  TestRun: proxyFor("TestRun"),
  AgentRun: proxyFor("AgentRun"),
  User: proxyFor("User"),
  Diagram: proxyFor("Diagram"),
  DiagramVersion: proxyFor("DiagramVersion"),
};