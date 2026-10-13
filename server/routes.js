"use strict";

const express = require("express");
const store = require("./store");
const auth = require("./auth");

const router = express.Router();

const KEY_PRICE = 300;
const PLANS = {
  Premium: { name: "Premium", price: 999, dailyLimit: 25, tagline: "Standard access" },
  Ultimate: { name: "Ultimate", price: 1999, dailyLimit: 50, tagline: "Advanced access" }
};
const PLAN_DURATION_DAYS = 30;
const BIND_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UID_RE = /^[0-9]{5,12}$/;

const genLocks = new Set();

/* ---------------- rate limiting ---------------- */

const buckets = new Map();
function rateLimit({ windowMs, max, keyPrefix }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = keyPrefix + ":" + (req.ip || req.socket.remoteAddress || "unknown");
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ error: "RATE_LIMITED", message: "Too many requests. Please slow down and try again." });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, 60 * 1000).unref();

/* ---------------- CSRF guard (cookie auth + custom header) ---------------- */

router.use("/api", (req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.headers["x-pa-request"] !== "1") {
      return res.status(403).json({ error: "BAD_REQUEST", message: "Missing request header." });
    }
  }
  next();
});

/* ---------------- helpers ---------------- */

function badRequest(res, message) {
  return res.status(400).json({ error: "BAD_REQUEST", message });
}

function maskKey(key) {
  return "PRIME-*****";
}

function userPlanActive(user) {
  if (!user.plan) return false;
  if (!user.planExpires) return true;
  return new Date(user.planExpires).getTime() > Date.now();
}

function dailyKeyCount(userId, planName) {
  const today = new Date().toDateString();
  return store.get().keys.filter(
    (k) => k.userId === userId && k.plan === planName && new Date(k.createdAt).toDateString() === today
  ).length;
}

function makeKey() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  for (let i = 0; i < 5; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return "PRIME-" + suffix;
}

function addTransaction(userId, { amount, type, ref, demo }) {
  const tx = {
    id: store.uid("tx"),
    userId,
    amount,
    type,
    ref: ref || "",
    demo: Boolean(demo),
    createdAt: new Date().toISOString()
  };
  store.get().transactions.unshift(tx);
  return tx;
}

function userStats(user) {
  const now = new Date();
  const today = now.toDateString();
  const txs = store.get().transactions.filter((t) => t.userId === user.id);
  const spendToday = txs
    .filter((t) => t.amount < 0 && new Date(t.createdAt).toDateString() === today)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const spendTotal = txs.filter((t) => t.amount < 0).reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const keys = store.get().keys.filter((k) => k.userId === user.id);
  const planActive = userPlanActive(user);
  const planCfg = user.plan ? PLANS[user.plan] : null;
  return {
    balance: user.balance,
    spendToday,
    spendTotal,
    plan: planActive ? user.plan : null,
    planExpires: planActive ? user.planExpires : null,
    dailyLimit: planActive && planCfg ? planCfg.dailyLimit : 0,
    keysToday: planActive ? dailyKeyCount(user.id, user.plan) : 0,
    totalKeys: keys.length,
    activeBindings: store.get().bindings.filter(
      (b) => b.userId === user.id && new Date(b.expiresAt).getTime() > Date.now()
    ).length,
    expiredBindings: store.get().bindings.filter(
      (b) => b.userId === user.id && new Date(b.expiresAt).getTime() <= Date.now()
    ).length
  };
}

function bindingView(b) {
  const expired = new Date(b.expiresAt).getTime() <= Date.now();
  return {
    id: b.id,
    key: maskKey(b.key),
    uid: b.uid,
    createdAt: b.createdAt,
    expiresAt: b.expiresAt,
    status: expired ? "EXPIRED" : "ACTIVE"
  };
}

function keyView(k) {
  return {
    id: k.id,
    key: maskKey(k.key),
    plan: k.plan,
    createdAt: k.createdAt,
    bound: Boolean(k.bound)
  };
}

function txView(t) {
  return {
    id: t.id,
    amount: t.amount,
    type: t.type,
    ref: t.ref,
    demo: t.demo,
    createdAt: t.createdAt
  };
}

