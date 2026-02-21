# 🐒 MonkeySkript — Setup & Hosting Guide

## What you're deploying
A real-time multiplayer Skript IDE with:
- **Socket.IO** for live code sync between users
- **SQLite** database that persists all scripts permanently
- **Room system** — create/join rooms with a code like `MONK-AB3X`

---

## 📁 Project Structure
```
monkeyskript/
├── server.js          ← Node.js backend (Express + Socket.IO + SQLite)
├── package.json       ← Dependencies
├── render.yaml        ← Render.com deploy config
├── .gitignore
├── public/
│   └── index.html     ← The full IDE frontend
└── data/              ← Auto-created, holds monkeyskript.db
```

---

## 🚀 Step 1 — Run Locally First (Test It)

You need **Node.js 18+** installed. Check: `node --version`
If you don't have it: https://nodejs.org

```bash
# 1. Open a terminal and go into the project folder
cd monkeyskript

# 2. Install dependencies
npm install

# 3. Start the server
npm start
```

You should see:
```
🐒 MonkeySkript server running on http://localhost:3000
```

Open **http://localhost:3000** in your browser. It works!

To test multiplayer locally: open two browser tabs, create a room in one, join with the code in the other.

---

## ☁️ Step 2 — Deploy to Render (Free Hosting)

Render.com is the best free option — it's reliable and doesn't require a credit card for basic use.

### 2a. Push to GitHub

1. Go to **https://github.com** and create a free account if you don't have one
2. Create a **new repository** called `monkeyskript` (set it to Private if you want)
3. In your terminal, inside the `monkeyskript` folder:

```bash
git init
git add .
git commit -m "🐒 Initial MonkeySkript commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/monkeyskript.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

---

### 2b. Deploy on Render

1. Go to **https://render.com** and sign up (use your GitHub account to sign in — easiest)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub account and select your `monkeyskript` repo
4. Fill in the settings:

| Setting | Value |
|---|---|
| **Name** | monkeyskript |
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Instance Type** | Free |

5. Click **"Create Web Service"**

Render will build and deploy — takes about 2 minutes. You'll get a live URL like:
```
https://monkeyskript.onrender.com
```

**Share that URL with your friends!** Anyone who opens it can use the IDE.

---

### 2c. Add a Persistent Disk (So Scripts Don't Disappear)

By default Render's free tier resets files on each deploy. To keep your SQLite database:

1. In your Render service, go to **"Disks"** tab
2. Click **"Add Disk"**
3. Fill in:
   - **Name:** `monkeyskript-data`
   - **Mount Path:** `/data`
   - **Size:** 1 GB (free)
4. Save

Then update `server.js` line 10 to use `/data` instead of `__dirname`:
```js
// Change this line:
const db = new Database(path.join(__dirname, 'data', 'monkeyskript.db'));

// To this:
const db = new Database('/data/monkeyskript.db');
```

Commit and push the change:
```bash
git add server.js
git commit -m "use persistent disk for DB"
git push
```

Render will auto-redeploy.

---

## 💡 How to Use with Friends

1. **You** open the site and click **⚡ Live Share**
2. Click **"Create Room"**, enter your name, click **🚀 Create Room**
3. You'll get a code like `MONK-AB3X`
4. **Send that code** to your friends
5. Friends open the same site URL, click **⚡ Live Share** → **Join Existing Room →**, paste the code, done!

Everyone in the room:
- Sees each other's avatars in the top bar
- Gets live updates when anyone edits a file
- All files auto-save to the server database permanently

---

## 🔧 Troubleshooting

**"npm install" fails with errors about better-sqlite3**
> This can happen on some systems. Run: `npm install --build-from-source`

**Render free tier goes to sleep after 15 minutes of inactivity**
> The first person to open the site after a sleep period waits ~30 seconds for it to wake up. This is a Render free tier limitation. To avoid it, upgrade to Render's $7/month Starter plan, or use Railway instead.

**Scripts are gone after redeploy**
> You haven't set up the persistent disk yet. Follow Step 2c above.

**Friends can't connect**
> Make sure they're using the full Render URL (the `.onrender.com` one), not your local `localhost:3000`.

---

## 🛤️ Alternative: Railway (also free)

If you prefer Railway over Render:

1. Go to **https://railway.app** and sign in with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `monkeyskript` repo
4. Railway auto-detects Node.js and deploys
5. Go to **Settings** → **Networking** → **"Generate Domain"** to get your public URL
6. For the database: Railway gives you a persistent volume — your SQLite file will survive redeploys automatically

Railway gives $5/month free credit which is enough for a small app running 24/7.

---

## ✅ Quick Checklist

- [ ] `npm install` worked locally
- [ ] `npm start` opens the IDE at localhost:3000
- [ ] Multiplayer works locally (two tabs, same room code)
- [ ] GitHub repo created and code pushed
- [ ] Render (or Railway) service created
- [ ] Persistent disk added (Render) or confirmed (Railway)
- [ ] Live URL shared with friends
- [ ] Everyone can create/join rooms and co-edit scripts
