# Money Bansho

An open-source dashboard for markets, companies and global events, built on free public data sources.

## What is in it

- **Dashboard**: market, macro, commodity, news and map panels.
- **Company Dossier** (`/dossier.html`): price history, dated company events, the price move around each event and a simple reputation score for a selected listed company. No account or API key is required. When a source fails, the page shows that there is no data.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000` (set `DEV_PORT` to change the port). The dossier is at `http://localhost:3000/dossier.html`.

## Build

```bash
npm run build:deploy
```

Some dashboard panels inherited from the upstream project depend on its hosted services or on your own API keys (see `.env.example`). Without them they show no data or stay locked.

Automated summaries and scores can be wrong. Nothing here is investment advice.

## Origin and licence

Money Bansho is based on [World Monitor](https://github.com/koala73/worldmonitor), Copyright (C) 2026 Elie Habib. It is an independent modified version and is not affiliated with or endorsed by the upstream project.

Licensed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). If you run a modified version as a network service, the licence requires you to offer its source to the users of that service.

Source: https://github.com/fckmeaning/Money-Bansho
