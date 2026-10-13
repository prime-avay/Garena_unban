"use strict";

const crypto = require("crypto");
const store = require("./store");

const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;

// Secure cookies on Vercel / production (HTTPS). Plain http://localhost still works.
const IS_SECURE = Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
const COOKIE_FLAGS = "HttpOnly; SameSite=Lax; Path=/" + (IS_SECURE ? "; Secure" : "");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const test = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(expectedHash, "hex");
    return test.length === expected.length && crypto.timingSafeEqual(test, expected);
  } catch {
    return false;
  }
}

// Adds the session to the in-memory store; the route calls store.save() to persist it.
function createSession(userId, remember) {
  const token = crypto.randomBytes(32).toString("hex");
  const ttlMs = remember ? REMEMBER_DAYS * 24 * 60 * 60 * 1000 : SESSION_HOURS * 60 * 60 * 1000;
  const expiresAt = Date.now() + ttlMs;
  store.get().sessions[token] = { userId, expiresAt };
  return { token, expiresAt, maxAgeMs: ttlMs };
}

// Logout: remove from memory AND the database.
async function destroySession(token) {
  if (!token) return;
  await store.deleteSession(token);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value; // malformed encoding must not crash the request
    }
  }
  return out;
}

function sessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie).pa_session;
  if (!token) return { token: null, user: null };
  const session = store.get().sessions[token];
  if (!session) return { token: null, user: null };
  if (session.expiresAt < Date.now()) {
    // Expired sessions are never loaded from the DB and are cleaned up by save(),
    // so memory-only removal is enough (no extra DB write per request).
    delete store.get().sessions[token];
    return { token: null, user: null };
  }
  const user = store.findUserById(session.userId);
  if (!user) return { token: null, user: null };
  return { token, user };
}

function cookieString(token, maxAgeMs) {
  const maxAgeSec = Math.floor(maxAgeMs / 1000);
  return `pa_session=${token}; ${COOKIE_FLAGS}; Max-Age=${maxAgeSec}`;
}

function clearCookieString() {
  return `pa_session=; ${COOKIE_FLAGS}; Max-Age=0`;
}

function attach(req, res, next) {
  const { token, user } = sessionFromRequest(req);
  req.sessionToken = token;
  req.user = user;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "AUTH_REQUIRED", message: "Please log in to continue." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: "AUTH_REQUIRED",
      message: "Please log in to access the admin panel."
    });
  }

  const ownerUsername = String(process.env.ADMIN_USERNAME || "").trim();

  if (
    !ownerUsername ||
    req.user.username !== ownerUsername ||
    req.user.role !== "admin"
  ) {
    return res.status(403).json({
      error: "FORBIDDEN",
      message: "Access denied. Owner credentials are required."
    });
  }

  next();
}

// In-memory cleanup only; expired rows are removed from the DB by store.save().
function pruneSessions() {
  const now = Date.now();
  const sessions = store.get().sessions;
  for (const token of Object.keys(sessions)) {
    if (sessions[token].expiresAt < now) delete sessions[token];
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  sessionFromRequest,
  cookieString,
  clearCookieString,
  attach,
  requireAuth,
  requireAdmin,
  pruneSessions
};