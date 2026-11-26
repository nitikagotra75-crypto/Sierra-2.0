// Opt-in switch for features whose generated output Sierra could not verify end to end in its own environment
// (Fiber/Spring/.NET stacks, Kafka). Off by default: a default install only offers what is known to work.
const experimental = () => process.env.SIERRA_EXPERIMENTAL === "1";
module.exports = { experimental };
