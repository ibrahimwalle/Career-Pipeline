# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Job search automation pipeline for permanent and contract roles. **The dashboard is the interface** — all scraping, scoring, tailoring, inbox scanning, and daily actions run through the web UI at `http://localhost:3456`. Scripts are backend workers the dashboard spawns.

## The user runs ONE command

```bash
npm run dev    # http://localhost:3456 — hot reload via nodemon
```

Everything is buttons. **Morning Routine** chains: ATS scrape → LinkedIn → Himalayas → quick-score → inbox scan → daily actions.

## Two scoring systems

| | Quick Score (`quick_score.js`) | Claude Score (`score.js`) |
|---|---|---|
| Speed | Under 1s for all jobs | ~30-90s per job |
| Method | Keyword match + heuristic | Claude reads profile/master_doc.md |
| Model | No API | `--model claude-sonnet-5` |
| Trigger | "Score All" button | Per-job "Score" link in table |
| Verdict thresholds | ≥70 STRONG_MATCH, ≥50 GOOD_FIT, <30 SKIP | ≥80 STRONG_MATCH, ≥60 GOOD_FIT |

**Default flow:** Quick Score everything instantly, then Claude-score only top matches per-job.

## Pipeline architecture

| | Permanent | Contract |
|---|---|---|
| Job store | `data/jobs.json` | `data/contract_jobs.json` |
| Sources | 13 verified companies (Greenhouse, Lever, Ashby) + LinkedIn + Himalayas | DevITjobs UK, RemoteOK, WeWorkRemotely |
| Default scorer | `quick_score.js` (instant keyword) | same |
| Claude scorer | `score.js` (per-job only) | `contract_score.js` |
| Verdicts | STRONG_MATCH / GOOD_FIT / REACH / SKIP | BID / APPLY / REACH / SKIP |
| Profile | `profile/auto_apply_profile.json` — name, email, phone, CV path, title, company | `profile/contract_profile.json` |

**Status flow:** `new` → `scored` → `applied` → `screening` → `interviewing` → `offer` / `rejected`

Status auto-updated by inbox scanner when confirmation/rejection/interview emails detected.

## Pre-rank + Quick Score (shared.js + quick_score.js)

Every scraper computes `relevance` before scoring. The dashboard sorts by `score || relevance`.

**Relevance factors:** Role keyword hits, title quality, location tier (UK+15, Lebanon+14, Europe+12, Gulf+8, remote+3), freshness, company stage (startups+8, scaleups+5, big tech+2), preferred sector match.

**Quick Score factors:** Skill matches (capped +25), title fit (-10 for staff/principal), location tier, experience level mismatch (-8 for staff, -4 for 8+YOE), language barriers (-12 for German/Italian fluency), gap penalties (-12 max), freshness, company stage.

## All scrapers (10 sources)

| File | Sources | Method |
|---|---|---|
| `find.js` | 13 verified companies (Greenhouse/Lever/Ashby) | HTTP to public APIs |
| `linkedin_find.js` | LinkedIn Jobs | Playwright, persistent profile `data/linkedin_profile/` |
| `himalayas_find.js` | Himalayas.app | Free public API, 40 queries, 4 parallel batches |
| `smartrecruiters_find.js` | 11 companies | SmartRecruiters partner API |
| `remotive_find.js` | Remotive + Arbeitnow | Free JSON APIs |
| `bayt_find.js` | Bayt.com (MENA) | Playwright, 7 Gulf countries + Lebanon |
| `contract_find.js` | RemoteOK, WeWorkRemotely | HTTP (JSON, RSS) |
| `devitjobs_find.js` | DevITjobs UK | XML feed |
| `linkedin_contract_find.js` | LinkedIn contract jobs | Playwright |
| `hn_contract_find.js` | Hacker News freelancer threads | Algolia API |

All import from `shared.js`. All apply filters from `scrape_config.json`. Excludes match against job **titles only** (not descriptions). Remote jobs bypass location exclusions. 10 newest jobs per company.

## Auto-cleanup

On dashboard startup and after each ATS scrape: jobs older than 30 days are deleted UNLESS status is applied/screening/interviewing/offer. Applied jobs never expire.

## Claude Code integration

Uses `spawn` (not `execSync` — crashes on timeouts). All calls use `--model claude-sonnet-5` via stdin piping:

```js
const child = spawn('claude', ['--model', 'claude-sonnet-5', '--print', '--output-format', 'text', '--dangerously-skip-permissions'], {
  cwd: ROOT, timeout: 180000, input: readFileSync(promptFile, 'utf-8'),
});
```

Score timeout: 120s concurrent batches of 5. Tailor timeout: 120s. Crash log: `crash.log` (gitignored).

## Inbox scanner (inbox.py)

Python + built-in `imaplib`/`email`. Gmail IMAP. `BODY.PEEK[]` — never marks emails as read.

**Classification order:** application_confirmed → offer → rejected → interviewing → screening → recruiter_outreach. Application confirmations checked BEFORE rejections to avoid false negatives.

**Spam filter:** Shopping, newsletters, job digests, cord.co, Indeed InMail, account creation emails — all filtered before classification.

**Title-based matching:** When multiple jobs exist at same company (e.g., 10+ Stripe roles), matches email body text against pipeline job titles using word boundaries.

**Auto-update:** application_confirmed → status `applied`, interviewing → `interviewing`, rejected → `rejected`.

**CLI:** `python src/inbox.py 7 --json`

## Web dashboard (dashboard.js + dashboard.html)

Pure Node.js HTTP port 3456. Self-contained SPA. Nodemon auto-restart.

**Sidebar:** Morning Routine, Find Jobs (ATS+LinkedIn+Himalayas chain), Find Jobs (LinkedIn), Find Contract Jobs, Score All (quick score), Check Inbox (modal popup), Daily Action List, Upload to Agencies (11 UK agencies checklist). Running jobs with live progress, cancel button, log popup on click. Recent Events log. Strict filter indicator.

**Filter bar:** Status buttons (All/Scored/Applied/Active), Verdict dropdown, Location dropdown (UK/Europe/Gulf/Lebanon/Remote), Age dropdown (7/14/30 days), Search box (matches title+company+location+description).

**Click-to-filter:** Company names and locations in the table are clickable — puts text in search box. Stats boxes click to filter by status.

**Status dropdown:** Every job row has an inline status selector (New → Applied → Screening → Interviewing → Offer → Rejected). Changes save instantly.

**Key APIs:** `/api/jobs`, `/api/contract-jobs`, `/api/stats`, `/api/running` (live log streaming, step tracking), `/api/actions` (JSON), `/api/config`, `/api/action/*` (scrape, score, quick-score, inbox, cancel, status, morning, auto-apply), `/api/inbox-results`

## Configuration files

- `companies.json` — 13 verified permanent sources: `{source, slug, name}`
- `scrape_config.json` — 59 role keywords, 50 excluded roles, ~100 locations, strict_filter (56 excluded industries), freshness (30 days), per-company cap (10)
- `rules.json` — inbox read/write rules, auto-send threshold, auto-update
- `email_config.json` — Gmail SMTP/IMAP credentials (gitignored)

## Sensitive data (gitignored)

`profile/`, `data/`, `output/`, `crash.log`, `email_config.json`, `data/linkedin_profile/`
