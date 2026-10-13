"use strict";

const crypto = require("crypto");
const { pool, query } = require("./db");

const blank = () => ({ users: [], keys: [], bindings: [], transactions: [], sessions: {} });
let data = blank();
let saveQueue = Promise.resolve();

function uid(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

let schemaPromise = null;

function ensureSchemaOnce() {
  if (!schemaPromise) {
    schemaPromise = ensureSchema().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS public.prime_avay_users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, email TEXT NOT NULL, payload JSONB NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS prime_avay_users_username_idx ON public.prime_avay_users (LOWER(username));
    CREATE TABLE IF NOT EXISTS public.prime_avay_keys (
      id TEXT PRIMARY KEY, key_value TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, payload JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prime_avay_keys_user_id_idx ON public.prime_avay_keys (user_id);
    CREATE TABLE IF NOT EXISTS public.prime_avay_bindings (
      id TEXT PRIMARY KEY, key_id TEXT, user_id TEXT NOT NULL, payload JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prime_avay_bindings_user_id_idx ON public.prime_avay_bindings (user_id);
    CREATE TABLE IF NOT EXISTS public.prime_avay_transactions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, payload JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prime_avay_transactions_user_id_idx ON public.prime_avay_transactions (user_id);
    CREATE TABLE IF NOT EXISTS public.prime_avay_sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prime_avay_sessions_expiry_idx ON public.prime_avay_sessions (expires_at);
  `);
}

async function load() {
  await ensureSchemaOnce();
  const [users, keys, bindings, transactions, sessions] = await Promise.all([
    query("SELECT payload FROM public.prime_avay_users ORDER BY id"),
    query("SELECT payload FROM public.prime_avay_keys ORDER BY id"),
    query("SELECT payload FROM public.prime_avay_bindings ORDER BY id"),
    query("SELECT payload FROM public.prime_avay_transactions ORDER BY id"),
    query("SELECT token, user_id, expires_at FROM public.prime_avay_sessions WHERE expires_at > $1", [Date.now()])
  ]);
  data = {
    users: users.rows.map(r => r.payload),
    keys: keys.rows.map(r => r.payload),
    bindings: bindings.rows.map(r => r.payload),
    transactions: transactions.rows.map(r => r.payload),
    sessions: Object.fromEntries(sessions.rows.map(r => [r.token, { userId: r.user_id, expiresAt: Number(r.expires_at) }]))
  };
  return data;
}

// Persist the in-memory request snapshot to PostgreSQL; never writes to Vercel's filesystem.
function save() {
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const u of data.users) {
        await client.query(`INSERT INTO public.prime_avay_users (id, username, email, payload)
          VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username,email=EXCLUDED.email,payload=EXCLUDED.payload`,
          [String(u.id), String(u.username || ""), String(u.email || ""), JSON.stringify(u)]);
      }
      for (const k of data.keys) {
        await client.query(`INSERT INTO public.prime_avay_keys (id,key_value,user_id,payload)
          VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE SET key_value=EXCLUDED.key_value,user_id=EXCLUDED.user_id,payload=EXCLUDED.payload`,
          [String(k.id), String(k.key), String(k.userId), JSON.stringify(k)]);
      }
      for (const b of data.bindings) {
        await client.query(`INSERT INTO public.prime_avay_bindings (id,key_id,user_id,payload)
          VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE SET key_id=EXCLUDED.key_id,user_id=EXCLUDED.user_id,payload=EXCLUDED.payload`,
          [String(b.id), b.keyId == null ? null : String(b.keyId), String(b.userId), JSON.stringify(b)]);
      }
      for (const t of data.transactions) {
        await client.query(`INSERT INTO public.prime_avay_transactions (id,user_id,payload)
          VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id,payload=EXCLUDED.payload`,
          [String(t.id), String(t.userId), JSON.stringify(t)]);
      }
      await client.query("DELETE FROM public.prime_avay_sessions");
      for (const [token, session] of Object.entries(data.sessions)) {
        await client.query(`INSERT INTO public.prime_avay_sessions (token,user_id,expires_at) VALUES ($1,$2,$3)
          ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id,expires_at=EXCLUDED.expires_at`,
          [token, String(session.userId), Number(session.expiresAt)]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
  return saveQueue;
}

function get() { return data; }
function findUserById(id) { return data.users.find(u => u.id === id) || null; }
function findUserByName(username) {
  const target = String(username || "").toLowerCase();
  return data.users.find(u => String(u.username || "").toLowerCase() === target) || null;
}
function findUserByEmail(email) {
  const target = String(email || "").toLowerCase();
  return data.users.find(u => String(u.email || "").toLowerCase() === target) || null;
}
function findUserByIdentifier(identifier) {
  const target = String(identifier || "").trim().toLowerCase();
  if (!target) return null;
  return data.users.find(u => String(u.username || "").toLowerCase() === target || String(u.email || "").toLowerCase() === target) || null;
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, email: u.email, role: u.role, balance: u.balance, plan: u.plan, planExpires: u.planExpires || null, createdAt: u.createdAt };
}

module.exports = { load, save, get, uid, findUserById, findUserByName, findUserByEmail, findUserByIdentifier, publicUser, pool };
