"use strict";

require("dotenv").config();

const path = require("path");
const express = require("express");
const store = require("./server/store");
const auth = require("./server/auth");
const { router: apiRouter } = require("./server/routes");

const app = express();
const PORT = process.env.PORT || 3000;

// Required credentials from .env
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const CLIENT_USERNAME = process.env.CLIENT_USERNAME;
const CLIENT_PASSWORD = process.env.CLIENT_PASSWORD;

if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD must be configured in .env");
}

if (!CLIENT_USERNAME || !CLIENT_PASSWORD) {
  throw new Error("CLIENT_USERNAME and CLIENT_PASSWORD must be configured in .env");
}

// Create or update a configured account.
async function configureAccount({ username, password, role, email, plan, balance }) {
  let user = store.findUserByName(username);

  const { salt, hash } = auth.hashPassword(password);

  if (user) {
    // Keep existing account data, but apply the configured password.
    user.salt = salt;
    user.hash = hash;
    user.role = role;

    if (role === "admin") {
      user.plan = plan;
      user.planExpires =
        user.planExpires && new Date(user.planExpires).getTime() > Date.now()
          ? user.planExpires
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    }

    await store.save();
    console.log(`[config] ${role} account configured: ${username}`);
    return;
  }

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
      role === "admin"
        ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        : null,
    createdAt: new Date().toISOString()
  };

  store.get().users.push(user);
  await store.save();

  console.log(`[config] ${role} account created: ${username}`);
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

let initializationError = null;
const ready = (async () => {
  await store.load();
  await seed();
  await store.save();
})().catch((error) => {
  initializationError = error;
  console.error("[startup] Failed to initialize PRIME AVAY:", error);
  throw error;
});

// Wait for database initialization before serving any request.
app.use(async (req, res, next) => {
  try {
    await ready;
    next();
  } catch (error) {
    res.status(503).json({ error: "SERVICE_UNAVAILABLE", message: "Database initialization failed." });
  }
});

app.use(express.json({ limit: "100kb" }));
app.use(auth.attach);

// Static files
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache");
      }
    }
  })
);

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
  ready.then(() => {
    const port = process.env.PORT || 3000;
    setInterval(() => auth.pruneSessions(), 10 * 60 * 1000).unref();
    app.listen(port, () => console.log(`PRIME AVAY running at http://localhost:${port}`));
  }).catch(() => {
    process.exitCode = 1;
  });
}

module.exports = app;
