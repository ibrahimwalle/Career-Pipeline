# Career Pipeline

Automated job search pipeline — find, score, tailor, auto-apply, and track applications across permanent and contract roles.

**Everything runs from the dashboard.** No scripts to remember.

## Quickstart

```bash
npm install
npm run dev
```

Open **http://localhost:3456** — all actions are buttons in the sidebar. Nodemon auto-restarts on file changes.

## What it does

```
Find Jobs → Score → Apply → Inbox → Track Replies → Daily Actions
```

- **Find** — 13 verified companies (ATS APIs) + LinkedIn + Himalayas + SmartRecruiters + Remotive + Bayt.com MENA
- **Score** — Instant keyword-based Quick Score on all jobs, Claude deep-scoring per-job
- **Inbox** — Gmail IMAP scanner detects application confirmations, interview invites, rejections. Auto-updates pipeline statuses. Never marks emails as read.
- **Auto-Apply** — Playwright fills ATS forms (Greenhouse, Lever, Ashby). LinkedIn via plugin.
- **Daily Actions** — Prioritized list: apply now, follow up, reply, close stale
- **Strict Filter** — 56 excluded industries (banking, insurance, gambling, alcohol, etc.)

## Scoring

| | Quick Score | Claude Score |
|---|---|---|
| Speed | Under 1s | 30-90s per job |
| Cost | Free | Claude subscription |
| Trigger | "Score All" button | Per-job "Score" link |
| Method | Keyword + heuristic match | AI reads your full profile |

**Default:** Quick Score everything instantly, then Claude-score only top matches.

## Setup

1. Copy `profile/auto_apply_profile.example.json` → `profile/auto_apply_profile.json` and fill in your details
2. Copy `email_config.example.json` → `email_config.json` with a Gmail app password (optional — for inbox)
3. Edit `companies.json` to add/remove companies
4. Edit `scrape_config.json` to customize roles, locations, strict filter
5. Run `npm run dev` and click buttons

## Dashboard Features

- **Morning Routine** — one click: scrape all sources → score → inbox → daily actions
- **Find Jobs** — chains ATS + LinkedIn + Himalayas (3 steps with live progress)
- **Score All** — instant keyword scoring on every job
- **Check Inbox** — modal popup with labeled emails (✅ confirmed, ❌ rejected, 🎙️ interview, 🏆 offer)
- **Daily Actions** — inline panel with priority-sorted tasks
- **Upload to Agencies** — 11 UK contractor agencies checklist
- **Status dropdown** — inline per-job status changes
- **Clickable filters** — click company/location/stat to filter
- **Age filter** — 7/14/30 day freshness
- **Location filter** — UK/Europe/Gulf/Lebanon/Remote
- **Cancel jobs** — ✕ button on every running job
- **Desktop notifications** — on job completion

## Sources (10)

| Source | Method | Region |
|---|---|---|
| Greenhouse / Lever / Ashby | Public APIs | 13 verified companies |
| LinkedIn | Playwright (persistent browser) | Global |
| Himalayas | Free public API | UK/Europe/Gulf/Lebanon |
| SmartRecruiters | Partner API | 11 companies |
| Remotive + Arbeitnow | Free JSON APIs | Global remote |
| Bayt.com | Playwright | 7 Gulf countries + Lebanon |
| DevITjobs UK | XML feed | UK contracts |
| Hacker News | Algolia API | Freelance threads |

## Requires

- Node.js ≥22
- Python 3 (inbox scanner — built-in `imaplib`)
- Claude Code CLI (optional — for per-job deep scoring)
- Playwright Chromium (for LinkedIn + Bayt + auto-apply)
- Gmail app password (optional — for inbox + email sending)
