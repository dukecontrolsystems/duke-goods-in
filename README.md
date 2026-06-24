# Duke Goods-In — Deployment Guide

## Deploy to Railway

### 1. Create GitHub repo
```bash
cd duke-goods-in
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/duke-goods-in.git
git push -u origin main
```

### 2. Create Railway project
1. Go to railway.app → New Project → Deploy from GitHub repo
2. Select `duke-goods-in`
3. Railway auto-detects Node.js and deploys

### 3. Add environment variables in Railway
Go to your service → Variables → Add:

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `SESSION_SECRET` | Any long random string |
| `DB_PATH` | `/data/goods-in.db` |
| `UPLOAD_DIR` | `/data/uploads` |

### 4. Add persistent volume
1. Railway service → Settings → Add Volume
2. Mount path: `/data`
3. This keeps the database and uploaded images across deploys

### 5. Add custom domain
1. Railway service → Settings → Domains → Add Custom Domain
2. Enter: `goods-in.dukecontrolsystems.com`
3. Add the CNAME record to your DNS (Netlify/Cloudflare):
   - Type: CNAME
   - Name: `goods-in`
   - Value: the Railway-provided domain (e.g. `duke-goods-in-production.up.railway.app`)

---

## Default logins
| Name | PIN | Role |
|------|-----|------|
| Stephen | 1234 | Admin |
| Nick | 2345 | Staff |
| Rob | 3456 | Staff |
| Site Staff | 0000 | Staff |

Change PINs via the database or add a user management endpoint.

## Mobile use on site
- Open `goods-in.dukecontrolsystems.com` on any phone browser
- Tap **"Add to Home Screen"** for a native app-like experience
- On the Receive tab, tap **📷 Take photo** to photograph a delivery note with the camera
- AI reads it, matches it to a PO, and shows what's received vs missing

## Architecture
- Node.js + Express
- SQLite (via better-sqlite3) — persistent on Railway volume
- Anthropic Claude API for document reading and matching
- Mobile-first responsive UI, no framework dependencies
