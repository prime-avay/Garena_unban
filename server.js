"use strict";

require("dotenv").config();

const path = require("path");
const express = require("express");
const store = require("./server/store");
const auth = require("./server/auth");
const { router: apiRouter } = require("./server/routes");

const app = express();

// Required credentials from environment variables
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const CLIENT_USERNAME = process.env.CLIENT_USERNAME;
const CLIENT_PASSWORD = process.env.CLIENT_PASSWORD;

// Set RESET_PASSWORDS=1 temporarily to re-apply ADMIN/CLIENT passwords from env.
const RESET_PASSWORDS = process.env.RESET_PASSWORDS === "1";

if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD must be configured");
}

if (!CLIENT_USERNAME || !CLIENT_PASSWORD) {
  throw new Error("CLIENT_USERNAME and CLIENT_PASSWORD must be configured");
}

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

// Create or update a configured account. Saves only when something changed.
async function configureAccount({ username, password, role, email, plan, balance }) {
  let user = store.findUserByName(username);

  if (user) {
    let changed = false;

    if (RESET_PASSWORDS) {
      const { salt, hash } = auth.hashPassword(password);
      user.salt = salt;
      user.hash = hash;
      changed = true;
    }

    if (user.role !== role) {
      user.role = role;
      changed = true;
    }

    if (role === "admin") {
      if (user.plan !== plan) {
        user.plan = plan;
        changed = true;
      }
      const stillValid =
        user.planExpires && new Date(user.planExpires).getTime() > Date.now();
      if (!stillValid) {
        user.planExpires = new Date(Date.now() + THIRTY_DAYS).toISOString();
        changed = true;
      }
    }

    if (changed) await store.save();
    return;
  }

  const { salt, hash } = auth.hashPassword(password);

  user = {
    id: store.uid("usr"),
    username,
    email,
    salt,
    hash,
    role,
    balance,
    plan: plan || "Free",
    planExpires:
      role === "admin" ? new Date(Date.now() + THIRTY_DAYS).toISOString() : null,
    createdAt: new Date().toISOString()
  };

  store.get().users.push(user);
  await store.save();
}

async function seed() {
  await configureAccount({
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
    role: "admin",
    email: "admin@primeavay.local",
    plan: "Ultimate",
    balance: 500
  });

  await configureAccount({
    username: CLIENT_USERNAME,
    password: CLIENT_PASSWORD,
    role: "client",
    email: "client@primeavay.local",
    plan: "Free",
    balance: 0
  });
}

app.disable("x-powered-by");
app.set("trust proxy", 1); // behind Vercel's proxy: req.ip = real client IP

// Retryable initialization: a failed attempt is cleared so the next request tries again.
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await store.load();
      await seed();
    })().catch((err) => {
      readyPromise = null;
      console.error("[startup] init failed:", err && err.message);
      throw err;
    });
  }
  return readyPromise;
}

// Static files first: they never need the database.
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache");
      }
    }
  })
);

// Everything below needs the database to be ready.
app.use(async (req, res, next) => {
  try {
    await ensureReady();
    next();
  } catch (error) {
    res.status(503).json({
      error: "SERVICE_UNAVAILABLE",
      message: "Database initialization failed."
    });
  }
});

app.use(express.json({ limit: "100kb" }));

// Vercel runs many instances, each with its own in-memory copy of the data.
// For every API request: take a per-instance lock (so requests don't swap
// store data underneath each other), then reload fresh data from Postgres.
let lockChain = Promise.resolve();
function acquireLock() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const prev = lockChain;
  lockChain = prev.then(() => gate);
  return prev.then(() => release);
}

app.use("/api", async (req, res, next) => {
  const release = await acquireLock();
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    release();
  };
  const timer = setTimeout(done, 15000); // safety: never block the queue forever
  res.on("finish", done);
  res.on("close", done);

  try {
    await store.load();
    next();
  } catch (error) {
    console.error("[api] load failed:", error && error.message);
    done();
    res.status(503).json({
      error: "SERVICE_UNAVAILABLE",
      message: "Database unavailable. Please try again."
    });
  }
});

app.use(auth.attach);

app.use(apiRouter);

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "NOT_FOUND",
    message: "Unknown API endpoint."
  });
});

// Central error handler
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({
      error: "BAD_REQUEST",
      message: "Invalid JSON body."
    });
  }

  console.error(err);

  res.status(500).json({
    error: "SERVER_ERROR",
    message: "Something went wrong. Please try again."
  });
});

if (require.main === module) {
  ensureReady()
    .then(() => {
      const port = process.env.PORT || 3000;
      setInterval(() => auth.pruneSessions(), 10 * 60 * 1000).unref();
      app.listen(port, () => console.log(`PRIME AVAY running at http://localhost:${port}`));
    })
    .catch(() => {
      process.exitCode = 1;
    });
}

module.exports = app;