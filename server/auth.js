"use strict";

const crypto = require("crypto");
const store = require("./store");

const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;

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

function createSession(userId, remember) {
  const token = crypto.randomBytes(32).toString("hex");
  const ttlMs = remember ? REMEMBER_DAYS * 24 * 60 * 60 * 1000 : SESSION_HOURS * 60 * 60 * 1000;
  const expiresAt = Date.now() + ttlMs;
  store.get().sessions[token] = { userId, expiresAt };
  store.save();
  return { token, expiresAt, maxAgeMs: ttlMs };
}

function destroySession(token) {
  if (token && store.get().sessions[token]) {
    delete store.get().sessions[token];
    store.save();
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function sessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie).pa_session;
  if (!token) return { token: null, user: null };
  const session = store.get().sessions[token];
  if (!session) return { token: null, user: null };
  if (session.expiresAt < Date.now()) {
    delete store.get().sessions[token];
    store.save();
    return { token: null, user: null };
  }
  const user = store.findUserById(session.userId);
  if (!user) return { token: null, user: null };
  return { token, user };
}

function cookieString(token, maxAgeMs) {
  const maxAgeSec = Math.floor(maxAgeMs / 1000);
  return `pa_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

function clearCookieString() {
  return "pa_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
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



function pruneSessions() {
  const now = Date.now();
  const sessions = store.get().sessions;
  let changed = false;
  for (const token of Object.keys(sessions)) {
    if (sessions[token].expiresAt < now) {
      delete sessions[token];
      changed = true;
    }
  }
  if (changed) store.save();
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
