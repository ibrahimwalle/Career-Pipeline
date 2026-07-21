# Job Pipeline

Automated job search pipeline — find, score, tailor, auto-apply, and track applications across permanent and contract roles.

**Everything runs from the dashboard.** No scripts to remember.

## Quickstart

```bash
npm install
node src/dashboard.js
```

Open **http://localhost:3456** — all actions are buttons in the sidebar.

## What it does

```
Find Jobs → Score with AI → Tailor Materials → Auto-Apply → Track Replies → Daily Actions
```

- **Find** — 29 companies via ATS APIs (Greenhouse, Lever, Ashby) + LinkedIn + contract platforms
- **Score** — Claude reads your profile, scores each job 0-100 with reasoning
- **Tailor** — Generates cover letters, CV summaries, contract pitches, talking points
- **Auto-Apply** — Playwright fills ATS forms (Greenhouse, Lever, Ashby). LinkedIn via plugin.
- **Inbox** — Gmail IMAP scanner detects recruiter replies, auto-updates statuses
- **Daily Actions** — Prioritized list: apply now, follow up, reply, close stale

## Setup

1. **Profile** — copy `profile/*.example.*` to `profile/*` and fill in your details
2. **Email** (optional) — copy `email_config.example.json` to `email_config.json` with a Gmail app password
3. **Companies** — edit `companies.json` to add/remove companies
4. **Filters** — edit `scrape_config.json` to customize what roles and locations to target
5. Run `node src/dashboard.js` and click buttons

## Perm vs Contract

| | Permanent | Contract |
|---|---|---|
| Sources | Greenhouse, Lever, Ashby, LinkedIn | RemoteOK, WeWorkRemotely |
| Verdicts | STRONG_MATCH / GOOD_FIT / REACH / SKIP | BID / APPLY / REACH / SKIP |
| Materials | Cover letter + CV summary | Short pitch + delivery evidence + rate justification |
| Profile | Full career doc | Rates, availability, IR35 |

## Files

```
src/
  dashboard.js + dashboard.html  — Web UI (the main interface)
  find.js                         — ATS scraper (Greenhouse, Lever, Ashby)
  linkedin_find.js                — LinkedIn scraper (Playwright)
  contract_find.js                — Contract platform scraper
  score.js / contract_score.js    — Claude scoring (reads your profile)
  tailor.js / contract_tailor.js  — Materials generation
  auto_apply.js                   — Playwright form filler
  email.js                        — SMTP sender + inbox scan orchestrator
  inbox.py                        — Gmail IMAP inbox scanner
  actions.js                      — Daily prioritized action list
  app.js                          — Terminal TUI (experimental)
  status.js / contract_status.js  — Terminal dashboards
profile/                          — Your data (gitignored, copy .example files)
companies.json                    — Companies to search
scrape_config.json                — Role/location/salary filters
rules.json                        — Inbox + send rules
```

## Requires

- Node.js ≥22
- Python 3 (for inbox scanner — built-in `imaplib`, zero pip installs)
- Claude Code CLI (`claude`) — for scoring and tailoring (uses your subscription, no API key)
- Playwright Chromium (auto-installed via `npx playwright install chromium`) — for LinkedIn + auto-apply
- Gmail app password (optional — for inbox scanning + email sending)
