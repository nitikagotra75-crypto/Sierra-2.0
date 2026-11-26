const registry = require("./registry");
const { buildSpec } = require("./spec");
const { withRateLimit } = require("./rateLimit");
const { withDistributed } = require("./distributed");
const { withReadWriteSplit } = require("./scaling");
const { withCi } = require("./ci");
const { withFormat } = require("./format");
const { withGoEvents } = require("./goEvents");
const { withGoSplit } = require("./goSplit");

registry.register(withCi(withDistributed(withRateLimit(require("./stacks/nodeExpress")))));
registry.register(withCi(withReadWriteSplit(withDistributed(withRateLimit(require("./stacks/pythonFastapi"))))));
registry.register(withCi(withDistributed(withRateLimit(require("./stacks/nodeFastify")))));
registry.register(withCi(withDistributed(withRateLimit(require("./stacks/nodeNest")))));
registry.register(withCi(withDistributed(withRateLimit(require("./stacks/pythonDjango")))));
registry.register(withCi(withDistributed(withRateLimit(require("./stacks/pythonFlask")))));
registry.register(withCi(withFormat(withGoSplit(withGoEvents(withDistributed(withRateLimit(require("./stacks/goNetHttp"))))))));
// Stacks whose generated code Sierra could verify (compile + run its own tests) are always available. The rest are
// opt-in with SIERRA_EXPERIMENTAL=1 so a default install only offers what is known to work:
//   go-gin    compiled and tested here against a real Gin (CI covers the pinned release)
//   go-fiber, spring-boot, aspnet-core: generated and statically checked, never built in Sierra's sandbox
const { experimental } = require("./experimental");
for (const s of require("./stacks/goFrameworks")) if (s.id === "go-gin" || experimental()) registry.register(withCi(withFormat(withDistributed(s))));
if (experimental()) {
  registry.register(withCi(require("./stacks/javaSpring")));
  registry.register(withCi(require("./stacks/dotnetAspnet")));
  for (const s of require("./stacks/planned")) registry.register(s);
}

module.exports = { registry, buildSpec };
