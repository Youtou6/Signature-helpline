# Signature Modmail Bot

A custom Discord modmail bot for the **Signature** server.

- A user DMs the bot → it asks their **language** (English / Français), then the **type of support**
  (categories are fully custom — Technical Support, Question, Custom Services, or anything you add), then
  a short **form** with the questions you configured for that category. Questions can be **conditional**:
  e.g. "Custom Services" asks "which service?" first, then asks a *different* follow-up question depending
  on the answer (logo → style question, website → page count, etc.) — all built visually, no code.
- The bot then creates a **private staff-only ticket channel** on the server, visible only to the roles
  you mapped to that category, and relays every DM ↔ channel message both ways.
- **Restart anytime**: at any point during the intake questions, the user can hit "🔄 Restart" (or just type
  "restart"/"recommencer") to wipe whatever they'd filled in so far and start over from the language choice,
  with a confirmation message.
- **Survives restarts**: ticket state is saved to disk as the bot runs, and on top of that, every ticket
  channel's topic secretly encodes the user/category/language — so if the bot restarts and its on-disk
  memory is gone (e.g. a fresh Render deploy), it rebuilds its list of open tickets straight from the
  existing Discord channels, including a best-effort replay of the conversation.
- **Settings and reviews always saved**: with a free Upstash Redis database connected (see "Persisting
  everything with Upstash" below), every category, text, setting, rating, and ban is instantly backed up
  and automatically restored on startup — a redeploy never resets them.
- **Bot status**: set what the bot is shown as doing ("Watching for new tickets", "Listening to...", a
  Twitch stream, etc.) and its online/idle/dnd status, right from the dashboard.
- **Staff tools on every ticket**: besides Close/Redirect/Claim, staff get **Remind now** (send the
  inactivity warning immediately instead of waiting 24h) and **Ban user** (bans them from opening new
  tickets and closes this one, with a confirmation step).
- **Bans**: manage a ban list from the dashboard — banned users get a polite message instead of being able
  to open a ticket.
- **Staff notes from the dashboard**: add a note (visible to staff only) to any open or closed ticket
  directly from the dashboard, not just via the `!note` chat prefix.
- **Anonymous mode**: an optional setting so users only ever see "Signature Support", never the individual
  staff member's tag, when someone replies.
- **L'IA Signature (optional)**: enable an AI first-line assistant on specific categories. When a ticket in
  that category is created, it introduces itself, reads the user's intake answers, and has a real
  conversation with them — grounded in whatever you teach it per category — before handing off to staff if
  needed. Free to run (Google Gemini's free tier). See "Enabling L'IA Signature" below.
- **Text transcript in the logs**: on top of the dashboard archive, closing a ticket also drops a full
  `.txt` transcript as a file attachment in `#modmail-logs`.
- **Styled messages, no accent bar**: every message the bot sends — the ticket card, DM confirmations,
  relayed messages between staff and user — is a real Discord **container** (Components V2), not a classic
  embed, and without the colored side-bar embeds have (so it never reads as "a fancy embed").
- **Rich transcripts**: the archived transcript for each closed ticket includes every real message
  (with attachments), internal notes, and system events (opened, redirected, claimed, closed, rated,
  commented) — the full staff-side history, not a summary.
- **No duplicate categories**: the bot always looks for an existing "Modmail Tickets" Discord category (and
  `#modmail-logs` channel) by name before creating a new one, so even if `data/config.json` gets reset it
  reuses what's already there instead of creating a second one.
  updates immediately to the new category's roles, the ticket is **automatically unclaimed**, and the user
  is prompted (in DM) to answer that new category's questionnaire if it has one.
- **Claim / unclaim**: staff can claim a ticket from a button so everyone knows who's handling it; clicking
  again unclaims it. Redirecting a ticket always unclaims it.
- **Auto-close on inactivity**: if staff have replied at least once (staff can take as long as they want
  before that first reply) and the ticket then goes quiet for 24h (configurable), the user gets a DM
  warning **and** a note is posted in the ticket channel so staff see it too; if they still don't respond
  within 1h (configurable) the ticket closes automatically.
- **Ratings**: right after a ticket closes, the user gets a DM asking them to rate the support 1–5 stars
  with an optional comment.
- **Log channel**: a `#modmail-logs` channel is created automatically and gets a line for every ticket
  opened, closed, redirected, claimed/unclaimed, and rated — so staff have a full history even after a
  ticket channel is deleted.
- **Staff ping**: every category can ping its own roles, plus you can set one extra role (e.g. "All Staff")
  in the dashboard that gets pinged on *every* new ticket regardless of category.
- Staff close the ticket with the **Close ticket** button or `/close`.
- Everything below is managed visually from a built-in **web dashboard** (password protected): categories,
  conditional questions, role mapping, all bot texts (EN/FR), auto-close timing, the staff-ping role,
  average rating, and the full transcript of every closed ticket (with a delete button to remove test
  entries).

## 1. Project layout

```
src/
  index.js            Entry point: starts the web server (dashboard + health check) and the bot
  bot.js              All Discord logic: DM flow, ticket creation, relay, redirect, rating, auto-close
  flow.js             The conditional question engine (text/choice questions, showIf branching)
  config.js           Reads/writes data/config.json (categories, questions, roles, texts, settings)
  store.js            Reads/writes data/tickets.json (open tickets: transcript, activity, staff flag)
  archive.js          Reads/writes data/archive.json (closed tickets: full transcript + rating)
  bans.js             Reads/writes data/bans.json (banned user IDs)
  ai.js               "L'IA Signature" - optional Gemini-powered first-line assistant
  persistence.js      Optional GitHub auto-commit of config.json
  upstash.js          Optional Upstash Redis sync (config/archive/bans survive redeploys)
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

### Persisting everything with Upstash (recommended)

`data/config.json`, `data/archive.json`, and `data/bans.json` live on Render's local disk, which is
**wiped on every new deploy** (and on free-plan sleep/wake cycles). Without any extra setup, that means
your categories, texts, settings, ratings/transcripts, and ban list would all reset on every redeploy.

**Upstash Redis fixes this automatically, for free, forever — no card required.** Every save (a category
edit, a new rating, a ban) is instantly mirrored to Redis; on startup, before anything else runs, the bot
pulls the latest saved version back down. You never have to think about it again.

1. Go to [console.upstash.com](https://console.upstash.com), sign up (GitHub/Google login works), and
   click **Create Database**. Any region close to your Render region is fine. The free plan (500,000
   commands/month, 256 MB) is far more than this bot will ever use.
2. On the database's page, find the **REST API** section and copy the `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` values.
3. On Render, add both as environment variables with those exact names. Redeploy.
4. That's it — no code change needed. Look for `Upstash persistence enabled — restoring saved data...` in
   the Render logs on the next boot to confirm it's working.

`data/tickets.json` (currently open tickets) is deliberately *not* synced this way — it changes on every
single message, and open tickets already have a more reliable recovery path: the bot rebuilds them straight
from the actual Discord channels on startup (see "Survives restarts" above), which is the real source of
truth anyway.

**Without Upstash configured**, two fallbacks remain available (categories/texts/settings only, not the
ratings archive or bans):
- **Manual backup** — in the dashboard's Paramètres tab, **📥 Exporter la config** downloads a JSON
  snapshot, **📤 Importer une config** restores one. Export before `git push`, import after the deploy.
- **GitHub auto-sync** — every dashboard save can be auto-committed to `data/config.json` in your repo, so
  the *next* deploy starts from your latest edits. Add `GITHUB_TOKEN` (a fine-grained personal access token
  with **Contents: Read and write** on this repo) and `GITHUB_REPO` (`your-username/your-repo-name`) as
  environment variables. ⚠️ If Render's "Auto-Deploy" is on, every commit this creates also triggers a
  redeploy — turn Auto-Deploy off and use **Manual Deploy** if that's disruptive. This is independent of
  Upstash; both can run at once if you want your config versioned in git *and* instantly restored.

## 6. Enabling L'IA Signature (Gemini)

This is entirely optional. Without a `GEMINI_API_KEY`, the bot behaves exactly as before — every ticket
goes straight to staff.

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey), sign in with a Google account,
   and click **Create API key**. No credit card needed for the free tier.
2. On Render, add an environment variable `GEMINI_API_KEY` with that key. Redeploy.
3. In the dashboard's **Catégories** tab, you'll see a note confirming the key was detected. For any
   category, tick **🤖 Activer L'IA Signature sur cette catégorie**, and fill in the **"Ce que l'IA doit
   savoir"** box with whatever's specific to that category — known causes, fixes, things to check first,
   in plain language. For example:
   > Si un produit ne marche pas, la cause n°1 est que les HTTP Requests ne sont pas activées dans les
   > paramètres du jeu, et que ça n'a pas été testé en dehors de Studio.
4. That's it. The next ticket opened in that category will be greeted by "L'IA Signature" / "Signature AI"
   instead of immediately pinging staff.

**How it behaves:**
- It already knows what the user answered in the intake questions — no need to repeat itself.
- It asks focused follow-up questions and offers solutions based on what you taught it.
- **Roblox Studio research**: if the question is specifically about Roblox Studio / development and neither
  its own knowledge nor what you taught it covers it, it searches the web (via Google Search grounding),
  prioritizing the Roblox Developer Forum and official Roblox docs, before answering — rather than guessing.
- **Always offers a human**: if the user asks to talk to a person at any point, the AI tells them that's no
  problem, pings the category's staff roles, and immediately hands the ticket off — it never keeps someone
  stuck. The same happens automatically if it's out of its depth, the topic is sensitive, the user is being
  abusive/trolling, or too many exchanges pass without progress (configurable — see "Échanges max avant
  escalade" in the dashboard).
- **Pings on resolution too**: if the AI believes it fully solved the issue, it stays available for
  follow-ups but also pings the category's staff roles with a "✅ resolved" note, so the team has
  visibility even when they were never actively needed.
- **Full staff visibility**: everything the user types is posted in the ticket channel in real time —
  exactly like a normal ticket — so staff can watch the AI's conversation live, not just see it after the
  fact in the transcript.
- **Manual takeover, either direction**: a staff member typing a normal message in the channel instantly
  and silently switches the ticket back to human mode. Conversely, a **"🤖 Recall L'IA Signature"** button
  appears on tickets in AI-enabled categories, letting staff bring the AI back in whenever they want.
- **Auto-redirect to the right category** (opt-in per category, tick **"🔀 Autoriser l'IA à rediriger
  automatiquement vers la bonne catégorie"**): if the ticket was opened under the wrong category — e.g. a
  player used "Other" but it's really a technical issue — the AI can send it straight to the right one
  itself. It tells the user warmly first, then the ticket is retitled/re-permissioned exactly like a staff
  redirect (and unclaimed). If the destination category also has AI enabled, the AI picks the conversation
  right back up there instead of making the user fill out the intake form again.
- Every AI message is clearly logged (🤖) in the transcript, right alongside user/staff messages, so nothing
  is hidden from the record.
- Model and escalation threshold are adjustable in the dashboard (**Catégories** tab, near the top); the
  default model is `gemini-3.6-flash`, well within Gemini's free tier for a support bot's volume.

**Limits worth knowing:** the free Gemini tier has a daily request cap that resets every 24h (currently
generous — see [ai.google.dev/pricing](https://ai.google.dev/pricing) for the exact current numbers, they
do change). Web search uses a couple of extra requests per lookup, so it draws down the quota a bit faster
than a plain reply. If the quota is ever exceeded, or the API has a hiccup, the bot fails safe: it pings
staff normally instead of leaving the user stuck. A ticket the AI fully resolves (user never replies again)
won't auto-close on its own the way staff-handled tickets do — just close it manually when you notice it's
done.

## 7. Managing everything from the dashboard

Open `/dashboard`, log in, and use the six tabs:

- **Paramètres** — support team name, anonymous replies toggle, the extra "ping all staff" role for new
  tickets, the bot's Discord status (activity type + text + online/idle/dnd), the auto-close timing, and
  the config export/import buttons.
- **Catégories** — for each category: emoji + English/French label, which roles can see its tickets, and
  its questions. A question is either a **text answer** or a **multiple choice** (which becomes a select
  menu). Any question can be set to "Afficher seulement si" (only show if) an *earlier* choice question in
  the same category was answered a specific way — this is what powers "Custom Services → which service? →
  a different follow-up question per answer". Questions are asked in the order they appear in the list.
- **Textes** — every bilingual message the bot sends during the ticket flow (welcome message, ticket
  created/closed DMs, inactivity warning, rating request, redirect notice, redirect follow-up prompt, the
  banned-user message, etc.), fully editable.
- **Tickets ouverts** — every currently open ticket, with its conversation so far. Click a row to expand it
  and add a staff-only note.
- **Avis & Transcripts** — average rating and total ratings at a glance, plus every closed ticket with its
  full conversation transcript (click a row to expand it — includes staff/user messages, internal notes,
  *and* system events like "ticket opened", "redirected", "claimed", "rated"), with the same ability to add
  a note. Each row has a 🗑️ button to permanently delete a test ticket/review.
- **Bannis** — add or remove a Discord user ID from the ban list. Banned users get a polite "you can't open
  a ticket" message instead of starting the intake flow.


Click **+ Nouvelle catégorie** to add something like "Custom Services" from scratch — it appears in the
Discord menu immediately (until the disk resets, see above).

## 8. Slash commands

- `/close` — closes the current ticket channel (must be run inside a ticket channel).
- `/ping` — quick check that the bot is online.

Staff can also use the **Close ticket**, **Redirect**, **Claim**/**Unclaim**, **Remind now**, and
**Ban user** buttons posted automatically at the top of every ticket channel. Redirect lets staff move a
ticket to a different category (e.g. a player opened "Other" but actually wants a custom order) — it
re-assigns which roles can see the channel to match the new category, unclaims the ticket, posts a notice
in the channel, and DMs the user to answer the new category's questions if it has any (their answers get
posted back into the same channel). **Remind now** immediately sends the inactivity warning (instead of
waiting for the 24h timer) and starts the 1h auto-close countdown. **Ban user** asks for confirmation, then
bans the user from opening future tickets and closes this one.

## 9. Notes on behavior

- Only DMs to the bot start the flow; messages in the server are ignored unless they're inside an active
  ticket channel (then they're relayed to the user).
- A staff message starting with `!` in a ticket channel is treated as an **internal note** and is *not*
  forwarded to the user, but is still saved in the transcript — handy for staff-only discussion.
- If the user's DMs are closed, staff get a warning in the ticket channel instead of a silent failure.
- **Auto-close**: the bot checks every 5 minutes. A ticket is only eligible once staff have sent at least
  one message in it (so tickets waiting on a first reply are never auto-closed). Any new message from
  either side resets the inactivity clock and cancels a pending warning. The warning DM to the user is
  mirrored as a note in the ticket channel and in `#modmail-logs`.
- **Ratings**: sent as a DM right after closing, with 1–5 star buttons and an optional comment via a small
  follow-up form. Entirely optional for the user — ignoring the message just leaves no rating.
- **Claim**: any staff member who can see the ticket can claim it; if someone else already claimed it,
  clicking Claim just tells you who has it rather than stealing it. Redirecting a ticket always clears the
  claim, since it's likely going to a different team.
- **Restart**: while answering the intake questions (before the ticket is created), the user can tap
  "🔄 Restart" on any step, or just type "restart" / "recommencer" / "annuler" / "cancel", to forget
  everything they've entered so far and begin again from the language choice. This has no effect once a
  ticket already exists — it only resets the pre-ticket questionnaire.
- **Ticket recovery**: on startup, the bot cross-checks its saved ticket list against the actual channels
  in the "Modmail Tickets" category. Channels that were deleted while it was offline get forgotten; ticket
  channels it doesn't remember (e.g. after `tickets.json` was reset by a redeploy) get rebuilt from the
  channel's topic and up to its last 100 messages, so replying, closing, and claiming keep working without
  needing to recreate the ticket.
- **`#modmail-logs`**: auto-created inside the "Modmail Tickets" category the first time it's needed. By
  default only the bot (and the "ping all staff" role, if you set one) can see it — adjust its permissions
  manually in Discord if you want more people to have access.