/* ---------------- auth ---------------- */

router.post("/api/auth/login", rateLimit({ windowMs: 5 * 60 * 1000, max: 15, keyPrefix: "login" }), (req, res) => {
  const identifier = String(req.body?.identifier || "").trim();
  const password = String(req.body?.password || "");
  const remember = Boolean(req.body?.remember);

  const user = store.findUserByIdentifier(identifier);
  if (!user || !auth.verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Invalid username/email or password." });
  }

  const session = auth.createSession(user.id, remember);
  store.save();
  res.setHeader("Set-Cookie", auth.cookieString(session.token, session.maxAgeMs));
  res.json({ user: store.publicUser(user), stats: userStats(user) });
});

router.post("/api/auth/logout", (req, res) => {
  auth.destroySession(req.sessionToken);
  res.setHeader("Set-Cookie", auth.clearCookieString());
  res.json({ ok: true });
});

router.post("/api/auth/change-password", rateLimit({ windowMs: 5 * 60 * 1000, max: 10, keyPrefix: "pw" }), auth.requireAuth, (req, res) => {
  const current = String(req.body?.currentPassword || "");
  const nextPw = String(req.body?.newPassword || "");
  if (!auth.verifyPassword(current, req.user.salt, req.user.hash)) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Current password is incorrect." });
  }
  if (nextPw.length < 8 || !/[a-zA-Z]/.test(nextPw) || !/[0-9]/.test(nextPw)) {
    return badRequest(res, "New password must be at least 8 characters with a letter and a number.");
  }
  const { salt, hash } = auth.hashPassword(nextPw);
  req.user.salt = salt;
  req.user.hash = hash;
  store.save();
  res.json({ ok: true, message: "Password updated." });
});

router.get("/api/auth/me", auth.requireAuth, (req, res) => {
  res.json({ user: store.publicUser(req.user), stats: userStats(req.user) });
});

/* ---------------- profile ---------------- */

router.get("/api/me/profile", auth.requireAuth, (req, res) => {
  const stats = userStats(req.user);
  res.json({ user: store.publicUser(req.user), stats });
});

/* ---------------- plans ---------------- */

router.get("/api/plans", (req, res) => {
  res.json({
    plans: Object.values(PLANS).map((p) => ({ ...p, durationDays: PLAN_DURATION_DAYS })),
    keyPrice: KEY_PRICE
  });
});

