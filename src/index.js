require('dotenv').config();

const express = require('express');
const session = require('express-session');

const { createBotClient } = require('./bot');
const dashboardRouter = require('./dashboard/server');
const { hydrateConfig } = require('./config');
const { hydrateArchive } = require('./archive');
const { hydrateBans } = require('./bans');
const upstash = require('./upstash');

const REQUIRED_ENV = ['DISCORD_TOKEN', 'GUILD_ID', 'DASHBOARD_PASSWORD', 'SESSION_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env (or set them in your Render dashboard) and fill them in.');
  process.exit(1);
}

async function main() {
  // Restore config/archive/bans from Upstash (if configured) BEFORE anything
  // else in the app reads the local data/*.json files - this is what makes
  // settings and reviews survive a redeploy on Render's ephemeral disk.
  if (upstash.isEnabled()) {
    console.log('Upstash persistence enabled — restoring saved data...');
    await Promise.all([hydrateConfig(), hydrateArchive(), hydrateBans()]);
  }

  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 1000 * 60 * 60 * 12 }, // 12h
    }),
  );

  // Render (and uptime pingers) hit this to confirm the service is alive.
  app.get('/', (req, res) => res.send('Signature Modmail Bot is running. Visit /dashboard to manage categories.'));

  const client = createBotClient();

  app.use('/', dashboardRouter(client));

  app.listen(PORT, () => {
    console.log(`Web server (health check + dashboard) listening on port ${PORT}`);
  });

  client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error('Failed to log in to Discord — check that DISCORD_TOKEN is correct.', err.message || err);
    console.error('The web server / dashboard will keep running so you can inspect logs on Render.');
  });
}

main();
