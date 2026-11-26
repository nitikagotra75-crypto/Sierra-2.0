// Roadmap entries. They are visible to the UI but generate() refuses them (HTTP 501): no pretend output.
// Every stack on the original roadmap now has a generator; add new `[id, label, language, framework]` rows here
// to announce a stack before it is implemented.
const planned = [];
module.exports = planned.map(([id, label, language, framework]) => ({
  id, label, language, framework, status: "planned", databases: [], notes: "Not implemented yet.",
}));
