"use strict";

/* ============================================================
   PRIME AVAY — frontend application
   ============================================================ */

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  me: null,        // { user, stats } from /api/auth/me
  keys: [],
  bindings: [],
  transactions: [],
  plans: [],
  keyPrice: 300,
  latestKey: "",
  depositTimer: null,
  depositSeconds: 0
};

/* ---------------- API client ---------------- */

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "X-PA-Request": "1",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(data.message || `Request failed (${res.status}).`);
    err.status = res.status;
    err.code = data.error || "ERROR";
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------------- utilities ---------------- */

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

const inr = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtDate(iso) {
  if (!iso) return "N/A";
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDateShort(iso) {
  if (!iso) return "N/A";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

let toastTimer = null;
function toast(message, ok = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("ok", ok);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }

function setBtnLoading(btn, loading, label) {
  if (!btn) return;
  if (loading) {
    btn.dataset.label = btn.innerHTML;
    btn.innerHTML = "Please wait…";
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.label || label || btn.innerHTML;
    btn.disabled = false;
  }
}

function initials(name) {
  return String(name || "P").trim().slice(0, 1).toUpperCase() || "P";
}

function planLabel() {
  const plan = state.me?.user?.plan;
  const exp = state.me?.user?.planExpires;
  const active = plan && (!exp || new Date(exp).getTime() > Date.now());
  return active ? `${plan} Plan` : "Free Plan";
}

/* ---------------- countdown (1s tick) ---------------- */

function countdownText(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "EXPIRED";
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${d} days ${h} hours ${m} minutes ${s} seconds`;
}

setInterval(() => {
  $$("[data-countdown]").forEach((el) => {
    const text = countdownText(el.dataset.countdown);
    el.textContent = text;
    el.classList.toggle("expired", text === "EXPIRED");
  });
}, 1000);

/* ---------------- router ---------------- */

const PUBLIC_ROUTES = new Set(["/", "/login", "/privacy", "/terms"]);

const APP_PAGES = {
  "/app": "dashboard",
  "/app/keys": "keys",
  "/app/bind": "bind",
  "/app/balance": "balance",
  "/app/profile": "profile",
  "/app/settings": "settings",
  "/app/plans": "plans"
};

const ADMIN_PAGES = {
  "/admin": "overview",
  "/admin/users": "users",
  "/admin/keys": "keys",
  "/admin/deposits": "deposits",
  "/admin/transactions": "transactions",
  "/admin/plans": "plans"
};

const APP_TITLES = {
  dashboard: "Dashboard", keys: "Key Generator", bind: "Bind Key",
  balance: "Balance", profile: "Profile", settings: "Settings", plans: "Plans"
};
const ADMIN_TITLES = {
  overview: "Admin Dashboard", users: "Users", keys: "Keys",
  deposits: "Deposits", transactions: "Transactions", plans: "Plans"
};

function currentRoute() {
  const hash = location.hash.slice(1);
  if (!hash || hash === "/") return "/";
  return hash.startsWith("/") ? hash.split("?")[0] : null; // null = in-page anchor like #how
}

function showView(id) {
  $$(".view").forEach((v) => v.classList.remove("active"));
  $(id).classList.add("active");
}

async function navigate() {
  const raw = location.hash.slice(1) || "/";
  const anchor = raw && !raw.startsWith("/") ? raw : null;
  const route = raw.startsWith("/") ? raw.split("?")[0] : "/";

  document.body.classList.remove("nav-open", "side-open");

  if (APP_PAGES[route] !== undefined) {
    if (!state.me) { location.hash = "#/login"; return; }
    document.body.classList.remove("mode-public");
    document.body.classList.add("mode-app");
    showView("view-app");
    await showAppPage(APP_PAGES[route]);
  
} else if (ADMIN_PAGES[route] !== undefined) {
  if (!state.me) {
    sessionStorage.setItem("pa_after_login", route);
    location.hash = "#/login";
    return;
  }

  if (state.me.user.role !== "admin") {
    toast("Access denied. Admin credentials required.");
    location.hash = "#/app";
    return;
  }

  showView("view-admin");
  await showAdminPage(ADMIN_PAGES[route]);
} else {
    document.body.classList.remove("mode-app");
    document.body.classList.add("mode-public");
    if (route === "/login" || route === "/privacy" || route === "/terms") {
      showView("view-" + route.slice(1));
    } else {
      showView("view-landing");
    }
    updateHeader();
    if (anchor) {
      requestAnimationFrame(() => {
        const target = $(anchor);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return;
    }
  }
  if (!anchor) window.scrollTo({ top: 0 });
}

window.addEventListener("hashchange", navigate);

/* ---------------- header / shell ---------------- */

function updateHeader() {
  const btn = $("headerAuth");
  if (state.me) {
    btn.textContent = state.me.user.role === "admin" ? "Admin Panel" : "Open Portal";
  } else {
    btn.textContent = "Login";
  }
}

function refreshShell() {
  if (!state.me) return;
  const { user } = state.me;
  const label = planLabel();
  $("sideAvatar").textContent = initials(user.username);
  $("sideUsername").textContent = user.username;
  $("sidePlan").textContent = label;
  $("appAvatar").textContent = initials(user.username);
  $("appUserName").textContent = user.username;
  $("appUserPlan").textContent = label;
  $("welcomeName").textContent = user.username;
  $("settingsUser").textContent = user.username;
  $("adminAvatar").textContent = initials(user.username);
  $("adminUserName").textContent = user.username;
  $("adminSideAvatar").textContent = initials(user.username);
  $("adminSideUsername").textContent = user.username;
}

/* ---------------- data loading ---------------- */

async function loadMe() {
  try {
    state.me = await api("/api/auth/me");
  } catch {
    state.me = null;
  }
  updateHeader();
  return state.me;
}

async function refreshStats() {
  if (!state.me) return;
  const data = await api("/api/auth/me");
  state.me = data;
  refreshShell();
}

async function loadKeys() {
  const data = await api("/api/keys");
  state.keys = data.keys;
  state.keyPrice = data.keyPrice;
}

async function loadBindings() {
  const data = await api("/api/bindings");
  state.bindings = data.bindings;
}

async function loadTransactions() {
  const data = await api("/api/transactions?limit=50");
  state.transactions = data.transactions;
}

async function loadPlans() {
  const data = await api("/api/plans");
  state.plans = data.plans;
  state.keyPrice = data.keyPrice;
}

/* ---------------- icons ---------------- */

const ICONS = {
  key: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="8" cy="15" r="4" stroke="currentColor" stroke-width="1.8"/><path d="m11 12 9-9m-3.5 3.5 2 2M15 7l2 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 12h6m-6 0a3 3 0 1 0-3-3m3 3a3 3 0 1 1-3 3m12-3h-6m6 0a3 3 0 1 0 3-3m-3 3a3 3 0 1 1 3 3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18M16 15h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5m0-8v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
};

function activityItem(icon, title, detail, right, rightClass = "", copyKeyId = "") {
  const copyBtn = copyKeyId
    ? `<button class="mini-copy" type="button" data-copy-key="${esc(copyKeyId)}" title="Copy key" aria-label="Copy key">${ICONS.copy}</button>`
    : "";
  return `<div class="activity-item">
    <span class="act-icon${icon === "wallet" ? " green" : ""}">${ICONS[icon] || ICONS.info}</span>
    <div class="activity-meta"><b>${esc(title)}${copyBtn}</b><small>${esc(detail)}</small></div>
    <span class="activity-right ${rightClass}">${esc(right)}</span>
  </div>`;
}

/* ---------------- app pages ---------------- */

async function showAppPage(page) {
  refreshShell();
  $$("[data-appnav]").forEach((a) => a.classList.toggle("active", a.dataset.appnav === page));
  $$("#view-app .app-page").forEach((p) => p.classList.remove("active"));
  $("page-" + page).classList.add("active");
  $("appTitle").textContent = APP_TITLES[page] || "Dashboard";

  try {
    if (page === "dashboard") await renderDashboard();
    if (page === "keys") await renderKeysPage();
    if (page === "bind") await renderBindPage();
    if (page === "balance") await renderBalancePage();
    if (page === "profile") renderProfilePage();
    if (page === "plans") await renderPlansPage();
  } catch (err) {
    if (err.status === 401) { location.hash = "#/login"; return; }
    toast(err.message);
  }
}

function fillStatCards(prefix, stats) {
  $(prefix + "Balance") && ($(prefix + "Balance").textContent = inr(stats.balance));
  $(prefix + "SpendToday") && ($(prefix + "SpendToday").textContent = inr(stats.spendToday));
  $(prefix + "SpendTotal") && ($(prefix + "SpendTotal").textContent = inr(stats.spendTotal));
  $(prefix + "Plan") && ($(prefix + "Plan").textContent = stats.plan ? stats.plan + " Plan" : "Free Plan");
  $(prefix + "PlanExpiry") && ($(prefix + "PlanExpiry").textContent = stats.plan && stats.planExpires ? "Expires: " + fmtDateShort(stats.planExpires) : "Expires: N/A");
}

async function renderDashboard() {
  await Promise.all([refreshStats(), loadKeys(), loadBindings(), loadTransactions()]);
  const stats = state.me.stats;
  fillStatCards("d", stats);

  const events = [];
  for (const tx of state.transactions.slice(0, 20)) {
    events.push({ at: tx.createdAt, icon: tx.amount > 0 ? "wallet" : "key", title: tx.type, detail: fmtDate(tx.createdAt) + (tx.ref ? " · " + tx.ref : ""), right: (tx.amount > 0 ? "+" : "−") + inr(Math.abs(tx.amount)), cls: tx.amount > 0 ? "green" : "" });
  }
  for (const b of state.bindings.slice(0, 10)) {
    events.push({ at: b.createdAt, icon: "link", title: "Key Bound", detail: "UID: " + b.uid, right: b.status, cls: b.status === "ACTIVE" ? "" : "muted" });
  }
  events.sort((a, b) => new Date(b.at) - new Date(a.at));

  $("recentActivity").innerHTML = events.length
    ? events.slice(0, 8).map((e) => activityItem(e.icon, e.title, e.detail, e.right, e.cls)).join("")
    : '<p class="empty-state">No activity yet. Generate your first key to get started.</p>';
}

async function renderKeysPage() {
  await Promise.all([refreshStats(), loadKeys()]);
  updateGeneratorUsage();
  const list = state.keys;
  $("keyHistoryList").innerHTML = list.length
    ? list.slice(0, 10).map((k) => activityItem("key", k.key, `${k.plan} · ${fmtDate(k.createdAt)}`, k.bound ? "BOUND" : "AVAILABLE", k.bound ? "muted" : "", k.id)).join("")
    : '<p class="empty-state">No keys generated yet.</p>';
}

function updateGeneratorUsage() {
  const stats = state.me.stats;
  const limit = stats.dailyLimit || 0;
  const used = stats.keysToday || 0;
  $("genUsage").textContent = `${used} / ${limit}`;
  $("genProgress").style.width = limit ? Math.min(100, (used / limit) * 100) + "%" : "0%";
}

async function renderBindPage() {
  await Promise.all([refreshStats(), loadBindings()]);
  renderBindingList();
}

function renderBindingList() {
  $("bindingList").innerHTML = state.bindings.length
    ? state.bindings.map((b) => `<div class="activity-item">
        <span class="act-icon">${ICONS.link}</span>
        <div class="activity-meta"><b>${esc(b.key)}</b><small>UID: ${esc(b.uid)} · Bound ${fmtDate(b.createdAt)}</small></div>
        <span class="activity-right countdown ${b.status === "EXPIRED" ? "expired" : ""}" data-countdown="${esc(b.expiresAt)}">${countdownText(b.expiresAt)}</span>
      </div>`).join("")
    : '<p class="empty-state">No bindings yet.</p>';
}

async function renderBalancePage() {
  await Promise.all([refreshStats(), loadTransactions()]);
  const stats = state.me.stats;
  fillStatCards("b", stats);
  const deposits = state.transactions.filter((t) => t.amount > 0);
  $("depositHistory").innerHTML = deposits.length
    ? deposits.slice(0, 10).map((t) => activityItem("wallet", `Deposit · ${t.ref || "Wallet"}`, fmtDate(t.createdAt), "+" + inr(t.amount), "green")).join("")
    : '<p class="empty-state">No deposits yet.</p>';
}

function renderProfilePage() {
  const { user, stats } = state.me;
  const label = planLabel();
  $("pfAvatar").textContent = initials(user.username);
  $("pfUsername").textContent = user.username;
  $("pfEmail").textContent = user.email;
  $("pfPlan").textContent = label;
  $("pfUsername2").textContent = user.username;
  $("pfEmail2").textContent = user.email;
  $("pfJoined").textContent = fmtDate(user.createdAt);
  $("pfPlanName").textContent = label;
  $("pfPlanExpiry").textContent = user.plan && user.planExpires ? fmtDate(user.planExpires) : "Expires: N/A";
  $("pfKeys").textContent = stats.totalKeys;
  $("pfActiveBindings").textContent = stats.activeBindings;
  $("pfExpiredBindings").textContent = stats.expiredBindings;
  $("pfUpgradeBtn").style.display = user.role === "admin" ? "none" : "";
}

async function renderPlansPage() {
  await Promise.all([refreshStats(), loadPlans()]);
  const { user } = state.me;
  const active = user.plan && (!user.planExpires || new Date(user.planExpires).getTime() > Date.now());
  $("planCurrentName").textContent = active ? user.plan + " Plan" : "Free";
  $("planCurrentDesc").textContent = active
    ? `Your ${user.plan} plan is active until ${fmtDate(user.planExpires)}.`
    : "You do not have an active plan yet. Choose one below to start generating keys.";

  $("plansGrid").innerHTML = state.plans.map((p, i) => `
    <article class="card plan-card ${i === 1 ? "featured" : ""}">
      ${i === 1 ? '<span class="plan-flag">HIGHER LIMIT</span>' : ""}
      <span class="plan-tag">${esc(p.tagline)}</span>
      <h3>${esc(p.name)} Plan</h3>
      <div class="plan-price">₹${p.price.toLocaleString("en-IN")} <small>INR · ${p.durationDays} days</small></div>
      <ul>
        <li>Up to <b>${p.dailyLimit} keys/day</b></li>
        <li>₹${state.keyPrice} per generated key</li>
        <li>7-day UID binding expiry</li>
        <li>24/7 support access</li>
      </ul>
      <button class="btn btn-primary full" data-buyplan="${esc(p.name)}" type="button" ${active && user.plan === p.name ? "disabled" : ""}>
        ${active && user.plan === p.name ? "Current Plan" : "Buy with Balance"}
      </button>
      <p class="plan-note">Purchase deducts from your wallet balance instantly. Prices and limits are enforced on the server.</p>
    </article>`).join("");
}

/* ---------------- admin pages ---------------- */

async function showAdminPage(page) {
  refreshShell();
  $$("[data-adminnav]").forEach((a) => a.classList.toggle("active", a.dataset.adminnav === page));
  $$("#view-admin .app-page").forEach((p) => p.classList.remove("active"));
  $("apage-" + page).classList.add("active");
  $("adminTitle").textContent = ADMIN_TITLES[page] || "Admin";

  try {
    if (page === "overview") await renderAdminOverview();
    if (page === "users") await renderAdminUsers();
    if (page === "keys") await renderAdminKeys();
    if (page === "deposits") await renderAdminDeposits();
    if (page === "transactions") await renderAdminTransactions();
    if (page === "plans") await renderAdminPlans();
  } catch (err) {
    if (err.status === 401) { location.hash = "#/login"; return; }
    if (err.status === 403) { location.hash = "#/app"; return; }
    toast(err.message);
  }
}

async function renderAdminOverview() {
  const data = await api("/api/admin/overview");
  $("ovUsers").textContent = data.totals.users.toLocaleString("en-IN");
  $("ovKeys").textContent = data.totals.keys.toLocaleString("en-IN");
  $("ovDeposits").textContent = inr(data.totals.todayDeposits);
  $("ovSpend").textContent = inr(data.totals.totalSpend);
  $("recentUsersBody").innerHTML = data.recentUsers.length
    ? data.recentUsers.map((u) => `<tr>
        <td><b>${esc(u.username)}</b>${u.role === "admin" ? ' <span class="pill red">ADMIN</span>' : ""}</td>
        <td>${inr(u.balance)}</td>
        <td>${u.plan ? `<span class="pill green">${esc(u.plan)}</span>` : '<span class="pill gray">Free</span>'}</td>
        <td class="mono">${fmtDateShort(u.createdAt)}</td>
      </tr>`).join("")
    : '<tr><td colspan="4">No users yet.</td></tr>';
}

async function renderAdminUsers() {
  const data = await api("/api/admin/users");
  $("adminUsersBody").innerHTML = data.users.length
    ? data.users.map((u) => `<tr>
        <td><b>${esc(u.username)}</b>${u.role === "admin" ? ' <span class="pill red">ADMIN</span>' : ""}</td>
        <td>${esc(u.email)}</td>
        <td>${esc(u.role)}</td>
        <td class="mono">${inr(u.balance)}</td>
        <td>${u.plan ? `<span class="pill green">${esc(u.plan)}</span>` : '<span class="pill gray">Free</span>'}</td>
        <td class="mono">${fmtDateShort(u.createdAt)}</td>
      </tr>`).join("")
    : '<tr><td colspan="6">No users yet.</td></tr>';
}

async function renderAdminKeys() {
  const data = await api("/api/admin/keys");
  $("adminKeysBody").innerHTML = data.keys.length
    ? data.keys.map((k) => `<tr>
        <td class="mono">${esc(k.key)}</td>
        <td>${esc(k.username)}</td>
        <td>${esc(k.plan)}</td>
        <td class="mono">${fmtDate(k.createdAt)}</td>
        <td>${k.bound ? '<span class="pill gray">Bound</span>' : '<span class="pill green">Available</span>'}</td>
      </tr>`).join("")
    : '<tr><td colspan="5">No keys yet.</td></tr>';
}

async function renderAdminDeposits() {
  const data = await api("/api/admin/deposits");
  $("adminDepositsBody").innerHTML = data.deposits.length
    ? data.deposits.map((d) => `<tr>
        <td>${esc(d.username)}</td>
        <td class="mono" style="color:var(--green)">+${inr(d.amount)}</td>
        <td class="mono">${esc(d.ref)}</td>
        <td class="mono">${fmtDate(d.createdAt)}</td>
      </tr>`).join("")
    : '<tr><td colspan="4">No deposits yet.</td></tr>';
}

async function renderAdminTransactions() {
  const data = await api("/api/admin/transactions");
  $("adminTxBody").innerHTML = data.transactions.length
    ? data.transactions.map((t) => `<tr>
        <td>${esc(t.username)}</td>
        <td>${esc(t.type)}</td>
        <td class="mono" style="color:${t.amount > 0 ? "var(--green)" : "var(--red)"}">${t.amount > 0 ? "+" : "−"}${inr(Math.abs(t.amount))}</td>
        <td class="mono">${esc(t.ref || "—")}</td>
        <td class="mono">${fmtDate(t.createdAt)}</td>
      </tr>`).join("")
    : '<tr><td colspan="5">No transactions yet.</td></tr>';
}

async function renderAdminPlans() {
  const data = await api("/api/admin/plans");
  $("adminPlansGrid").innerHTML = data.plans.map((p) => `
    <article class="card plan-card">
      <span class="plan-tag">${esc(p.tagline)}</span>
      <h3>${esc(p.name)} Plan</h3>
      <div class="plan-price">₹${p.price.toLocaleString("en-IN")} <small>INR</small></div>
      <ul>
        <li><b>${p.dailyLimit} keys/day</b> server-side limit</li>
        <li><b>${p.activeUsers}</b> active subscribers</li>
        <li>Duration: ${p.durationDays} days</li>
      </ul>
    </article>`).join("");
  $("adminNoPlan").textContent = `${data.usersWithoutPlan} user(s) currently have no active plan.`;
}

/* ---------------- auth flows ---------------- */

async function handleLogin(event) {
  event.preventDefault();
  const btn = $("loginSubmit");
  const identifier = $("loginUsername").value.trim();
  const password = $("loginAccessKey").value;
  const remember = $("loginRemember").checked;
  $("loginError").textContent = "";

  if (!identifier || !password) {
    $("loginError").textContent = "Enter your username and access key.";
    return;
  }
  setBtnLoading(btn, true);
  try {
    state.me = await api("/api/auth/login", { method: "POST", body: { identifier, password, remember } });
    refreshShell();
    closeModal("modalBuyPlan");
    toast(`Welcome back, ${state.me.user.username}.`, true);
    location.hash = "#/app";
    const active = state.me.user.plan && (!state.me.user.planExpires || new Date(state.me.user.planExpires).getTime() > Date.now());
    if (!active) setTimeout(() => openPlanModal(), 450);
  } catch (err) {
    $("loginError").textContent = "Invalid username or access key.";
    $("loginAccessKey").value = "";
    $("loginAccessKey").focus();
    openModal("modalBuyPlan");
  } finally {
    setBtnLoading(btn, false);
  }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* ignore */ }
  state.me = null;
  state.keys = []; state.bindings = []; state.transactions = [];
  updateHeader();
  toast("Logged out.");
  
const requestedRoute = sessionStorage.getItem("pa_after_login");
sessionStorage.removeItem("pa_after_login");

if (state.me.user.role === "admin") {
  location.hash = requestedRoute?.startsWith("/admin")
    ? "#" + requestedRoute
    : "#/admin";
} else {
  location.hash = "#/app";
}
}

/* ---------------- plan modal ---------------- */

async function openPlanModal() {
  try {
    await loadPlans();
    $("modalPlansList").innerHTML = state.plans.map((p) => `
      <div class="modal-plan">
        <div><b>${esc(p.name)} Plan</b><small>₹${p.price.toLocaleString("en-IN")} · ${p.dailyLimit} keys/day</small></div>
        <button class="btn btn-outline btn-sm" data-buyplan="${esc(p.name)}" type="button">SELECT</button>
      </div>`).join("");
    openModal("modalPlan");
  } catch (err) {
    toast(err.message);
  }
}

async function buyPlan(planName, btn) {
  setBtnLoading(btn, true);
  try {
    const data = await api("/api/plans/purchase", { method: "POST", body: { plan: planName } });
    state.me = { user: data.user, stats: data.stats };
    refreshShell();
    closeModal("modalPlan");
    toast(data.message, true);
    const route = currentRoute();
    if (APP_PAGES[route] !== undefined) await showAppPage(APP_PAGES[route]);
  } catch (err) {
    closeModal("modalPlan");
    if (err.code === "INSUFFICIENT_BALANCE") {
      toast(err.message + " Add balance first.");
      location.hash = "#/app/balance";
    } else {
      toast(err.message);
    }
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ---------------- key generation ---------------- */

async function generateKey() {
  const btn = $("generateBtn");
  const msg = $("keyMessage");
  msg.className = "form-message";
  msg.textContent = "";
  setBtnLoading(btn, true);
  try {
    const data = await api("/api/keys/generate", { method: "POST", body: {} });
    state.latestKey = data.key;
    $("latestKey").textContent = data.key;
    $("keyResult").classList.remove("hidden");
    msg.classList.add("ok");
    msg.textContent = data.message;
    await renderKeysPage();
    toast("Key generated successfully.", true);
  } catch (err) {
    if (err.code === "INSUFFICIENT_BALANCE") {
      msg.classList.add("err");
      msg.innerHTML = `Insufficient balance — each key costs ${inr(err.data?.required || 300)}. <button class="linklike" id="depositNowInline" type="button">Deposit Now</button>`;
      $("depositNowInline").addEventListener("click", () => { location.hash = "#/app/balance"; });
    } else if (err.code === "NO_PLAN") {
      openPlanModal();
    } else {
      msg.classList.add("err");
      msg.textContent = err.message;
    }
  } finally {
    setBtnLoading(btn, false);
  }
}

async function writeClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy copy */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

async function copyKeyById(id, btn) {
  let key;
  try {
    key = (await api("/api/keys/" + encodeURIComponent(id) + "/copy")).key;
  } catch (err) {
    return toast((err && err.message) || "Could not fetch the key.");
  }
  const ok = await writeClipboard(key);
  if (ok) {
    toast("Key copied to clipboard.", true);
    btn.classList.add("done");
    setTimeout(() => btn.classList.remove("done"), 1200);
  } else {
    toast("Copy blocked by browser. Key: " + key);
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy-key]");
  if (btn) copyKeyById(btn.dataset.copyKey, btn);
});

async function copyLatestKey() {
  if (!state.latestKey) return toast("Generate a key first.");
  try {
    await navigator.clipboard.writeText(state.latestKey);
    toast("Key copied to clipboard.", true);
  } catch {
    const range = document.createRange();
    range.selectNodeContents($("latestKey"));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast("Clipboard blocked — key selected, press Ctrl+C.");
  }
}

/* ---------------- binding ---------------- */

async function handleBind(event) {
  event.preventDefault();
  const key = $("bindKeyInput").value.trim().toUpperCase();
  const uid = $("bindUidInput").value.trim();
  const msg = $("bindMessage");
  msg.textContent = "";

  if (!/^PRIME-[A-Z0-9]{5}$/.test(key)) {
    msg.textContent = "Enter a valid key in the format PRIME-XXXXX.";
    return;
  }
  if (!/^[0-9]{5,12}$/.test(uid)) {
    msg.textContent = "UID must be 5-12 digits.";
    return;
  }
  const submitBtn = event.target.querySelector("button[type=submit]");
  setBtnLoading(submitBtn, true);
  try {
    const data = await api("/api/bind", { method: "POST", body: { key, uid } });
    $("bindUidInput").value = "";
    $("bindKeyInput").value = "";
    toast(data.message, true);
    await renderBindPage();
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    setBtnLoading(submitBtn, false);
  }
}

/* ---------------- deposit (simulated UPI flow) ---------------- */

function drawDemoQr(canvas, seedText) {
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  const cells = 25;
  const cell = Math.floor(size / cells);
  const offset = Math.floor((size - cell * cells) / 2);
  let seed = 0;
  for (const ch of seedText) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;

  function rand() {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#0d0d0f";

  const inFinder = (x, y) =>
    (x < 7 && y < 7) || (x >= cells - 7 && y < 7) || (x < 7 && y >= cells - 7);

  // timing patterns (row 6 / col 6) like a real QR
  for (let i = 8; i < cells - 8; i++) {
    if (i % 2 === 0) {
      ctx.fillRect(offset + i * cell, offset + 6 * cell, cell, cell);
      ctx.fillRect(offset + 6 * cell, offset + i * cell, cell, cell);
    }
  }

  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      if (inFinder(x, y)) continue;
      if (x === 6 || y === 6) continue;
      if (rand() > 0.52) ctx.fillRect(offset + x * cell, offset + y * cell, cell, cell);
    }
  }
  const finder = (fx, fy) => {
    ctx.fillStyle = "#0d0d0f";
    ctx.fillRect(offset + fx * cell, offset + fy * cell, 7 * cell, 7 * cell);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(offset + (fx + 1) * cell, offset + (fy + 1) * cell, 5 * cell, 5 * cell);
    ctx.fillStyle = "#0d0d0f";
    ctx.fillRect(offset + (fx + 2) * cell, offset + (fy + 2) * cell, 3 * cell, 3 * cell);
  };
  finder(0, 0);
  finder(cells - 7, 0);
  finder(0, cells - 7);

  // centre monogram badge
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(offset + 9 * cell, offset + 9 * cell, 7 * cell, 7 * cell);
  ctx.strokeStyle = "#0d0d0f";
  ctx.lineWidth = 2;
  ctx.strokeRect(offset + 9 * cell + 1, offset + 9 * cell + 1, 7 * cell - 2, 7 * cell - 2);
  ctx.fillStyle = "#FF173D";
  ctx.font = `bold ${Math.floor(cell * 2.2)}px Inter, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("PA", offset + 12.5 * cell, offset + 12.8 * cell);
}


function startDepositCountdown(amount) {
  $("depStepPay").classList.remove("hidden");
  $("depStepSuccess").classList.add("hidden");

  $("depAmountLabel").textContent = inr(amount);
  $("depAmountInline").textContent = inr(amount);
  $("depStatus").className = "form-message center";
  $("depStatus").textContent = "Waiting for payment…";

  drawDemoQr(
    $("depQr"),
    "upi://pay?pa=primeavay@upi&am=" + amount + "&tn=PRIME" + Date.now()
  );

  openModal("modalDeposit");

  // Random delay: 10–25 seconds for each deposit.
  const delay = Math.floor(Math.random() * 16) + 10;

  state.depositTimer = setTimeout(() => {
    state.depositTimer = null;
    confirmDemoDeposit(amount);
  }, delay * 1000);
}


async function confirmDemoDeposit(amount) {
  $("depStatus").textContent = "Confirming payment…";
  try {
    const data = await api("/api/deposit", { method: "POST", body: { amount } });
    await refreshStats();
    $("depSuccessAmount").textContent = inr(amount);
    $("depSuccessAdded").textContent = inr(amount);
    $("depStepPay").classList.add("hidden");
    $("depStepSuccess").classList.remove("hidden");
    toast(data.message, true);
    const route = currentRoute();
    if (route === "/app/balance") await renderBalancePage();
  } catch (err) {
    closeModal("modalDeposit");
    toast(err.message);
  }
}


function cancelDeposit() {
  if (state.depositTimer) {
    clearTimeout(state.depositTimer);
    clearInterval(state.depositTimer);
    state.depositTimer = null;
  }

  closeModal("modalDeposit");
  toast("Payment cancelled.");
}


function handleDepositStart() {
  const amount = Number($("depositAmount").value);
  $("depositError").textContent = "";
  if (!Number.isFinite(amount) || amount < 10 || amount > 50000) {
    $("depositError").textContent = "Enter an amount between ₹10 and ₹50,000.";
    return;
  }
  if (state.depositTimer) {
  return toast("A deposit is already in progress.");
}
startDepositCountdown(amount);
}

/* ---------------- settings ---------------- */

async function handlePasswordChange(event) {
  event.preventDefault();
  const msg = $("pwMessage");
  msg.textContent = "";
  const current = $("pwCurrent").value;
  const nextPw = $("pwNew").value;
  if (!current || !nextPw) { msg.textContent = "Fill in both fields."; return; }
  const btn = event.target.querySelector("button[type=submit]");
  setBtnLoading(btn, true);
  try {
    const data = await api("/api/auth/change-password", { method: "POST", body: { currentPassword: current, newPassword: nextPw } });
    msg.style.color = "var(--green)";
    msg.textContent = data.message;
    $("pwForm").reset();
    toast("Password updated.", true);
  } catch (err) {
    msg.style.color = "";
    msg.textContent = err.message;
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ---------------- contact (demo) ---------------- */

function handleContact(event) {
  event.preventDefault();
  const name = $("ctName").value.trim();
  const email = $("ctEmail").value.trim();
  const message = $("ctMsg").value.trim();
  const err = $("contactError");
  err.textContent = "";
  if (name.length < 2) { err.textContent = "Enter your name."; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = "Enter a valid email address."; return; }
  if (message.length < 10) { err.textContent = "Message must be at least 10 characters."; return; }
  $("contactForm").reset();
  toast("Message sent. Our support team will reply within minutes.", true);
}

/* ---------------- particles ---------------- */

function initParticles() {
  const canvas = $("particleCanvas");
  if (!canvas) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const ctx = canvas.getContext("2d");
  let width = 0, height = 0, particles = [];

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    width = canvas.width = Math.floor(rect.width);
    height = canvas.height = Math.floor(rect.height);
  }

  function spawn() {
    particles = Array.from({ length: Math.min(46, Math.floor(width / 30)) }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 0.6 + Math.random() * 1.8,
      vy: 0.12 + Math.random() * 0.35,
      vx: (Math.random() - 0.5) * 0.12,
      a: 0.15 + Math.random() * 0.5
    }));
  }

  function frame() {
    if (!document.getElementById("view-landing").classList.contains("active")) {
      requestAnimationFrame(frame);
      return;
    }
    ctx.clearRect(0, 0, width, height);
    for (const p of particles) {
      p.y -= p.vy;
      p.x += p.vx;
      if (p.y < -6) { p.y = height + 6; p.x = Math.random() * width; }
      if (p.x < -6) p.x = width + 6;
      if (p.x > width + 6) p.x = -6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 23, 61, ${p.a})`;
      ctx.shadowColor = "rgba(255,23,61,.8)";
      ctx.shadowBlur = 6;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    requestAnimationFrame(frame);
  }

  resize();
  spawn();
  window.addEventListener("resize", () => { resize(); spawn(); });
  requestAnimationFrame(frame);
}

/* ---------------- event wiring ---------------- */

function wireEvents() {
  // header
  $("headerAuth").addEventListener("click", () => {
    if (!state.me) { location.hash = "#/login"; return; }
    location.hash = state.me.user.role === "admin" ? "#/admin" : "#/app";
  });
  $("navToggle").addEventListener("click", () => document.body.classList.toggle("nav-open"));
  $$("#siteNav a").forEach((a) => a.addEventListener("click", () => document.body.classList.remove("nav-open")));

  // auth
  $("loginForm").addEventListener("submit", handleLogin);
  $("forgotLink").addEventListener("click", () => openModal("modalForgot"));

  // Telegram plan purchase redirects
  $$("[data-tg-buy]").forEach((btn) => {
    btn.addEventListener("click", () => window.open("https://t.me/prime_avay", "_blank", "noopener"));
  });

  // password toggles
  $$("[data-pwtoggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.pwtoggle);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.classList.toggle("on", show);
      input.focus();
    });
  });

  // contact
  $("contactForm").addEventListener("submit", handleContact);

  // app nav / logout
  $("appLogout").addEventListener("click", logout);
  $("settingsLogout").addEventListener("click", logout);
  $("adminLogout").addEventListener("click", logout);
  $("appNavToggle").addEventListener("click", () => document.body.classList.toggle("side-open"));
  $("adminNavToggle").addEventListener("click", () => document.body.classList.toggle("side-open"));

  // scrim for mobile sidebar
  const scrim = document.createElement("div");
  scrim.className = "side-scrim";
  scrim.addEventListener("click", () => document.body.classList.remove("side-open"));
  document.body.appendChild(scrim);

  // keys
  $("generateBtn").addEventListener("click", generateKey);
  $("copyKeyBtn").addEventListener("click", copyLatestKey);

  // bind
  $("bindForm").addEventListener("submit", handleBind);

  // balance
  $$("[data-quick]").forEach((b) => {
    b.addEventListener("click", () => {
      $("depositAmount").value = b.dataset.quick;
      $$("[data-quick]").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  $("depositBtn").addEventListener("click", handleDepositStart);
  $("depCancel").addEventListener("click", cancelDeposit);
  $("depBackDash").addEventListener("click", () => {
    closeModal("modalDeposit");
    location.hash = "#/app";
  });

  // profile
  $("pfUpgradeBtn").addEventListener("click", () => { location.hash = "#/app/plans"; });

  // settings
  $("pwForm").addEventListener("submit", handlePasswordChange);

  // modals: close buttons
  $$("[data-close]").forEach((btn) => btn.addEventListener("click", () => {
    closeModal(btn.dataset.close);
    if (btn.dataset.close === "modalBuyPlan") location.hash = "#/";
  }));
  $$("[data-close-href]").forEach((a) => a.addEventListener("click", () => closeModal(a.dataset.closeHref)));
  $$(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop && backdrop.id === "modalForgot") closeModal(backdrop.id);
    });
  });

  // plan modal
  $("planModalView").addEventListener("click", () => {
    closeModal("modalPlan");
    location.hash = "#/app/plans";
  });

  // plan purchase buttons (dynamic)
  document.addEventListener("click", (e) => {
    const buy = e.target.closest("[data-buyplan]");
    if (buy && !buy.disabled) buyPlan(buy.dataset.buyplan, buy);
  });

  // escape closes modals
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $$(".modal-backdrop:not(.hidden)").forEach((m) => closeModal(m.id));
  });
}

/* ---------------- boot ---------------- */

(async function boot() {
  wireEvents();
  if (!location.hash) location.hash = "#/";
  await loadMe();
  await navigate();
  initParticles();
})();