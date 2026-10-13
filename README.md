# PRIME AVAY V2 — Full-stack portal

Premium red/black gaming portal for Free Fire ID unban keys: landing page, auth, dashboard,
key generator, UID binding, demo wallet, plans, and admin panel.

## Run (Windows CMD)

```bat
cd "C:\My Projects\unban"
npm install
npm start
```

Open http://localhost:3000

## Admin access (seeded on first run)

- Username: `primeavay`
- Password: `999`

Override via `ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars before the first run.
There is **no Register page** — accounts are created manually (admin) or via Telegram
(@prime_avay). Visitors without valid credentials get a plan popup on the login page;
buying redirects to https://t.me/prime_avay.

## What's inside

| Piece | Where |
|---|---|
| Express server (API + static) | `server.js` |
| JSON data store (users/keys/bindings/transactions/sessions) | `server/store.js`, `data/data.json` |
| Password hashing (scrypt) + httpOnly sessions | `server/auth.js` |
| API routes (auth, keys, bind, deposit, plans, admin) | `server/routes.js` |
| SPA shell (all views) | `public/index.html` |
| Design system CSS | `public/style.css` |
| Router + page logic | `public/js/app.js` |
| Generated artwork | `public/assets/` |

## Rules enforced on the server

- Key generation: ₹300/key, balance checked and deducted server-side, `PRIME-XXXXX` unique keys,
  per-plan daily limits (Premium 25/day, Ultimate 50/day) using the server's date, per-user
  in-flight lock against double submits.
- Binding: key must belong to you and be unbound; expiry is always exactly 7 days.
- Plans: Premium ₹999 / Ultimate ₹1,999, 30 days, purchased with (demo) balance — never auto-activated.
- Admin: role checked on every admin API; client-side flags are never trusted.
- Auth: scrypt-hashed passwords, httpOnly `SameSite=Lax` session cookie, login rate limiting,
  custom-header CSRF guard on all mutating API calls.

## Demo mode (important)

Deposits and plan purchases are **simulated** — no real payment gateway is connected. The
deposit flow (QR + 10s countdown) is a self-contained demo module in `public/js/app.js`
that presents as a UPI payment UI; swap the `POST /api/deposit` implementation for a real
gateway when ready. No real payment is processed.

PRIME AVAY is an independent service, not affiliated with Garena. No unban outcome is guaranteed.
