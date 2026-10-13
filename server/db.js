
"use strict";

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from environment variables.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 20000,
  allowExitOnIdle: true
});

pool.on("error", (err) => {
  console.error("[database] Pool error:", err.message);
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function checkConnection() {
  const result = await query(
    "SELECT current_database() AS database, NOW() AS connected_at"
  );
  return result.rows[0];
}

module.exports = { pool, query, checkConnection };
