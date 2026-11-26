/**
 * LLM-driven entity/schema design for the multi-stack engine.
 *
 *   requirement --(LLM)--> entities with typed fields --(strict validation)--> ProjectSpec entities
 *
 * The model proposes entity names, fields, types, required/optional, defaults, enums and references. Nothing the model says is
 * trusted: every identifier, type and default is validated before it reaches a generator, and problems are REPORTED
 * (issues[]) instead of being silently patched. When there is no LLM, or its answer is unusable, the caller gets
 * source:"default" (the generic entity) - never an invented schema.
 *
 * Supported by every generator today: string | text | int | float | bool | enum, required, defaults.
 * References between entities are modelled as an integer id field (e.g. customerId) with `references` metadata that is
 * validated to point at an existing entity; the generated databases do NOT get a FOREIGN KEY constraint, and nested
 * objects, composite indexes and arbitrary DB constraints are not generated. Those are reported in `unsupported`.
 */
const { FIELD_TYPES } = require("./spec");

const MAX_ENTITIES = 12, MAX_FIELDS = 20, MAX_ENUM_VALUES = 12;
const ENTITY_RE = /^[A-Z][A-Za-z0-9]{0,39}$/;
const FIELD_RE = /^[a-z][A-Za-z0-9]{0,39}$/;
// names that would collide with generated columns or are reserved words in at least one supported language
const RESERVED_FIELDS = new Set(["id", "ownerid", "owner_id", "createdat", "updatedat", "created_at", "updated_at", "class", "def", "import", "return", "from", "global", "new", "default", "package", "namespace", "interface", "enum", "type", "var", "func", "async", "await", "lambda", "yield", "public", "private", "static", "final", "void", "null", "true", "false", "none", "in", "is", "not", "and", "or", "if", "else", "for", "while", "try", "catch", "throw", "switch", "case", "break", "continue", "object", "string", "int", "float", "bool"]);
const RESERVED_ENTITIES = new Set(["User", "Base", "Session", "Object", "String", "Error", "Array", "Date", "Map", "Set", "Promise", "Request", "Response"]);

