# Signature Modmail Bot

A custom Discord modmail bot for the **Signature** server.

- A user DMs the bot → it asks their **language** (English / Français), then the **type of support**
  (categories are fully custom — Technical Support, Question, Custom Services, or anything you add), then
  a short **form** with the questions you configured for that category. Questions can be **conditional**:
  e.g. "Custom Services" asks "which service?" first, then asks a *different* follow-up question depending
  on the answer (logo → style question, website → page count, etc.) — all built visually, no code.
- The bot then creates a **private staff-only ticket channel** on the server, visible only to the roles
  you mapped to that category, and relays every DM ↔ channel message both ways.
- **Redirect**: staff can move a ticket to a different category/team from a button on the ticket — access
  updates immediately to the new category's roles.
- **Auto-close on inactivity**: if staff have replied at least once (staff can take as long as they want
  before that first reply) and the ticket then goes quiet for 24h (configurable), the user gets a DM
  warning; if they still don't respond within 1h (configurable) the ticket closes automatically.
- **Ratings**: right after a ticket closes, the user gets a DM asking them to rate the support 1–5 stars
  with an optional comment.
- Staff close the ticket with the **Close ticket** button or `/close`.
- Everything below is managed visually from a built-in **web dashboard** (password protected): categories,
  conditional questions, role mapping, all bot texts (EN/FR), auto-close timing, average rating, and the
  full transcript of every closed ticket.

## 1. Project layout

```
src/
  index.js            Entry point: starts the web server (dashboard + health check) and the bot
  bot.js              All Discord logic: DM flow, ticket creation, relay, redirect, rating, auto-close
  flow.js             The conditional question engine (text/choice questions, showIf branching)
  config.js           Reads/writes data/config.json (categories, questions, roles, texts, settings)
  store.js            Reads/writes data/tickets.json (open tickets: transcript, activity, staff flag)
  archive.js          Reads/writes data/archive.json (closed tickets: full transcript + rating)
  i18n.js             Reads the dashboard-editable EN/FR texts, with built-in fallbacks
  deploy-commands.js  One-off script to register the /close and /ping slash commands
  dashboard/
    server.js         Express routes + JSON API for the dashboard
    public/           Dashboard front-end (login.html, index.html, style.css, app.js)
data/
  config.json          Default categories/texts/settings — edited at runtime via the dashboard
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

`data/config.json`, `data/tickets.json` and `data/archive.json` live on Render's local disk, which is
**wiped on every new deploy** (and on free-plan sleep/wake cycles). `tickets.json` is fine to lose (open
tickets are transient), but **your custom categories, edited texts, and the ratings/transcripts archive
will reset** the next time you push to GitHub. Two options:
- Fine for now: re-add any custom categories after a redeploy (rare once things are set up), and treat
  the transcripts archive as "since the last deploy".
- For real persistence: upgrade to a Render paid plan and attach a **Persistent Disk** mounted at
  `/opt/render/project/src/data`, or swap `config.js`/`store.js`/`archive.js` for a small database (e.g. a
  free MongoDB Atlas cluster). Happy to wire that up if you want it — just ask.

## 6. Managing everything from the dashboard

Open `/dashboard`, log in, and use the four tabs:

- **Paramètres** — support team name, and the auto-close timing (hours of inactivity before the warning
  DM, minutes of grace period before the ticket actually closes).
- **Catégories** — for each category: emoji + English/French label, which roles can see its tickets, and
  its questions. A question is either a **text answer** or a **multiple choice** (which becomes a select
  menu). Any question can be set to "Afficher seulement si" (only show if) an *earlier* choice question in
  the same category was answered a specific way — this is what powers "Custom Services → which service? →
  a different follow-up question per answer". Questions are asked in the order they appear in the list.
- **Textes** — every bilingual message the bot sends during the ticket flow (welcome message, ticket
  created/closed DMs, inactivity warning, rating request, redirect notice, etc.), fully editable.
- **Avis & Transcripts** — average rating and total ratings at a glance, plus every closed ticket with its
  full conversation transcript (click a row to expand it) and any comment left with the rating.

Click **+ Nouvelle catégorie** to add something like "Custom Services" from scratch — it appears in the
Discord menu immediately (until the disk resets, see above).

## 7. Slash commands

- `/close` — closes the current ticket channel (must be run inside a ticket channel).
- `/ping` — quick check that the bot is online.

Staff can also use the **Close ticket** and **Redirect** buttons posted automatically at the top of every
ticket channel. Redirect lets staff move a ticket to a different category (e.g. a player opened "Other"
but actually wants a custom order) — it re-assigns which roles can see the channel to match the new
category, and posts a notice in the channel.

## 8. Notes on behavior

- Only DMs to the bot start the flow; messages in the server are ignored unless they're inside an active
  ticket channel (then they're relayed to the user).
- A staff message starting with `!` in a ticket channel is treated as an **internal note** and is *not*
  forwarded to the user, but is still saved in the transcript — handy for staff-only discussion.
- If the user's DMs are closed, staff get a warning in the ticket channel instead of a silent failure.
- **Auto-close**: the bot checks every 5 minutes. A ticket is only eligible once staff have sent at least
  one message in it (so tickets waiting on a first reply are never auto-closed). Any new message from
  either side resets the inactivity clock and cancels a pending warning.
- **Ratings**: sent as a DM right after closing, with 1–5 star buttons and an optional comment via a small
  follow-up form. Entirely optional for the user — ignoring the message just leaves no rating.
