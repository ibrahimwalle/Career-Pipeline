# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Job search automation pipeline covering permanent and contract roles. **The dashboard is the interface** — all scraping, scoring, tailoring, applying, and inbox scanning runs through the web UI at `http://localhost:3456`. Scripts are backend workers the dashboard spawns.

Two parallel pipelines sharing the same dashboard:

| | Permanent | Contract |
|---|---|---|
| Job store | `data/jobs.json` | `data/contract_jobs.json` |
| Sources | Greenhouse, Lever, Ashby, LinkedIn | RemoteOK, WeWorkRemotely |
| Scorer | `score.js` | `contract_score.js` |
| Tailor | `tailor.js` (cover letter + CV) | `contract_tailor.js` (pitch + rate justification) |
| Verdicts | STRONG_MATCH / GOOD_FIT / REACH / SKIP | BID / APPLY / REACH / SKIP |
| Profile | `profile/master_doc.md` + `profile/cv.md` | `profile/contract_profile.json` + `profile/contract_cv.md` |
| Auto-apply | `auto_apply.js` (Playwright) + LinkedIn via `job-apply-plugin` | Manual (paste pitch into platform) |

Contract rates are set competitively for first-time contracting: £250-350/day (below market to land first gig). Profile files are gitignored — copy `.example` files to set up.

## The user runs ONE command

```bash
node src/dashboard.js    # http://localhost:3456
```

Everything else is buttons in the sidebar: Find Jobs (ATS), Find Jobs (LinkedIn), Score, Check Inbox, Full Workflow, Daily Actions, Auto-Apply.

## Architecture

### Data contract (jobs.json / contract_jobs.json)

Every job: `id`, `source`, `company`, `title`, `location`, `url`, `description`, `status`, `score`, `verdict`, `scoring` (nested: strengths, gaps, reasoning). Contract jobs add `rate` and `scoring.rate_fit`, `scoring.ir35_note`.

**Status flow:** `new` → `scored` → `applied`/`bid` → `screening`/`client_call` → `interviewing` → `offer`/`won` / `rejected`/`lost`

### ATS sources (find.js)

- Greenhouse: `boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true`
- Lever: `api.lever.co/v0/postings/<slug>?mode=json`
- Ashby: `api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true`

### LinkedIn (linkedin_find.js)

Playwright with persistent browser profile at `data/linkedin_profile/`. Searches with `f_WT=2` (Remote), `f_TPR=r2592000` (past 30 days). Uses resilient selectors with 4-7 fallbacks per field. Respects `scrape_config.json` filters.

### Contract sources (contract_find.js)

RemoteOK free JSON API, WeWorkRemotely RSS. Other sources (Arc.dev, WorkingNomads, Contra) have broken APIs — update endpoints if resurrecting.

### Claude Code integration (score.js, tailor.js, etc.)

All LLM scripts: write prompt → `claude --print --output-format text --dangerously-skip-permissions -p "$(cat file)"` via execSync → parse JSON from response. Score timeout: 60s. Tailor timeout: 120s. Uses user's Claude subscription, not API key.

### Web dashboard (dashboard.js + dashboard.html)

Pure Node.js HTTP on port 3456. Self-contained SPA (inline CSS/JS). Sidebar action buttons trigger `/api/action/*` endpoints which spawn scripts as child processes. Running jobs tracked in-memory with live log streaming. Client polls `/api/running` every 3s for progress.

### Auto-apply (auto_apply.js)

Playwright headful browser. Detects ATS (Greenhouse/Lever/Ashby), fills standard fields, uploads CV, pastes cover letter. Does NOT submit — leaves browser open for review. LinkedIn jobs use the installed `job-apply@neonwatty-plugins` Claude Code plugin instead.

### Inbox scanner (inbox.py)

Python + built-in `imaplib`/`email` — zero pip installs. Gmail IMAP. Keyword classification. Pipeline-only filter per rules.json. Auto-updates job statuses. Needs `PYTHONIOENCODING=utf-8` on Windows.

### Daily actions (actions.js)

Combines: old high-score jobs → follow-ups needed → stale applications → inbox replies → fresh strong matches. Returns prioritized list with suggested actions.

## Configuration files

- `companies.json` — permanent sources: `{source, slug, name}`. Greenhouse/Lever/Ashby only.
- `scrape_config.json` — role keywords, exclusions, locations, remote preferences. The user edits this to tune what jobs appear.
- `rules.json` — inbox read/write rules, send thresholds, auto-update. Inline `_note` fields explain each setting.
- `email_config.json` — Gmail SMTP + IMAP credentials. Gitignored. Template: `email_config.example.json`.
- `profile/` directory — all gitignored. Users copy `.example` files on setup.

## Profile files (all gitignored)

- `profile/master_doc.md` — full career document (Part A: experience, Part B: interview stories)
- `profile/cv.md` — base CV text
- `profile/contract_profile.json` — rates (£250-350/day), availability, IR35, contract prefs
- `profile/contract_cv.md` — delivery-focused contract CV

## Adding companies or sources

Permanent: find ATS slug from careers page URL, add to `companies.json`, click "Find Jobs (ATS)" in dashboard.

Contract: add fetcher function in `contract_find.js` following existing pattern.

## Sensitive data

All personal data is gitignored: `profile/`, `data/`, `output/`, `email_config.json`. The repo is safe to publish on GitHub.
