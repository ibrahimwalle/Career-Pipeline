// linkedin_find.js — Search LinkedIn for jobs using Playwright
// Uses persistent browser context to maintain login session.
// Scrapes LinkedIn Jobs search results and adds to data/jobs.json.
//
// Usage:
//   node src/linkedin_find.js [search_terms]
//   node src/linkedin_find.js "software engineer OR backend engineer"
//
// The browser opens visibly — log in once, cookies persist in data/linkedin_profile/

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeRelevance, loadScrapeConfig, DAY_MS } from './shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');
const PROFILE_DIR = resolve(DATA_DIR, 'linkedin_profile');
const CONFIG_PATH = resolve(ROOT, 'scrape_config.json');

// ─── Config Loading ────────────────────────────────────────────

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return {
      role_keywords: ['software engineer', 'backend engineer', 'full stack', 'ai engineer', 'ml engineer', 'platform engineer', 'cloud engineer', 'data engineer', 'systems engineer', 'api engineer', 'integrations engineer', 'forward deployed engineer', 'project manager'],
      exclude_roles: ['intern', 'graduate', 'entry level', 'apprentice', 'vp of', 'director', 'head of engineering', 'engineering manager', 'mobile engineer', 'ios', 'android', 'embedded', 'firmware', 'qa engineer', 'test engineer'],
      remote_preference: { remote_only: true, hybrid_ok: true, hybrid_locations: ['london', 'united kingdom', 'uk'], exclude_onsite: false },
      locations: { include: ['remote', 'london', 'united kingdom', 'uk', 'europe', 'anywhere', 'distributed', 'MENA', 'spain', 'madrid',], exclude: [] },
      max_jobs_per_company: null,
    };
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

// ─── Helpers ───────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function randomDelay() {
  return sleep(randomBetween(2000, 4000));
}

function extractLinkedInJobId(url) {
  // Extract numeric job ID from LinkedIn URL like:
  // https://www.linkedin.com/jobs/view/1234567890/
  // or from /jobs/collections/recommended/?currentJobId=1234567890
  const m1 = url.match(/\/jobs\/view\/(\d+)/);
  if (m1) return m1[1];
  const m2 = url.match(/currentJobId=(\d+)/);
  if (m2) return m2[1];
  return null;
}

// ─── Location Matching ─────────────────────────────────────────

const TARGET_LOCATION_PATTERNS = [
  // United Kingdom
  'united kingdom', 'uk', 'london', 'england', 'manchester', 'birmingham',
  'edinburgh', 'glasgow', 'bristol', 'cambridge', 'oxford', 'leeds',
  // United Arab Emirates
  'united arab emirates', 'uae', 'dubai', 'abu dhabi', 'sharjah',
  // Saudi Arabia
  'saudi arabia', 'saudi', 'riyadh', 'jeddah', 'dammam',
  // Qatar
  'qatar', 'doha',
  // Kuwait
  'kuwait',
  // Bahrain
  'bahrain', 'manama',
  // Oman
  'oman', 'muscat',
  // Lebanon
  'lebanon', 'beirut',
  // Remote
  'remote', 'anywhere', 'distributed', 'work from home', 'wfh',
  //Spain
  'spain', 'madrid', 'barcelona', 'valencia', 'sevilla', 'bilbao', 'malaga',
];

function locationMatchesTarget(locationText) {
  if (!locationText) return false;
  const lower = locationText.toLowerCase();
  return TARGET_LOCATION_PATTERNS.some(loc => lower.includes(loc));
}

// ─── Role Filtering (matches find.js logic) ────────────────────

function isEngineeringRole(title, company, description, config) {
  // Combine all searchable text
  const text = `${title} ${company} ${description || ''}`.toLowerCase();
  const keywords = config.role_keywords || [];
  const excludes = config.exclude_roles || [];

  // Reject if any exclude keyword matches
  if (excludes.some(kw => text.includes(kw))) return false;

  // Accept if any role keyword matches
  return keywords.some(kw => text.includes(kw));
}

function isMidOrSenior(title) {
  const t = title.toLowerCase();
  const juniorTerms = ['junior', 'intern', 'graduate', 'entry level', 'entry-level', 'apprentice'];
  if (juniorTerms.some(kw => t.includes(kw))) return false;
  const leadershipTerms = ['vp of', 'vice president', 'chief ', 'director of engineering', 'head of engineering', 'senior manager', 'principal architect'];
  if (leadershipTerms.some(kw => t.includes(kw))) return false;
  return true;
}