function validateSchema(raw) {
  const issues = [], unsupported = [];
  const list = Array.isArray(raw && raw.entities) ? raw.entities : null;
  if (!list || list.length === 0) return { entities: [], issues: ["the model returned no entities"], unsupported };
  const names = new Set(list.map((e) => e && e.name));
  const entities = [];
  const seenEntity = new Set();
  for (const e of list.slice(0, MAX_ENTITIES)) {
    if (!e || !ENTITY_RE.test(e.name || "")) { issues.push(`entity name ${JSON.stringify(e && e.name)} is not PascalCase alphanumeric`); continue; }
    if (RESERVED_ENTITIES.has(e.name)) { issues.push(`entity name ${e.name} is reserved`); continue; }
    if (seenEntity.has(e.name.toLowerCase())) { issues.push(`duplicate entity ${e.name}`); continue; }
    seenEntity.add(e.name.toLowerCase());
    const fields = [];
    const seenField = new Set();
    for (const f of (Array.isArray(e.fields) ? e.fields : []).slice(0, MAX_FIELDS)) {
      const where = `${e.name}.${f && f.name}`;
      if (!f || !FIELD_RE.test(f.name || "")) { issues.push(`${where}: field name must be camelCase alphanumeric`); continue; }
      if (RESERVED_FIELDS.has(f.name.toLowerCase())) { issues.push(`${where}: name is reserved or generated automatically`); continue; }
      if (seenField.has(f.name.toLowerCase())) { issues.push(`${where}: duplicate field`); continue; }
      let type = f.type;
      if (["nested", "object", "array", "json", "list"].includes(type)) { unsupported.push(`${where}: ${type} fields are not generated (use a separate entity with a reference)`); continue; }
      if (type === "integer") type = "int";
      if (["number", "decimal", "double"].includes(type)) type = "float";
      if (["boolean"].includes(type)) type = "bool";
      if (["datetime", "date", "timestamp"].includes(type)) { unsupported.push(`${where}: ${type} is not a supported field type; stored as string`); type = "string"; }
      if (!FIELD_TYPES.includes(type)) { issues.push(`${where}: unsupported type ${JSON.stringify(f.type)}`); continue; }
      const out = { name: f.name, type, required: f.required === true };
      if (type === "enum") {
        const values = Array.isArray(f.values) ? f.values.filter((v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/.test(v)) : [];
        if (values.length === 0 || values.length > MAX_ENUM_VALUES || new Set(values).size !== values.length) { issues.push(`${where}: enum needs 1-${MAX_ENUM_VALUES} distinct simple string values`); continue; }
        out.values = values;
      }
      if (f.default !== undefined && f.default !== null) {
        const d = f.default;
        const ok = (type === "string" || type === "text") ? typeof d === "string" && d.length <= 200
          : type === "int" ? Number.isInteger(d)
          : type === "float" ? typeof d === "number" && Number.isFinite(d)
          : type === "bool" ? typeof d === "boolean"
          : out.values.includes(d);
        if (!ok) { issues.push(`${where}: default ${JSON.stringify(d)} does not match type ${type}`); continue; }
        out.default = d;
        out.required = false; // a defaulted field is optional on input
      }
      if (f.references) {
        const target = String(f.references);
        if (!names.has(target) || target === e.name) { issues.push(`${where}: references unknown entity ${JSON.stringify(target)}`); continue; }
        if (type !== "int") { issues.push(`${where}: a reference must be an int id field`); continue; }
        out.references = target;
        unsupported.push(`${where}: stored as an integer id; no FOREIGN KEY constraint is generated`);
      }
      seenField.add(f.name.toLowerCase());
      fields.push(out);
    }
    if (fields.length === 0) { issues.push(`${e.name}: no valid fields`); continue; }
    if (!fields.some((f) => f.required)) fields[0].required = true; // every entity needs at least one required field to be creatable meaningfully
    entities.push({ name: e.name, fields });
  }
  // references to entities that were dropped by validation are invalid
  const kept = new Set(entities.map((e) => e.name));
  for (const e of entities) e.fields = e.fields.filter((f) => !f.references || (kept.has(f.references) || (issues.push(`${e.name}.${f.name}: reference target ${f.references} was dropped`), false)));
  return { entities: entities.filter((e) => e.fields.length), issues, unsupported };
}

const SYSTEM = `You design the data model of a backend service. Reply with ONLY JSON:
{"entities":[{"name":"PascalCase","fields":[{"name":"camelCase","type":"string|text|int|float|bool|enum","required":true|false,"default":<optional>,"values":["only","for","enum"],"references":"OtherEntity (only on int id fields like customerId)"}]}]}
Rules: do not include id, createdAt, updatedAt, ownerId or a User entity (generated automatically). Use only the listed types. Model a relation as an int field named <entity>Id with "references". Model money as float. Keep to the entities the requirement actually needs.`;

/** Entities/fields written in the requirement text itself, no LLM involved (see requirementSchema.js). */
function fromRequirementText(requirement, priorIssues = []) {
  const parsed = require("./requirementSchema").schemaFromRequirement(requirement);
  if (!parsed.entities.length) return null;
  const v = validateSchema(parsed);
  if (!v.entities.length) return null;
  return { source: "requirement", entities: v.entities, issues: [...priorIssues, ...parsed.issues, ...v.issues], unsupported: v.unsupported };
}

async function designSchema(requirement, { ask } = {}) {
  const llm = ask || (require("../agents/llm").hasLLM ? require("../agents/llm").askForJSON : null);
  if (!llm) {
    const r = fromRequirementText(requirement);
    if (r) return r;
    return { source: "default", entities: null, issues: ["no entities/fields found in the requirement and no LLM configured (set GEMINI_API_KEY or GROQ_API_KEY): the generic entity is used"], unsupported: [] };
  }
  let raw;
  try {
    raw = await llm({ system: SYSTEM, prompt: requirement, maxTokens: 4096 });
  } catch (e) {
    return fromRequirementText(requirement, [`LLM schema design failed (${e.message}); fields were read from the requirement text instead`])
      || { source: "default", entities: null, issues: [`LLM schema design failed: ${e.message}`], unsupported: [] };
  }
  const v = validateSchema(raw);
  if (v.entities.length === 0) return fromRequirementText(requirement, v.issues) || { source: "default", entities: null, issues: v.issues, unsupported: v.unsupported };
  return { source: "llm", entities: v.entities, issues: v.issues, unsupported: v.unsupported };
}

module.exports = { designSchema, validateSchema };
