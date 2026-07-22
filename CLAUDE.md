# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Job search automation pipeline for permanent and contract roles. **The dashboard is the interface** — all scraping, scoring, tailoring, inbox scanning, and daily actions run through the web UI at `http://localhost:3456`. Scripts are backend workers the dashboard spawns via `spawn()`.

## The user runs ONE command

```bash
npm run dev    # http://localhost:3456 — hot reload via nodemon
```

Everything is buttons. Morning Routine chains all sources → score → inbox → actions.

## Pipeline architecture

| | Permanent | Contract |
|---|---|---|
| Job store | `data/jobs.json` | `data/contract_jobs.json` |
| Sources | Greenhouse, Lever, Ashby, LinkedIn, SmartRecruiters, Remotive, Arbeitnow, Himalayas, Bayt.com | DevITjobs UK, RemoteOK, WeWorkRemotely, LinkedIn Contract, Hacker News |
| Scorer | `score.js` | `contract_score.js` |
| Tailor | `tailor.js` (cover letter + CV) | `contract_tailor.js` (pitch + rate justification) |
| Verdicts | STRONG_MATCH / GOOD_FIT / REACH / SKIP | BID / APPLY / REACH / SKIP |
| Profile | `profile/master_doc.md` + `profile/cv.md` | `profile/contract_profile.json` + `profile/contract_cv.md` |
| Auto-apply | `auto_apply.js` (Playwright) + LinkedIn via `job-apply-plugin` | Manual (paste pitch into platform) |

**Status flow:** `new` → `scored` → `applied`/`bid` → `screening`/`client_call` → `interviewing` → `offer`/`won` / `rejected`/`lost`

Every job object: `id` (prefixed by source), `source`, `company`, `title`, `location`, `url`, `description`, `status`, `score`, `verdict`, `relevance` (pre-rank), `scoring` (nested: strengths, gaps, reasoning, rate_fit, ir35_note).

## Pre-rank system (shared.js)

Before Claude scores, every scraper computes a `relevance` score (0-100) based on:
- Role keyword hits (+0 to +25)
- Title quality: senior/lead +15, junior-adjacent -5
- Location tier: UK +15, Lebanon +14, Europe +12, Gulf +10, remote +5
- Freshness: <7 days +10, <14 days +5, >30 days -5
- Company stage: startups +8, scaleups +5, big tech +2
- Preferred sector match +5

Jobs are sorted by relevance before Claude scoring. The dashboard sorts by `score || relevance` so unscored jobs still appear ranked.

## All scrapers

| File | Sources | Method | Notes |
|---|---|---|---|
| `find.js` | 51 companies (Greenhouse/Lever/Ashby) | HTTP to public APIs | 10 jobs/company cap, newest first |
| `linkedin_find.js` | LinkedIn Jobs | Playwright, persistent profile `data/linkedin_profile/` | `isInteractive()` guard prevents stdin hang when spawned from dashboard |
| `himalayas_find.js` | Himalayas.app | Free public API | 40 queries, 4 parallel batches |
| `smartrecruiters_find.js` | 11 companies (SmartRecruiters API) | HTTP to partner API | |
| `remotive_find.js` | Remotive + Arbeitnow | Free JSON APIs | |
| `bayt_find.js` | Bayt.com (MENA #1 board) | Playwright, same persistent profile | 7 Gulf countries + Lebanon |
| `contract_find.js` | RemoteOK, WeWorkRemotely | HTTP (JSON, RSS) | |
| `devitjobs_find.js` | DevITjobs UK | XML feed | 409 UK contract jobs |
| `linkedin_contract_find.js` | LinkedIn contract jobs | Playwright | |
| `hn_contract_find.js` | Hacker News freelancer threads | Algolia API | |

All scrapers import from `shared.js` (`computeRelevance`, `loadScrapeConfig`, `DAY_MS`). All apply filters from `scrape_config.json`: role_keywords, exclude_roles, locations, remote_preference, max_job_age_days, max_jobs_per_company, strict_filter.

## Claude Code integration

All LLM scripts use `spawnSync` (not `execSync` — crashes on timeouts):

```js
const result = spawnSync('claude', ['--print', '--output-format', 'text', '--dangerously-skip-permissions'], {
  cwd: ROOT, timeout: 120000, maxBuffer: 4*1024*1024, encoding: 'utf-8',
  input: readFileSync(promptFile, 'utf-8'),
});
```

Score timeout: 120s. Tailor timeout: 120s. Crash log: `crash.log` (gitignored).

## Inbox scanner (inbox.py)

Python + built-in `imaplib`/`email`. Gmail IMAP. Keyword classification. Auto-updates job statuses. `--json` flag saves structured results to `data/inbox_results.json`. Needs `PYTHONIOENCODING=utf-8` on Windows.

## Web dashboard (dashboard.js + dashboard.html)

Pure Node.js HTTP on port 3456. Self-contained SPA.

**Sidebar features:**
- Morning Routine (ATS → LinkedIn → score 20 → inbox → actions)
- Find Jobs (chains ATS → LinkedIn → Himalayas, 3 steps with live progress)
- Find Jobs (LinkedIn) — standalone
- Find Jobs (MENA) — Bayt.com Playwright
- Score N (adjustable count)
- Check Inbox (Gmail scan with results panel)
- Daily Action List (inline panel, priority-sorted)
- Upload to Agencies (11 UK contractor agencies checklist)
- Recent Events log + desktop notifications
- Strict filter status indicator
- Cancel running jobs (✕) + Cancel all

**Key APIs:** `/api/jobs`, `/api/stats`, `/api/running` (live log), `/api/actions` (JSON), `/api/config`, `/api/action/*`

## Configuration files

- `companies.json` — 51 permanent sources: `{source, slug, name}`
- `scrape_config.json` — 47 role keywords, 54 excluded roles, ~100 locations (UK/Europe/Gulf/Lebanon), strict_filter with 56 excluded industries, freshness, caps
- `rules.json` — inbox rules, auto-send threshold (STRONG_MATCH), auto-update
- `email_config.json` — Gmail SMTP/IMAP credentials (gitignored)

## Sensitive data (gitignored)

`profile/`, `data/`, `output/`, `crash.log`, `email_config.json`, `data/linkedin_profile/`