// ─── LinkedIn URL Builder ──────────────────────────────────────

function buildSearchUrl(searchTerms) {
  const keywords = encodeURIComponent(searchTerms);
  // f_WT=2      → Remote
  // f_TPR=r604800 → Past week (604,800 seconds)
  // f_AL=true   → Easy Apply
  // sortBy=R    → Most recent first
  // refresh=true → Force fresh search (bypass cache)
  return (
    'https://www.linkedin.com/jobs/search/?' +
    `keywords=${keywords}` +
    `&f_WT=2` +
    `&f_TPR=r604800` +
    `&f_AL=true` +
    `&sortBy=R` +
    `&refresh=true` +
    `&origin=JOB_SEARCH_PAGE_JOB_FILTER`
  );
}

// ─── Login / Verification Check ───────────────────────────────

async function ensureLoggedIn(page, context) {
  // Give the page a moment to settle (redirects, JS hydration)
  await sleep(3000);

  const currentUrl = page.url();

  // Check for login wall
  const isOnLoginPage = currentUrl.includes('/login') ||
    currentUrl.includes('/checkpoint') ||
    currentUrl.includes('/auth');

  if (isOnLoginPage) {
    console.log('\n  ╔══════════════════════════════════════════╗');
    console.log('  ║  NOT LOGGED IN TO LINKEDIN              ║');
    console.log('  ║  A browser window should be open.        ║');
    console.log('  ║  Please log in manually, then press     ║');
    console.log('  ║  Enter here to continue...              ║');
    console.log('  ╚══════════════════════════════════════════╝\n');
    await waitForEnter();
    return false; // caller should re-navigate
  }

  // Also check for embedded sign-in form on the page
  const hasAuthWall = await page.evaluate(() => {
    const bodyText = (document.body.textContent || '').toLowerCase();
    // Strong signal: the "Welcome to your professional community" login hero
    if (bodyText.includes('welcome to your professional community') &&
        bodyText.includes('sign in')) {
      return true;
    }
    // Check for sign-in form elements
    const authForms = document.querySelectorAll(
      'form[action*="login"], .sign-in-form-container, .sign-in-form, ' +
      '.authwall-sign-in-form, [data-test-login]'
    );
    return authForms.length > 0;
  });

  if (hasAuthWall) {
    console.log('\n  ╔══════════════════════════════════════════╗');
    console.log('  ║  LINKEDIN LOGIN REQUIRED                ║');
    console.log('  ║  Please sign in to your LinkedIn account ║');
    console.log('  ║  in the open browser window.            ║');
    console.log('  ║  Press Enter when done to continue...   ║');
    console.log('  ╚══════════════════════════════════════════╝\n');
    await waitForEnter();
    return false;
  }

  return true;
}

async function checkVerificationWall(page) {
  const bodyText = await page.evaluate(() =>
    (document.body.textContent || '').toLowerCase()
  );

  const blocked =
    bodyText.includes('unusual activity') ||
    bodyText.includes('security verification') ||
    bodyText.includes("verify you're a real person") ||
    bodyText.includes('we noticed unusual activity') ||
    bodyText.includes("let's do a quick security check");

  if (blocked) {
    console.log('\n  ╔══════════════════════════════════════════╗');
    console.log('  ║  LINKEDIN SECURITY CHECK                ║');
    console.log('  ║  Please complete the verification in    ║');
    console.log('  ║  the browser.                           ║');
    console.log('  ║  Press Enter when done to continue...   ║');
    console.log('  ╚══════════════════════════════════════════╝\n');
    await waitForEnter();
    return false;
  }
  return true;
}

function isInteractive() {
  // When spawned from the dashboard with stdio: ['ignore',...], stdin is
  // /dev/null (not a TTY). process.stdin.on('data') would hang forever.
  return process.stdin.isTTY;
}

function waitForEnter() {
  if (!isInteractive()) {
    console.log('  [non-interactive mode — proceeding without waiting]');
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const onData = () => {
      process.stdin.removeListener('data', onData);
      // Consume any buffered input including the newline
      resolve();
    };
    process.stdin.on('data', onData);
  });
}

