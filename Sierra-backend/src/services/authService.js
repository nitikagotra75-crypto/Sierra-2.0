/**
 * Minimal account system so per-user data (architecture diagrams) can follow a user across devices.
 *  - passwords: scrypt with a per-user random salt, timing-safe compare
 *  - sessions: stateless HMAC-SHA256 signed tokens (payload {sub, exp}), 7 day lifetime
 *  - the signing secret MUST come from SIERRA_AUTH_SECRET; without it auth is disabled (503), there is no built-in default
 * Limits: no email verification, no password reset, no refresh/revocation (a token is valid until it expires),
 * no rate limiting on login. Do not expose it to the public internet without adding those.
 */
const crypto = require("crypto");
const { v4: uuid } = require("uuid");
const { User } = require("../models");

const TTL_SECONDS = 7 * 24 * 3600;
const err = (status, msg) => Object.assign(new Error(msg), { statusCode: status });

function secret() {
  const s = process.env.SIERRA_AUTH_SECRET;
  if (!s || s.length < 16) throw err(503, "Authentication is not configured: set SIERRA_AUTH_SECRET (at least 16 characters) on the server");
  return s;
}

const b64 = (b) => Buffer.from(b).toString("base64url");
const sign = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

function issueToken(userId, now = Date.now()) {
  const payload = b64(JSON.stringify({ sub: userId, exp: Math.floor(now / 1000) + TTL_SECONDS }));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token, now = Date.now()) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, mac] = token.split(".");
  const expected = sign(payload);
  const a = Buffer.from(mac || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return exp > Math.floor(now / 1000) ? sub : null;
  } catch { return null; }
}

const hash = (password, salt) => new Promise((res, rej) => crypto.scrypt(password, salt, 64, (e, k) => (e ? rej(e) : res(k.toString("hex")))));

function validateCredentials({ email, password }) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw err(422, "A valid email is required");
  if (typeof password !== "string" || password.length < 8 || password.length > 128) throw err(422, "Password must be 8-128 characters");
  return { email: email.trim().toLowerCase(), password };
}

async function register(body) {
  const { email, password } = validateCredentials(body || {});
  secret();
  if (await User.findOne({ email })) throw err(409, "Email already registered");
  const salt = crypto.randomBytes(16).toString("hex");
  const user = await User.create({ userId: uuid(), email, salt, passwordHash: await hash(password, salt) });
  return { user: { userId: user.userId, email }, token: issueToken(user.userId) };
}

async function login(body) {
  const { email, password } = validateCredentials(body || {});
  secret();
  const user = await User.findOne({ email });
  const ok = user && crypto.timingSafeEqual(Buffer.from(await hash(password, user.salt), "hex"), Buffer.from(user.passwordHash, "hex"));
  if (!ok) throw err(401, "Invalid email or password");
  return { user: { userId: user.userId, email }, token: issueToken(user.userId) };
}

async function requireUser(req, res, next) {
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    const userId = m && verifyToken(m[1]);
    if (!userId) throw err(401, "Sign in required");
    const user = await User.findOne({ userId });
    if (!user) throw err(401, "Sign in required");
    req.user = { userId, email: user.email };
    next();
  } catch (e) { next(e); }
}

module.exports = { register, login, requireUser, issueToken, verifyToken };
