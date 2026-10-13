"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");

const blank = () => ({
  users: [],
  keys: [],
  bindings: [],
  transactions: [],
  sessions: {}
});

let data = blank();

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    data = { ...blank(), ...parsed };
  } catch {
    data = blank();
  }
  return data;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function uid(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

function get() {
  return data;
}

function findUserById(id) {
  return data.users.find((u) => u.id === id) || null;
}

function findUserByName(username) {
  const target = String(username || "").toLowerCase();
  return data.users.find((u) => u.username.toLowerCase() === target) || null;
}

function findUserByEmail(email) {
  const target = String(email || "").toLowerCase();
  return data.users.find((u) => u.email.toLowerCase() === target) || null;
}

function findUserByIdentifier(identifier) {
  const target = String(identifier || "").trim().toLowerCase();
  if (!target) return null;
  return (
    data.users.find(
      (u) => u.username.toLowerCase() === target || u.email.toLowerCase() === target
    ) || null
  );
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    balance: u.balance,
    plan: u.plan,
    planExpires: u.planExpires || null,
    createdAt: u.createdAt
  };
}

module.exports = {
  load,
  save,
  get,
  uid,
  findUserById,
  findUserByName,
  findUserByEmail,
  findUserByIdentifier,
  publicUser,
  DATA_FILE
};