// ─── Job Extraction (DOM scraping) ─────────────────────────────

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    const results = [];

    // Strategy 1: Find all elements with data-job-id (most reliable)
    const jobCards = document.querySelectorAll('[data-job-id]');

    // Strategy 2: Fallback — find list items in the results list
    const listItems = document.querySelectorAll(
      'li.jobs-search-results__list-item, ' +
      'li.ember-view.jobs-search-results__list-item, ' +
      '.jobs-search-results-list li'
    );

    // Use a Set to deduplicate by job ID within this extraction pass
    const seen = new Set();

    // Process job cards found via data-job-id
    for (const card of jobCards) {
      const jobId = card.getAttribute('data-job-id');
      // Some elements have data-job-id but aren't the container
      // (e.g. child elements). Only process containers.
      if (!jobId || seen.has(jobId)) continue;

      // Skip if this is a small child element (likely not the main card)
      const tag = card.tagName.toLowerCase();
      if (tag === 'span' || tag === 'a' || tag === 'button') {
        // Might be a child — check if parent has same data-job-id
        const parent = card.closest('[data-job-id]');
        if (parent && parent !== card) continue;
      }

      seen.add(jobId);

      // Title — try multiple selectors (LinkedIn changes these)
      const titleEl =
        card.querySelector('.job-card-list__title--link') ||
        card.querySelector('.job-card-list__title') ||
        card.querySelector('a.job-card-container__link') ||
        card.querySelector('a[data-tracking-control-name*="job_card_title"]') ||
        card.querySelector('.artdeco-entity-lockup__title a') ||
        card.querySelector('.job-card-search__title') ||
        card.querySelector('a[href*="/jobs/view/"]');

      // Company
      const companyEl =
        card.querySelector('.job-card-container__company-name') ||
        card.querySelector('.job-card-container__primary-description') ||
        card.querySelector('.artdeco-entity-lockup__subtitle span') ||
        card.querySelector('.artdeco-entity-lockup__subtitle') ||
        card.querySelector('.job-card-search__company-name') ||
        card.querySelector('[class*="company"]');

      // Location — often in metadata items
      const metadataItems = card.querySelectorAll(
        '.job-card-container__metadata-item, ' +
        '.job-card-search__location, ' +
        '.artdeco-entity-lockup__caption span, ' +
        '.artdeco-entity-lockup__caption'
      );

      let location = '';
      for (const item of metadataItems) {
        const text = (item.textContent || '').trim();
        // Skip empty, posted-date-like strings, salary strings
        if (!text) continue;
        if (/^\d/.test(text) && (text.includes('day') || text.includes('week') || text.includes('month') || text.includes('hour') || text.includes('minute'))) continue;
        if (text.includes('Easy Apply') || text.includes('Applicants') || text.includes('applicant')) continue;
        // First meaningful metadata item is usually location
        location = text;
        break;
      }

      // Posted date
      let posted = '';
      const timeEl = card.querySelector('time');
      if (timeEl) {
        posted = timeEl.getAttribute('datetime') || timeEl.textContent?.trim() || '';
      }
      if (!posted) {
        // Try to find it in metadata items by pattern matching
        for (const item of metadataItems) {
          const text = (item.textContent || '').trim();
          if (/^\d+\s+(day|week|month|hour|minute|second)s?\s+ago/i.test(text) ||
              /^just now/i.test(text) ||
              /^today/i.test(text) ||
              /^yesterday/i.test(text) ||
              /^\d+(st|nd|rd|th)\s/i.test(text)) {
            posted = text;
            break;
          }
        }
      }

      // Easy Apply check
      const cardText = card.textContent || '';
      const easyApply =
        cardText.includes('Easy Apply') ||
        !!card.querySelector('[class*="easy-apply"], [class*="easyApply"]');

      // URL
      let url = '';
      const linkEl =
        card.querySelector('a.job-card-container__link') ||
        card.querySelector('a.job-card-list__title--link') ||
        card.querySelector('a[href*="/jobs/view/"]');
      if (linkEl) {
        url = linkEl.getAttribute('href') || '';
        if (url && !url.startsWith('http')) {
          // Clean query params, keep the canonical path
          url = 'https://www.linkedin.com' + url.split('?')[0];
        }
      }
      if (!url && jobId) {
        url = `https://www.linkedin.com/jobs/view/${jobId}/`;
      }

      // Description snippet from the card (second line of text, or hidden description)
      let description = '';
      const snippetEl =
        card.querySelector('.job-card-container__description') ||
        card.querySelector('.job-card-search__snippet') ||
        card.querySelector('[class*="snippet"]');
      if (snippetEl) {
        description = snippetEl.textContent?.trim() || '';
      }

      if (titleEl && companyEl) {
        results.push({
          id: `li_${jobId}`,
          source: 'linkedin',
          company: companyEl.textContent?.trim() || '',
          title: titleEl.textContent?.trim() || '',
          location,
          url,
          description: description.substring(0, 4000),
          posted,
          scrapedAt: new Date().toISOString(),
          status: 'new',
          score: null,
          easy_apply: easyApply,
        });
      }
    }

    // Also process list items if we didn't get enough from data-job-id
    if (results.length === 0) {
      for (const li of listItems) {
        const link = li.querySelector('a[href*="/jobs/view/"]');
        if (!link) continue;

        const url = link.getAttribute('href') || '';
        const jobId = extractIdFromUrl(url);
        if (!jobId || seen.has(jobId)) continue;
        seen.add(jobId);

        const title = link.textContent?.trim() || '';
        const companyEl = li.querySelector('[class*="company"], .job-card-container__company-name');
        const locEl = li.querySelector('[class*="location"], .job-card-container__metadata-item');

        results.push({
          id: `li_${jobId}`,
          source: 'linkedin',
          company: companyEl?.textContent?.trim() || '',
          title,
          location: locEl?.textContent?.trim() || '',
          url: url.startsWith('http') ? url.split('?')[0] : `https://www.linkedin.com${url.split('?')[0]}`,
          description: '',
          posted: '',
          scrapedAt: new Date().toISOString(),
          status: 'new',
          score: null,
          easy_apply: false,
        });
      }
    }

    // Helper inside evaluate
    function extractIdFromUrl(url) {
      const m = url.match(/\/jobs\/view\/(\d+)/);
      return m ? m[1] : null;
    }

    return results;
  });
}

