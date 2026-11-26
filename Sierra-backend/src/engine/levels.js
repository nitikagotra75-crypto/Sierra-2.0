/**
 * Verification levels reported for a generated project. They are cumulative claims about what was actually done:
 *
 *   IMPLEMENTED           code/config was generated
 *   STATICALLY_VALIDATED  generated-file checks and infra linters (hadolint, yamllint, compose config, ...) found no failures
 *   INTEGRATION_TESTED    the project's own test suite was executed here and passed (HTTP layer against its real database
 *                         layer; external brokers/Redis only count when `integrations` lists them as tested)
 *   END_TO_END_VERIFIED   the built artifact was started (container or process) and smoke-tested over the network.
 *                         Sierra's pipeline does not do this yet, so it is only set when a smoke result is supplied.
 *   BLOCKED               a required toolchain/network was unavailable, so the next level could not be attempted. This is
 *                         reported next to the level reached (`blocked`), never instead of a failure.
 *
 * A failure at any step is reported as `failed` and caps the level below the failed step.
 */
const ORDER = ["IMPLEMENTED", "STATICALLY_VALIDATED", "INTEGRATION_TESTED", "END_TO_END_VERIFIED"];

function computeLevels({ validation, staticChecks = [], infra = null, smoke = null }) {
  const staticFailed = staticChecks.some((c) => c.level === "fail");
  const infraFailed = !!infra && infra.status === "failed";
  const failed = [];
  if (staticFailed) failed.push("static-checks");
  if (infraFailed) failed.push("infra-validation");
  if (validation && validation.status === "failed") failed.push("test-suite");

  let level = "IMPLEMENTED";
  if (!staticFailed && !infraFailed) level = "STATICALLY_VALIDATED";
  if (level === "STATICALLY_VALIDATED" && validation && validation.status === "passed") level = "INTEGRATION_TESTED";
  if (level === "INTEGRATION_TESTED" && smoke && smoke.status === "passed") level = "END_TO_END_VERIFIED";

  const blocked = [];
  if (validation && validation.status === "skipped") blocked.push({ step: "test-suite", reason: validation.reason });
  if (infra) for (const r of infra.results) if (r.status === "skipped") blocked.push({ step: r.check, reason: `${r.tool}: ${r.detail}` });
  if (!smoke) blocked.push({ step: "end-to-end", reason: "Sierra does not start the generated app in a container and smoke-test it; use the generated CI workflow or run it locally." });

  return { level, reached: ORDER.slice(0, ORDER.indexOf(level) + 1), failed, blocked };
}

module.exports = { computeLevels, ORDER };
