/**
 * ProjectSpec: the single, language-neutral description of what to generate.
 * Every stack generator consumes this and nothing else, so adding a framework
 * never requires touching requirement analysis.
 *
 * Field types are deliberately small and portable across all supported stacks:
 *   string | text | int | float | bool | enum
 */
const FIELD_TYPES = ["string", "text", "int", "float", "bool", "enum"];

const DEFAULT_FIELDS = [
  { name: "title", type: "string", required: true },
  { name: "description", type: "text", required: false, default: "" },
  { name: "status", type: "enum", required: false, values: ["pending", "in-progress", "completed"], default: "pending" },
];

const IDENT_RE = /^[A-Za-z][A-Za-z0-9]*$/;

function plural(lower) {
  if (/(s|x|z|ch|sh)$/.test(lower)) return lower + "es";
  if (/[^aeiou]y$/.test(lower)) return lower.slice(0, -1) + "ies";
  return lower + "s";
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

function snake(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
}

function normalizeField(f) {
  if (!f || !IDENT_RE.test(f.name || "")) throw new Error(`invalid field name: ${f && f.name}`);
  if (!FIELD_TYPES.includes(f.type)) throw new Error(`invalid field type '${f.type}' for ${f.name}`);
  if (f.type === "enum" && !(Array.isArray(f.values) && f.values.length)) throw new Error(`enum field ${f.name} needs values`);
  return { required: false, ...f };
}

function normalizeEntity(e) {
  const name = typeof e === "string" ? e : e.name;
  if (!IDENT_RE.test(name)) throw new Error(`invalid entity name: ${name}`);
  const fields = (typeof e === "object" && e.fields ? e.fields : DEFAULT_FIELDS).map(normalizeField);
  const lower = name.toLowerCase();
  return { name, lower, plural: plural(lower), snake: snake(name), fields };
}

function normalizeFeatures(f = {}) {
  const events = f.events || null;
  if (events && !["kafka", "rabbitmq"].includes(events)) throw new Error(`invalid events feature '${events}' (kafka | rabbitmq)`);
  if (events === "kafka" && !require("./experimental").experimental()) {
    const e = new Error("events: kafka is experimental (its generated tests need a real Kafka broker, which Sierra could not run); use rabbitmq, or set SIERRA_EXPERIMENTAL=1 to opt in");
    e.statusCode = 400;
    throw e;
  }
  return { cache: !!f.cache, events, rateLimit: !!f.rateLimit, distributed: !!f.distributed, readWriteSplit: !!f.readWriteSplit };
}

/**
 * Build a ProjectSpec from the requirement analysis produced by
 * requirementAgent plus the user's stack/architecture choices.
 */
function buildSpec({ projectName, analysis, options = {} }) {
  const architecture = options.architecture || "monolith";
  if (!["monolith", "modular", "microservices"].includes(architecture)) throw Object.assign(new Error(`invalid architecture '${architecture}' (monolith | modular | microservices)`), { statusCode: 400 });
  const entities = (analysis.primaryEntities || []).map(normalizeEntity);
  return {
    name: String(projectName),
    slug: slug(projectName),
    needsAuth: !!analysis.needsAuth,
    entities,
    database: options.database || null, // null => first database the chosen stack supports
    architecture, // monolith | modular | microservices
    stack: options.stack || "node-express",
    features: normalizeFeatures(options.features),
    description: analysis.description || "",
  };
}

module.exports = { buildSpec, normalizeEntity, plural, slug, snake, FIELD_TYPES, DEFAULT_FIELDS };
