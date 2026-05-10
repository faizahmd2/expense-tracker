# Paisa — Personal Expense Tracker

Automatic transaction logs on iPhone integrated with push message reads from banking/upi apps.

---

## Architecture

```
iPhone
├── Native iOS App (Notification Service Extension)
│   ├── Reads bank / UPI push notifications
│   ├── Parses and queues transactions locally
│   └── Syncs to Mac via Tailscale when connected
│
└── PWA (Safari / WKWebView)
    └── Full CRUD UI — works offline via IndexedDB queue

MacBook (always-on via launchd)
├── Node.js + Express backend
├── SQLite — one file per year (db-2026.sqlite)
├── Serves the PWA
└── Nightly backup → iCloud
```

---

## First-time setup (Mac)

```bash
# 1. Clone / download to your home folder
cd ~/
git clone <your-private-repo> ExpenseTracker
cd ExpenseTracker

# 2. Run setup (installs deps, creates secrets, registers launchd service)
bash scripts/setup.sh
```

That's it. The server now starts automatically on every login.

---

## Accessing the app

- **On Mac:**         http://localhost:3000
- **On iPhone (home WiFi):** http://<your-mac-local-ip>:3000
- **Anywhere (Tailscale):**  http://<mac-tailscale-hostname>:3000

### Installing Tailscale (recommended)
1. Download Tailscale on Mac + iPhone from tailscale.com
2. Sign in with the same account on both
3. Your Mac will appear as e.g. `macbook.tail1234.ts.net`
4. Open `http://macbook.tail1234.ts.net:3000` from iPhone — done

---

## First time in browser

The app will ask for your **API secret** on first open.
Find it in `secrets.env` under `API_SECRET=`.

---

## Folder structure

```
ExpenseTracker/
├── server/              Node.js backend
│   ├── db/              SQLite connection, migrations, seed data
│   ├── routes/          API endpoints
│   ├── parser/          Notification parser + merchant learning
│   ├── jobs/            Backup + new-year automation
│   └── middleware/      Auth, error handler
├── pwa/                 Frontend (HTML + CSS + JS, no build step)
├── data/                SQLite files + logs (gitignored)
│   ├── db-2026.sqlite   Active year database
│   └── server.log       Server output
├── scripts/             Maintenance scripts
├── config.json          Non-secret app settings
├── secrets.env          Secrets — never commit this
└── com.paisa.server.plist  launchd service definition
```

---

## Daily usage

The server runs silently in the background. You never open a terminal.

- **Add transaction:**        Tap + in the app
- **Review parsed notifs:**   Yellow dot = needs review, tap to edit
- **Change category:**        Tap category chip on any transaction row
- **Search:**                 Tap 🔍 in top bar
- **Monthly summary:**        Summary tab in bottom nav

---

## Manual backup

```bash
npm run backup
```

Automatic backup runs at 2am daily and copies to iCloud.

---

## Restore from backup

```bash
bash scripts/restore.sh ~/Library/Mobile\ Documents/com~apple~CloudDocs/ExpenseBackups/db-2026-2026-01-15.sqlite
```

---

## Server management

```bash
# Check if running
launchctl list | grep paisa

# View logs
tail -f data/server.log

# Restart
launchctl unload ~/Library/LaunchAgents/com.paisa.server.plist
launchctl load   ~/Library/LaunchAgents/com.paisa.server.plist

# Stop permanently
launchctl unload ~/Library/LaunchAgents/com.paisa.server.plist
```

---

## Configuring accounts

Edit `config.json` and add/remove entries in the `accounts` array.
The server seeds them into the database on next restart.

---

## gitignore

```
data/
secrets.env
node_modules/
```
