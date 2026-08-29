# Signature Modmail Bot

A custom Discord modmail bot for the **Signature** server.

- A user DMs the bot → it asks their **language** (English / Français), then the **type of support**
  (categories are fully custom — Technical Support, Question, Other, or anything you add), then a short
  **modal form** with the questions you configured for that category.
- The bot then creates a **private staff-only ticket channel** on the server, visible only to the roles
  you mapped to that category, and relays every DM ↔ channel message both ways.
- Staff close the ticket with the **Close ticket** button or `/close`.
- Categories, questions and role mapping are managed visually from a small built-in **web dashboard**
  (password protected) — no code editing needed to add a "Custom Services" category, for example.

## 1. Project layout

```
src/
  index.js            Entry point: starts the web server (dashboard + health check) and the bot
  bot.js              All Discord logic: DM flow, ticket creation, message relay, /close
  config.js           Reads/writes data/config.json (categories, questions, roles, settings)
  store.js            Reads/writes data/tickets.json (which channel belongs to which user)
  i18n.js             EN/FR strings shown during the ticket flow
  deploy-commands.js  One-off script to register the /close and /ping slash commands
  dashboard/
    server.js         Express routes + JSON API for the dashboard
    public/           Dashboard front-end (login.html, index.html, style.css, app.js)
data/
  config.json          Default categories — edited at runtime via the dashboard
```

## 2. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → name it e.g. `Signature`.
2. **Bot** tab → **Reset Token**, copy it → this is your `DISCORD_TOKEN`. Keep it secret.
3. Still on the **Bot** tab, enable **Message Content Intent** (required to read DM/ticket content).
4. **General Information** tab → copy the **Application ID** → this is your `CLIENT_ID`.
5. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; bot permissions: `View Channels`,
   `Send Messages`, `Manage Channels`, `Embed Links`, `Attach Files`, `Read Message History`. Open the
   generated URL and invite the bot to your Signature server.
6. In Discord, enable Developer Mode (User Settings → Advanced), right-click your server icon → **Copy
   Server ID** → this is your `GUILD_ID`.
7. Create the staff roles you want to route tickets to (or reuse existing ones) — you'll assign them per
   category from the dashboard once it's running.

## 3. Run it locally (optional, to test before deploying)

```bash
npm install
cp .env.example .env
# fill in DISCORD_TOKEN, CLIENT_ID, GUILD_ID, DASHBOARD_PASSWORD, SESSION_SECRET in .env
npm run deploy-commands   # registers /close and /ping on your server
npm start
```

Visit `http://localhost:3000/dashboard` and log in with your `DASHBOARD_PASSWORD` to add/edit categories,
then DM your bot on Discord to test the flow.

## 4. Push to GitHub

```bash
git init
git add .
git commit -m "Signature modmail bot"
git branch -M main
git remote add origin https://github.com/<your-username>/signature-modmail-bot.git
git push -u origin main
```

`.env` is git-ignored — never commit your bot token. `.env.example` documents which variables to set.

## 5. Deploy on Render

1. [render.com](https://render.com) → **New +** → **Web Service** → connect the GitHub repo you just pushed.
2. Settings:
   - **Environment**: Node
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free is enough to start
3. **Environment** tab → add the same variables as your `.env` (`DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`,
   `DASHBOARD_PASSWORD`, `SESSION_SECRET`). Don't set `PORT`, Render provides it automatically.
4. Deploy. Once live, open `https://<your-service>.onrender.com/dashboard` to manage categories, and
   `https://<your-service>.onrender.com/` should show "Signature Modmail Bot is running." — Render pings
   that URL to know the service is healthy.
5. Register the slash commands once against your live bot: easiest is to run
   `npm run deploy-commands` locally with the same `.env` values — you only need to do this again when
   you add/rename slash commands.

### Keeping it awake on the free plan

Render's free web services fall asleep after ~15 minutes without traffic, which would disconnect the bot.
Use a free uptime pinger such as [UptimeRobot](https://uptimerobot.com) to hit your Render URL (`/`) every
5 minutes — that keeps it alive at no cost. If you'd rather not depend on that, Render's paid Starter plan
($7/mo) doesn't sleep.

### About data persistence

`data/config.json` and `data/tickets.json` live on Render's local disk, which is **wiped on every new
deploy** (and on free-plan sleep/wake cycles). That's fine for `tickets.json` (open tickets are transient),
but it means **categories you add from the dashboard will reset to the defaults the next time you push to
GitHub**. Two options:
- Fine for now: re-add any custom categories after a redeploy (rare once things are set up).
- For real persistence: upgrade to a Render paid plan and attach a **Persistent Disk** mounted at
  `/opt/render/project/src/data`, or swap `config.js`/`store.js` for a small database (e.g. a free
  MongoDB Atlas cluster). Happy to wire that up if you want it — just ask.

## 6. Managing categories from the dashboard

Open `/dashboard`, log in, and for each category you can edit:
- **Emoji + English/French label** — what the user sees in the selection menu.
- **Roles that can see these tickets** — click role chips to toggle; only those roles (plus the bot) can
  view the created ticket channel.
- **Questions** (up to 5, Discord's modal limit) — each has an English and French label, "Long answer" vs
  "Short answer", and whether it's required. These become the form the user fills in right before the
  ticket is created.

Click **+ New category** to add something like "Custom Services", assign it to the right role, and it
appears in the menu immediately — no redeploy needed (until the disk resets, see above).

## 7. Slash commands

- `/close` — closes the current ticket channel (must be run inside a ticket channel).
- `/ping` — quick check that the bot is online.

Staff can also click the **Close ticket** button posted automatically at the top of every ticket channel.

## 8. Notes on behavior

- Only DMs to the bot start the flow; messages in the server are ignored unless they're inside an active
  ticket channel (then they're relayed to the user).
- A staff message starting with `!` in a ticket channel is treated as an **internal note** and is *not*
  forwarded to the user — handy for staff-only discussion inside the ticket.
- If the user's DMs are closed, staff get a warning in the ticket channel instead of a silent failure.