router.post("/api/plans/purchase", rateLimit({ windowMs: 60 * 1000, max: 10, keyPrefix: "plan" }), auth.requireAuth, (req, res) => {
  const planName = String(req.body?.plan || "");
  const plan = PLANS[planName];
  if (!plan) return badRequest(res, "Unknown plan.");

  if (userPlanActive(req.user) && req.user.plan === planName) {
    return res.status(409).json({ error: "CONFLICT", message: `You already have the ${planName} plan.` });
  }
  if (Number(req.user.balance) < plan.price) {
    return res.status(402).json({
      error: "INSUFFICIENT_BALANCE",
      message: `Insufficient balance. The ${planName} plan costs ₹${plan.price}.`,
      required: plan.price,
      balance: req.user.balance
    });
  }

  req.user.balance -= plan.price;
  req.user.plan = planName;
  req.user.planExpires = new Date(Date.now() + PLAN_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  addTransaction(req.user.id, {
    amount: -plan.price,
    type: "Plan purchase",
    ref: planName.toUpperCase() + "_PLAN",
    demo: true
  });
  store.save();
  res.json({ user: store.publicUser(req.user), stats: userStats(req.user), message: `${planName} plan activated.` });
});

/* ---------------- keys ---------------- */

router.get("/api/keys", auth.requireAuth, (req, res) => {
  const keys = store.get().keys.filter((k) => k.userId === req.user.id);
  res.json({ keys: keys.map(keyView), keyPrice: KEY_PRICE });
});

router.get("/api/keys/:id/copy", rateLimit({ windowMs: 60 * 1000, max: 60, keyPrefix: "keycopy" }), auth.requireAuth, (req, res) => {
  const record = store.get().keys.find((k) => k.id === req.params.id && k.userId === req.user.id);
  if (!record) return res.status(404).json({ error: "NOT_FOUND", message: "Key not found." });
  res.json({ key: record.key });
});

router.post("/api/keys/generate", rateLimit({ windowMs: 60 * 1000, max: 30, keyPrefix: "gen" }), auth.requireAuth, (req, res) => {
  if (!userPlanActive(req.user) || !req.user.plan) {
    return res.status(403).json({ error: "NO_PLAN", message: "No active plan. Please buy a plan to generate keys." });
  }
  if (genLocks.has(req.user.id)) {
    return res.status(429).json({ error: "IN_PROGRESS", message: "A generation request is already in progress." });
  }

  genLocks.add(req.user.id);
  try {
    const plan = PLANS[req.user.plan];
    const used = dailyKeyCount(req.user.id, req.user.plan);
    if (used >= plan.dailyLimit) {
      return res.status(429).json({
        error: "DAILY_LIMIT",
        message: `${req.user.plan} daily limit reached. Maximum ${plan.dailyLimit} keys per day.`
      });
    }
    if (Number(req.user.balance) < KEY_PRICE) {
      return res.status(402).json({
        error: "INSUFFICIENT_BALANCE",
        message: "Insufficient balance. Each key costs ₹300.",
        required: KEY_PRICE,
        balance: req.user.balance
      });
    }

    let key = "";
    let attempts = 0;
    do {
      key = makeKey();
      attempts += 1;
    } while (attempts < 25 && store.get().keys.some((k) => k.key === key));

    req.user.balance -= KEY_PRICE;
    const record = {
      id: store.uid("key"),
      key,
      userId: req.user.id,
      plan: req.user.plan,
      createdAt: new Date().toISOString(),
      bound: false
    };
    store.get().keys.unshift(record);
    addTransaction(req.user.id, { amount: -KEY_PRICE, type: "Key generation", ref: key, demo: false });
    store.save();

    res.status(201).json({
      key,
      usage: { used: used + 1, limit: plan.dailyLimit },
      balance: req.user.balance,
      message: "Key generated. ₹300 deducted from your balance."
    });
  } finally {
    genLocks.delete(req.user.id);
  }
});

/* ---------------- bindings ---------------- */

router.get("/api/bindings", auth.requireAuth, (req, res) => {
  const bindings = store.get().bindings.filter((b) => b.userId === req.user.id);
  res.json({ bindings: bindings.map(bindingView) });
});

router.post("/api/bind", rateLimit({ windowMs: 60 * 1000, max: 20, keyPrefix: "bind" }), auth.requireAuth, (req, res) => {
  const keyValue = String(req.body?.key || "").trim().toUpperCase();
  const uid = String(req.body?.uid || "").trim();

  if (!/^PRIME-[A-Z0-9]{5}$/.test(keyValue)) {
    return badRequest(res, "Enter a valid key in the format PRIME-XXXXX.");
  }
  if (!UID_RE.test(uid)) {
    return badRequest(res, "UID must be 5-12 digits.");
  }

  const keyRecord = store.get().keys.find((k) => k.key === keyValue);
  if (!keyRecord) {
    return res.status(404).json({ error: "NOT_FOUND", message: "Key not found. Check the key and try again." });
  }
  if (keyRecord.userId !== req.user.id) {
    return res.status(403).json({ error: "FORBIDDEN", message: "This key does not belong to your account." });
  }
  if (keyRecord.bound) {
    return res.status(409).json({ error: "CONFLICT", message: "This key has already been bound." });
  }

  const now = Date.now();
  keyRecord.bound = true;
  const binding = {
    id: store.uid("bnd"),
    key: keyRecord.key,
    keyId: keyRecord.id,
    userId: req.user.id,
    uid,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + BIND_DURATION_MS).toISOString()
  };
  store.get().bindings.unshift(binding);
  store.save();
  res.status(201).json({ binding: bindingView(binding), message: "Key bound. Your 7-day countdown has started." });
});