// ─── Scrolling & Accumulating ──────────────────────────────────

async function scrapeLinkedInJobs(page, config) {
  const jobs = [];
  const seenIds = new Set();
  const TARGET_MIN = 50;
  const MAX_SCROLLS = 30;
  const STREAK_LIMIT = 3;

  // Wait for results list to appear
  const selectors = [
    '.jobs-search-results-list',
    '.jobs-search__results-list',
    '.scaffold-layout__list',
    '[data-job-id]',
    '.job-card-container',
  ];

  let found = false;
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      found = true;
      break;
    } catch {
      // Try next selector
    }
  }

  if (!found) {
    console.log('  No job result elements detected. LinkedIn may have changed its layout.');
    // Try extracting what we can anyway
    const pageJobs = await extractJobsFromPage(page);
    pageJobs.forEach(j => { seenIds.add(j.id); jobs.push(j); });
    return jobs;
  }

  await randomDelay();

  console.log('  Scrolling job list to load results...');

  let previousCount = 0;
  let noNewStreak = 0;

  // Identify the scrollable container
  const scrollContainerSelectors = [
    '.jobs-search-results-list',
    '.jobs-search__results-list',
    '.scaffold-layout__list-container',
    '.scaffold-layout__list',
    '.jobs-search__left-rail',
  ];

  for (let i = 0; i < MAX_SCROLLS; i++) {
    // Extract all visible jobs
    const pageJobs = await extractJobsFromPage(page);
    let addedThisRound = 0;

    for (const job of pageJobs) {
      if (job.id && !seenIds.has(job.id) && job.title && job.company) {
        seenIds.add(job.id);
        jobs.push(job);
        addedThisRound++;
      }
    }

    // Log progress with reduced verbosity
    if (i % 3 === 0 || addedThisRound > 0) {
      console.log(`    Scroll ${String(i + 1).padStart(2)}: ${jobs.length} unique jobs (+${addedThisRound})`);
    }

    // Stop conditions
    if (jobs.length >= TARGET_MIN && i >= 5) {
      console.log(`  Reached ${TARGET_MIN}+ jobs target.`);
      break;
    }

    if (addedThisRound === 0) {
      noNewStreak++;
      if (noNewStreak >= STREAK_LIMIT) {
        console.log('  No new jobs in last 3 scrolls — end of results.');
        break;
      }
    } else {
      noNewStreak = 0;
      previousCount = jobs.length;
    }

    // Scroll within the job list container
    let scrolled = false;
    for (const sel of scrollContainerSelectors) {
      const container = await page.$(sel);
      if (container) {
        await container.evaluate(el => {
          el.scrollBy(0, 800);
        });
        scrolled = true;
        break;
      }
    }
    if (!scrolled) {
      await page.evaluate(() => window.scrollBy(0, 600));
    }

    // Human-like delay between scrolls (2-4 seconds)
    await sleep(randomBetween(2000, 4000));
  }

  return jobs;
}

