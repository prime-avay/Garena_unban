"use strict";

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from environment variables.");
}

// Use your provider's POOLED connection string here (Neon: "-pooler" host,
// Supabase: transaction pooler / pgbouncer port).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,                          // serverless: keep tiny
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 8000,   // must be LOWER than the Vercel function timeout
  keepAlive: true,
  allowExitOnIdle: true
});

pool.on("error", (err) => {
  console.error("[database] Pool error:", err.message);
});

const TRANSIENT = /timeout|terminated|ECONNRESET|ECONNREFUSED|EPIPE/i;

// One retry for transient connection failures (cold/suspended DB waking up).
// Only used for idempotent statements (SELECT, CREATE IF NOT EXISTS).
async function query(text, params = []) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    if (TRANSIENT.test(err.message || "")) {
      console.error("[database] transient error, retrying once:", err.message);
      return pool.query(text, params);
    }
    throw err;
  }
}

async function checkConnection() {
  const result = await query(
    "SELECT current_database() AS database, NOW() AS connected_at"
  );
  return result.rows[0];
}

module.exports = { pool, query, checkConnection };