/* ---------------- deposits & transactions ---------------- */

router.post("/api/deposit", rateLimit({ windowMs: 60 * 1000, max: 15, keyPrefix: "dep" }), auth.requireAuth, (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount < 10 || amount > 50000) {
    return badRequest(res, "Enter an amount between ₹10 and ₹50,000.");
  }
  req.user.balance += amount;
  addTransaction(req.user.id, {
    amount,
    type: "Deposit",
    ref: "PAY-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    demo: true
  });
  store.save();
  res.status(201).json({ balance: req.user.balance, message: `₹${amount.toFixed(2)} added to your balance.` });
});

router.get("/api/transactions", auth.requireAuth, (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 50));
  const txs = store.get().transactions.filter((t) => t.userId === req.user.id).slice(0, limit);
  res.json({ transactions: txs.map(txView) });
});

/* ---------------- admin ---------------- */

router.get("/api/admin/overview", auth.requireAdmin, (req, res) => {
  const now = new Date();
  const today = now.toDateString();
  const txs = store.get().transactions;
  const todayDeposits = txs
    .filter((t) => t.amount > 0 && t.demo && new Date(t.createdAt).toDateString() === today)
    .reduce((sum, t) => sum + t.amount, 0);
  const totalSpend = txs.filter((t) => t.amount < 0).reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const recentUsers = store
    .get()
    .users.slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 8)
    .map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      balance: u.balance,
      plan: userPlanActive(u) ? u.plan : null,
      createdAt: u.createdAt
    }));
  res.json({
    totals: {
      users: store.get().users.length,
      keys: store.get().keys.length,
      bindings: store.get().bindings.length,
      todayDeposits,
      totalSpend
    },
    recentUsers
  });
});

router.get("/api/admin/users", auth.requireAdmin, (req, res) => {
  res.json({
    users: store
      .get()
      .users.slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        balance: u.balance,
        plan: userPlanActive(u) ? u.plan : null,
        createdAt: u.createdAt
      }))
  });
});

router.get("/api/admin/keys", auth.requireAdmin, (req, res) => {
  res.json({
    keys: store.get().keys.slice(0, 200).map((k) => ({
      id: k.id,
      key: maskKey(k.key),
      userId: k.userId,
      username: (store.findUserById(k.userId) || {}).username || "unknown",
      plan: k.plan,
      createdAt: k.createdAt,
      bound: Boolean(k.bound)
    }))
  });
});

router.get("/api/admin/deposits", auth.requireAdmin, (req, res) => {
  res.json({
    deposits: store
      .get()
      .transactions.filter((t) => t.amount > 0 && t.demo)
      .slice(0, 200)
      .map((t) => ({
        id: t.id,
        userId: t.userId,
        username: (store.findUserById(t.userId) || {}).username || "unknown",
        amount: t.amount,
        ref: t.ref,
        createdAt: t.createdAt
      }))
  });
});

router.get("/api/admin/transactions", auth.requireAdmin, (req, res) => {
  res.json({ transactions: store.get().transactions.slice(0, 200).map((t) => ({
    id: t.id,
    userId: t.userId,
    username: (store.findUserById(t.userId) || {}).username || "unknown",
    amount: t.amount,
    type: t.type,
    ref: t.ref,
    demo: t.demo,
    createdAt: t.createdAt
  })) });
});

router.get("/api/admin/plans", auth.requireAdmin, (req, res) => {
  const counts = { Premium: 0, Ultimate: 0, None: 0 };
  for (const u of store.get().users) {
    if (userPlanActive(u) && u.plan && counts[u.plan] !== undefined) counts[u.plan] += 1;
    else counts.None += 1;
  }
  res.json({
    plans: Object.values(PLANS).map((p) => ({ ...p, durationDays: PLAN_DURATION_DAYS, activeUsers: counts[p.name] })),
    usersWithoutPlan: counts.None
  });
});

module.exports = { router, PLANS, KEY_PRICE, PLAN_DURATION_DAYS };