// ─── Description Enrichment ────────────────────────────────────

async function enrichDescriptions(page, jobs, maxEnrich = 20) {
  if (jobs.length === 0) return;
  console.log(`  Enriching descriptions (up to ${maxEnrich})...`);

  const toEnrich = jobs.filter(j => !j.description || j.description.length < 100).slice(0, maxEnrich);
  let enriched = 0;

  for (const job of toEnrich) {
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(randomBetween(1500, 3000));

      const desc = await page.evaluate(() => {
        const selectors = [
          '.jobs-description__content',
          '.jobs-description',
          '.jobs-box__html-content',
          '.job-view-layout [class*="description"]',
          '#job-details',
          '.jobs-unified-description__content',
          '.jobs-description-content',
          '[data-test-id="job-details"]',
          '.job-details-jobs-unified-description__content',
          '.jobs-search__job-details--description',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim().length > 50) {
            return el.textContent.trim();
          }
        }
        return '';
      });

      if (desc) {
        job.description = desc.substring(0, 5000);
        enriched++;
      }
    } catch {
      // Skip failures silently
    }
  }

  console.log(`  Enriched ${enriched} job descriptions.`);
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const config = loadConfig();

  // Build search terms from CLI args or default
  const args = process.argv.slice(2);
  const DEFAULT_SEARCH =
    'software engineer OR backend engineer OR ai engineer OR platform engineer OR ' +
    'cloud engineer OR data engineer OR devops engineer OR sre OR site reliability engineer OR ' +
    'infrastructure engineer OR integrations engineer OR solutions engineer';
  const searchTerms = args.length > 0 ? args.join(' ') : DEFAULT_SEARCH;

  console.log(`\nLinkedIn Job Search`);
  console.log(`  Search: "${searchTerms}"`);
  console.log(`  Filters: Remote + Easy Apply + Past 30 days + Most recent`);
  console.log(`  Target locations: UK, UAE, Saudi Arabia, Qatar, Kuwait, Bahrain, Oman, Lebanon + Remote`);
  console.log(`  Profile dir: data/linkedin_profile\n`);

  // ── Launch browser ─────────────────────────────────────────

  console.log('Launching browser with persistent profile...');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // ── Navigate to search ─────────────────────────────────────

  const searchUrl = buildSearchUrl(searchTerms);
  console.log(`Navigating to LinkedIn Jobs...`);
  console.log(`URL: ${searchUrl}\n`);

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    console.error('ERROR: Failed to load LinkedIn. Check your internet connection.');
    await context.close();
    process.exit(1);
  }

  // ── Login check ────────────────────────────────────────────

  let loggedIn = await ensureLoggedIn(page, context);
  if (!loggedIn) {
    // User logged in manually — re-navigate
    console.log('Re-navigating to search after login...');
    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      loggedIn = await ensureLoggedIn(page, context);
      if (!loggedIn) {
        console.error('ERROR: Still not logged in or on login page. Aborting.');
        await context.close();
        process.exit(1);
      }
    } catch {
      console.error('ERROR: Navigation failed after login.');
      await context.close();
      process.exit(1);
    }
  }

  // ── Security / verification check ──────────────────────────

  const verified = await checkVerificationWall(page);
  if (!verified) {
    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    } catch {
      console.error('ERROR: Navigation failed after verification.');
      await context.close();
      process.exit(1);
    }
  }

  // ── Scrape ─────────────────────────────────────────────────

  console.log('Starting job extraction...\n');
  const rawJobs = await scrapeLinkedInJobs(page, config);

  console.log(`\nExtracted ${rawJobs.length} raw jobs from LinkedIn.`);

  if (rawJobs.length === 0) {
    console.log('\nNo jobs found. Possible reasons:');
    console.log('  - LinkedIn changed its DOM structure (selectors need updating)');
    console.log('  - Search returned no results for these terms');
    console.log('  - Anti-bot measures blocked scraping');
    console.log('\nTry:');
    console.log('  - Manually verify the search URL works in a regular browser');
    console.log('  - Check src/linkedin_find.js selectors against current LinkedIn DOM');
    await context.close();
    return;
  }

  // ── Apply config filters ───────────────────────────────────

  // Step 1: Role keyword match + exclude check
  let filtered = rawJobs.filter(j =>
    isEngineeringRole(j.title, j.company, j.description, config) &&
    isMidOrSenior(j.title)
  );
  console.log(`After role filter: ${filtered.length} jobs`);

  // Step 2: Location match
  filtered = filtered.filter(j => locationMatchesTarget(j.location));
  console.log(`After location filter: ${filtered.length} jobs`);

  // NOTE: Client-side remote check is SKIPPED here because the search URL
  // already includes f_WT=2 (Remote filter). LinkedIn guarantees all returned
  // jobs are remote. Adding a text-based check for "remote" in the job card
  // would falsely reject remote jobs whose location text omits the word (e.g.
  // "London, United Kingdom" for a UK-only remote role). If you remove f_WT=2
  // from the URL above, re-enable this check.

  // Step 3: Halal compliance filter
  const halalCfg = config.strict_filter || {};
  if (halalCfg.strict_mode !== false && halalCfg.exclude_industries) {
    filtered = filtered.filter(j => {
      const jobText = `${j.title || ''} ${j.company || ''} ${j.description || ''}`.toLowerCase();
      return !halalCfg.exclude_industries.some(kw => jobText.includes(kw.toLowerCase()));
    });
    console.log(`After halal filter: ${filtered.length} jobs`);
  }

  // ── Enrich descriptions (optional, for top candidates) ─────

  // Only enrich descriptions for jobs missing them
  const missingDesc = filtered.filter(j => !j.description || j.description.length < 50).length;
  if (missingDesc > 0) {
    console.log(`\n${missingDesc} jobs have minimal descriptions.`);
    console.log('To enrich, run interactive enrichment or visit individual job pages.');
    console.log('Description snippets from search results may be sufficient for scoring.\n');
  }

  // ── Dedup against existing jobs ────────────────────────────

  let existing = [];
  if (existsSync(JOBS_FILE)) {
    try {
      existing = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
    } catch {
      console.log('Warning: Could not parse existing jobs.json. Starting fresh.');
      existing = [];
    }
  }
  const existingIds = new Set(existing.map(j => j.id));

  const newJobs = filtered.filter(j => !existingIds.has(j.id));
  console.log(`New (after dedup): ${newJobs.length} jobs`);

  // ── Merge and save ─────────────────────────────────────────

  const merged = [...existing, ...newJobs];
  writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));

  console.log(`\n───────────────────────────────────────────────`);
  console.log(`Total pipeline: ${merged.length} jobs`);
  console.log(`New from LinkedIn: ${newJobs.length} jobs`);
  console.log(`Saved to: data/jobs.json`);

  if (newJobs.length > 0) {
    console.log(`\nSample new jobs:`);
    for (const j of newJobs.slice(0, 5)) {
      const loc = j.location || '(no location)';
      const ea = j.easy_apply ? ' [Easy Apply]' : '';
      console.log(`  - ${j.title} @ ${j.company} — ${loc}${ea}`);
    }
    if (newJobs.length > 5) {
      console.log(`  ... and ${newJobs.length - 5} more`);
    }
  }

  // ── Cleanup ────────────────────────────────────────────────

  await context.close();

  console.log(`\nNext: node src/score.js     (score jobs against your profile)`);
  console.log(`      node src/status.js    (view pipeline)`);
  console.log(`      node src/linkedin_find.js  (run again for more)\n`);
}

main().catch(e => {
  console.error('\nFATAL ERROR:');
  console.error(e);
  process.exit(1);
});
