PRIME AVAY V2 - Full-stack red gaming portal

SETUP (Windows CMD)
1. Open CMD in this folder.
2. Run: npm install
3. Run: npm start
4. Open: http://localhost:3000

ADMIN LOGIN (seeded on first run)
Username: primeavay
Password: 999
(Override with ADMIN_USERNAME / ADMIN_PASSWORD env vars before first run.
There is NO Register page - accounts are created manually (admin) or via Telegram
@prime_avay. Wrong login credentials show a plan popup; Buy redirects to
https://t.me/prime_avay)

FEATURES
- Landing page: hero, trust cards, How It Works, Features, FAQ, Contact, Privacy/Terms.
- Login only (username + access key) with server-side validation, hashed passwords,
  httpOnly sessions. No registration - unknown credentials get a plan-buy popup.
- Dashboard: balance, spend today/total, plan, quick actions, recent activity.
- Key Generator: PRIME-XXXXX keys, Rs.300 each, masked history, copy button,
  Premium 25/day, Ultimate 50/day (server-enforced), insufficient-balance guard.
- Bind Key: bind to Free Fire UID, exactly 7-day expiry with live per-second countdown.
- Balance: demo deposits only (10s simulated payment, DEMO QR), deposit history.
- Plans: Premium Rs.999 / 25 keys per day, Ultimate Rs.1,999 / 50 keys per day,
  30-day activation, bought with demo balance. "No Active Plan / Need to Buy Plan"
  modal after login without a plan.
- Admin panel (server-verified role): users, keys, deposits, transactions, plans.

SECURITY
- scrypt password hashing, httpOnly SameSite=Lax cookies, rate-limited auth endpoints,
  CSRF custom-header guard, admin checks on every admin API.

IMPORTANT
Simulated financial mode: deposits/plan purchases present as a UPI payment UI but no real
payment gateway is connected; integrate a real one in POST /api/deposit when ready.
Independent service - not affiliated with Garena. No unban outcome is guaranteed.
