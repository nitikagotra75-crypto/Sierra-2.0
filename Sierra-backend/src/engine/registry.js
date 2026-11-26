/**
 * Stack registry. A stack is a plugin:
 *   { id, label, language, framework, status, databases, generate(spec) -> {path: content},
 *     validate: { setup:[cmd...], test:[cmd...], toolchain: "python3" } }
 *
 * `status` is "implemented" or "planned". Planned stacks are listed so the UI
 * can show the roadmap, but generate() refuses them — we never emit
 * pretend output for a stack that has no real generator yet.
 */
const stacks = new Map();

function register(stack) {
  if (!stack.id || !stack.language || !stack.framework) throw new Error("stack needs id/language/framework");
  if (stack.status === "implemented" && typeof stack.generate !== "function") {
    throw new Error(`stack ${stack.id} is marked implemented but has no generate()`);
  }
  stacks.set(stack.id, stack);
}

function get(id) {
  return stacks.get(id) || null;
}

function list() {
  return [...stacks.values()].map(({ id, label, language, framework, status, databases, notes, features }) => ({
    id, label, language, framework, status, databases: databases || [], features: features || [], notes: notes || "",
  }));
}

function generate(spec) {
  const stack = get(spec.stack);
  if (!stack) {
    const e = new Error(`unknown stack '${spec.stack}'`);
    e.statusCode = 400;
    throw e;
  }
  if (stack.status !== "implemented") {
    const e = new Error(`stack '${spec.stack}' is planned but not implemented yet`);
    e.statusCode = 501;
    throw e;
  }
  const wanted = Object.entries(spec.features || {}).filter(([, v]) => v).map(([k]) => k);
  const unsupported = wanted.filter((k) => !(stack.features || []).includes(k));
  if (unsupported.length) {
    const e = new Error(`stack '${spec.stack}' does not support feature(s): ${unsupported.join(", ")} (supported: ${(stack.features || []).join(", ") || "none"})`);
    e.statusCode = 400;
    throw e;
  }
  if (spec.architecture === "microservices") return require("./architecture").generateMicroservices(spec, stack, (sub) => generate(sub));
  if (!spec.database && stack.databases && stack.databases.length) spec = { ...spec, database: stack.databases[0] };
  if (stack.databases && stack.databases.length && !stack.databases.includes(spec.database)) {
    const e = new Error(`stack '${spec.stack}' does not support database '${spec.database}' (supported: ${stack.databases.join(", ")})`);
    e.statusCode = 400;
    throw e;
  }
  const out = stack.generate(spec);
  return spec.architecture === "modular" ? require("./architecture").applyModular(spec, stack, out) : out;
}

module.exports = { register, get, list, generate };
