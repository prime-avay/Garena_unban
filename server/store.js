"use strict";

const crypto = require("crypto");
const { pool, query } = require("./db");

const blank = () => ({ users: [], keys: [], bindings: [], transactions: [], sessions: {} });
let data = blank();
let saveQueue = Promise.resolve();

// What was last read from / written to the DB (id -> JSON string).
// save() only writes rows that differ, so one request can't overwrite
// rows it never touched with stale data.
let loaded = {
  users: new Map(),
  keys: new Map(),
  bindings: new Map(),
  transactions: new Map(),
  sessions: new Map()
};

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

const sessionSig = (s) => String(s.userId) + "|" + Number(s.expiresAt);

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
  loaded = {
    users: new Map(data.users.map(u => [String(u.id), JSON.stringify(u)])),
    keys: new Map(data.keys.map(k => [String(k.id), JSON.stringify(k)])),
    bindings: new Map(data.bindings.map(b => [String(b.id), JSON.stringify(b)])),
    transactions: new Map(data.transactions.map(t => [String(t.id), JSON.stringify(t)])),
    sessions: new Map(Object.entries(data.sessions).map(([tok, s]) => [tok, sessionSig(s)]))
  };
  return data;
}

// Persist only rows that changed since load(). Never deletes other instances' sessions.
function save() {
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const snap = data;
    const done = []; // applied to `loaded` only after COMMIT
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const u of snap.users) {
        const id = String(u.id), json = JSON.stringify(u);
        if (loaded.users.get(id) === json) continue;
        await client.query(`INSERT INTO public.prime_avay_users (id, username, email, payload)
          VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username,email=EXCLUDED.email,payload=EXCLUDED.payload`,
          [id, String(u.username || ""), String(u.email || ""), json]);
        done.push(() => loaded.users.set(id, json));
      }

      for (const k of snap.keys) {
        const id = String(k.id), json = JSON.stringify(k);
        if (loaded.keys.get(id) === json) continue;
        await client.query(`INSERT INTO public.prime_avay_keys (id,key_value,user_id,payload)
          VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE SET key_value=EXCLUDED.key_value,user_id=EXCLUDED.user_id,payload=EXCLUDED.payload`,
          [id, String(k.key), String(k.userId), json]);
        done.push(() => loaded.keys.set(id, json));
      }

      for (const b of snap.bindings) {
        const id = String(b.id), json = JSON.stringify(b);
        if (loaded.bindings.get(id) === json) continue;
        await client.query(`INSERT INTO public.prime_avay_bindings (id,key_id,user_id,payload)
          VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE SET key_id=EXCLUDED.key_id,user_id=EXCLUDED.user_id,payload=EXCLUDED.payload`,
          [id, b.keyId == null ? null : String(b.keyId), String(b.userId), json]);
        done.push(() => loaded.bindings.set(id, json));
      }

      for (const t of snap.transactions) {
        const id = String(t.id), json = JSON.stringify(t);
        if (loaded.transactions.get(id) === json) continue;
        await client.query(`INSERT INTO public.prime_avay_transactions (id,user_id,payload)
          VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id,payload=EXCLUDED.payload`,
          [id, String(t.userId), json]);
        done.push(() => loaded.transactions.set(id, json));
      }

      for (const [token, session] of Object.entries(snap.sessions)) {
        const sig = sessionSig(session);
        if (loaded.sessions.get(token) === sig) continue;
        await client.query(`INSERT INTO public.prime_avay_sessions (token,user_id,expires_at) VALUES ($1,$2,$3)
          ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id,expires_at=EXCLUDED.expires_at`,
          [token, String(session.userId), Number(session.expiresAt)]);
        done.push(() => loaded.sessions.set(token, sig));
      }

      // Only expired sessions are removed here (logout uses deleteSession).
      await client.query("DELETE FROM public.prime_avay_sessions WHERE expires_at < $1", [Date.now()]);

      await client.query("COMMIT");
      done.forEach((fn) => fn());
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  });
  return saveQueue;
}

// Remove one session (logout) from memory AND the database.
async function deleteSession(token) {
  if (!token) return;
  delete data.sessions[token];
  loaded.sessions.delete(token);
  await query("DELETE FROM public.prime_avay_sessions WHERE token = $1", [String(token)]);
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

module.exports = { load, save, deleteSession, get, uid, findUserById, findUserByName, findUserByEmail, findUserByIdentifier, publicUser, pool };