// bayt_find.js — Search Bayt.com (Middle East #1 job board) for jobs using Playwright
// Uses persistent browser context to maintain login session.
// Scrapes Bayt.com job search results and adds to data/jobs.json.
//
// Usage:
//   node src/bayt_find.js
//
// The browser opens visibly — log in once if needed, cookies persist in data/linkedin_profile/

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

// ─── Search URL Construction ───────────────────────────────────

const COUNTRIES = [
  { slug: 'uae', name: 'UAE' },
  { slug: 'saudi-arabia', name: 'Saudi Arabia' },
  { slug: 'qatar', name: 'Qatar' },
  { slug: 'kuwait', name: 'Kuwait' },
  { slug: 'bahrain', name: 'Bahrain' },
  { slug: 'oman', name: 'Oman' },
  { slug: 'lebanon', name: 'Lebanon' },
];

// Top keyword variations to search per country.
// Using a focused set to keep total searches manageable (~35 total).
const TECH_KEYWORDS = [
  'software engineer',
  'backend engineer',
  'ai engineer',
  'cloud engineer',
  'data engineer',
];

/**
 * Build all search URLs: each country × each keyword.
 * All include ?remote=1 to filter for remote jobs.
 * Also includes a broad (no keyword) search per country for coverage.
 */
function buildSearchUrls() {
  const urls = [];
  for (const country of COUNTRIES) {
    // Broad search (no keyword) — catches everything for this country
    urls.push({
      url: `https://www.bayt.com/en/${country.slug}/jobs/search/?remote=1`,
      country: country.name,
      keyword: '(all)',
    });
    // Keyword-targeted searches
    for (const keyword of TECH_KEYWORDS) {
      const encoded = encodeURIComponent(keyword);
      urls.push({
        url: `https://www.bayt.com/en/${country.slug}/jobs/search/?remote=1&keyword=${encoded}`,
        country: country.name,
        keyword,
      });
    }
  }
  return urls;
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

/**
 * Extract numeric Bayt job ID from a URL like:
 *   https://www.bayt.com/en/uae/jobs/software-engineer-12345678/
 *   https://www.bayt.com/en/company/company-name/jobs/role-12345678/
 * Falls back to hashing the URL if no numeric ID is found.
 */
function extractBaytJobId(url) {
  if (!url) return null;
  // Match trailing numeric ID before any slash or query param
  const m = url.match(/(\d{6,})(?:\/|\?|$)/);
  if (m) return m[1];
  return null;
}

/**
 * Check if a job card element or its ancestors are visually hidden
 * (display:none, visibility:hidden, etc.)
 */
function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

// ─── Location Matching for Bayt ────────────────────────────────

const TARGET_COUNTRIES = [
  'united arab emirates', 'uae', 'dubai', 'abu dhabi', 'sharjah',
  'saudi arabia', 'saudi', 'riyadh', 'jeddah', 'dammam',
  'qatar', 'doha',
  'kuwait',
  'bahrain', 'manama',
  'oman', 'muscat',
  'lebanon', 'beirut',
  'remote', 'anywhere', 'distributed', 'work from home', 'wfh',
];

function locationMatchesTarget(locationText) {
  if (!locationText) return true; // Don't filter out jobs with no location
  const lower = locationText.toLowerCase();
  return TARGET_COUNTRIES.some(loc => lower.includes(loc));
}

// ─── Role / Engineering Filtering ──────────────────────────────

function isEngineeringRole(title, company, description, config) {
  const text = `${title} ${company} ${description || ''}`.toLowerCase();
  const keywords = config.role_keywords || [];
  const excludes = config.exclude_roles || [];

  // Reject if any exclude keyword matches
  // Use word boundaries for short terms (≤4 chars) to avoid false positives
  for (const kw of excludes) {
    if (kw.length <= 4) {
      if (new RegExp(`\\b${kw}\\b`, 'i').test(text)) return false;
    } else if (text.includes(kw)) {
      return false;
    }
  }

  // Accept if any role keyword matches
  return keywords.some(kw => text.includes(kw));
}

function isMidOrSenior(title) {
  const t = title.toLowerCase();
  const juniorTerms = ['junior', 'intern', 'graduate', 'entry level', 'entry-level', 'apprentice'];
  if (juniorTerms.some(kw => t.includes(kw))) return false;
  const leadershipTerms = ['vp of', 'vice president', 'chief ', 'director of engineering', 'head of engineering', 'senior manager'];
  if (leadershipTerms.some(kw => t.includes(kw))) return false;
  return true;
}

// ─── Login / Verification Check ────────────────────────────────

async function ensureLoggedIn(page) {
  await sleep(2000);
  const currentUrl = page.url();

  // Check for login wall
  const isOnLoginPage =
    currentUrl.includes('/login') ||
    currentUrl.includes('/sign-in') ||
    currentUrl.includes('/auth');

  if (isOnLoginPage) {
    console.log('\n  ╔══════════════════════════════════════════╗');
    console.log('  ║  NOT LOGGED IN TO BAYT.COM              ║');
    console.log('  ║  A browser window should be open.        ║');
    console.log('  ║  Please log in manually, then press     ║');
    console.log('  ║  Enter here to continue...              ║');
    console.log('  ╚══════════════════════════════════════════╝\n');
    await waitForEnter();
    return false;
  }

  return true;
}

function waitForEnter() {
  return new Promise(resolve => {
    const onData = () => {
      process.stdin.removeListener('data', onData);
      resolve();
    };
    process.stdin.on('data', onData);
  });
}

// ─── Job Extraction from Bayt Search Results Page ─────────────

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // ── Selector Strategies (in order of preference) ──────────

    // Strategy 1: Bayt's data-automation-id pattern (newest design)
    const automationCards = document.querySelectorAll(
      '[data-automation-id="jobCard"], ' +
      '[data-automation-id="job-card"], ' +
      '[data-automation-id^="job"]'
    );

    // Strategy 2: Job list items (common Bayt pattern)
    const jobListItems = document.querySelectorAll(
      'li.has-pointer-d, ' +
      'li[data-js-aid="job-card"], ' +
      'ul.jobs-list li, ' +
      '.job-list-item, ' +
      '[class*="job-list"] li, ' +
      'div[class*="job-card"], ' +
      '[class*="jb-card"]'
    );

    // Strategy 3: Generic article/result cards containing job links
    const resultCards = document.querySelectorAll(
      'article[class*="job"], ' +
      'div[class*="result"], ' +
      '.search-result-item, ' +
      '[class*="listing"]'
    );

    // Collect all candidate cards
    let cards = [];
    if (automationCards.length > 0) {
      cards = Array.from(automationCards);
    } else if (jobListItems.length > 0) {
      cards = Array.from(jobListItems);
    } else if (resultCards.length > 0) {
      cards = Array.from(resultCards);
    } else {
      // Last resort: any element containing a Bayt job URL
      cards = Array.from(document.querySelectorAll('a[href*="/jobs/"]')).map(a => a.closest('li, div, article')).filter(Boolean);
    }

    for (const card of cards) {
      if (!card) continue;

      // ── Title ──────────────────────────────────────────
      let titleEl =
        card.querySelector('h2') ||
        card.querySelector('.jb-title') ||
        card.querySelector('[data-automation-id="jobTitle"]') ||
        card.querySelector('a[data-automation-id="jobTitle"]') ||
        card.querySelector('[class*="title"] a') ||
        card.querySelector('[class*="title"]') ||
        card.querySelector('a[href*="/jobs/"]');

      const title = (titleEl?.textContent || '').trim();
      if (!title || title.length < 3) continue; // Skip empty/meaningless titles

      // ── URL ────────────────────────────────────────────
      let urlEl =
        card.querySelector('a[href*="/jobs/"]') ||
        card.querySelector('a[data-automation-id="jobTitle"]') ||
        card.querySelector('a[class*="title"]') ||
        card.querySelector('h2 a') ||
        titleEl?.closest('a');

      let url = '';
      if (urlEl) {
        url = urlEl.getAttribute('href') || '';
      }
      // Fix relative URLs
      if (url && !url.startsWith('http')) {
        url = 'https://www.bayt.com' + url.split('?')[0];
      }

      // ── Company ────────────────────────────────────────
      const companyEl =
        card.querySelector('.jb-company') ||
        card.querySelector('[data-automation-id="companyName"]') ||
        card.querySelector('[class*="company"]') ||
        card.querySelector('[class*="employer"]') ||
        card.querySelector('[class*="jb-comp"]');

      const company = (companyEl?.textContent || '').trim();

      // ── Location ───────────────────────────────────────
      const locationEl =
        card.querySelector('.jb-location') ||
        card.querySelector('[data-automation-id="location"]') ||
        card.querySelector('[class*="location"]') ||
        card.querySelector('[class*="jb-loc"]') ||
        card.querySelector('[title*="ocation"]');

      const location = (locationEl?.textContent || '').trim();

      // ── Posted Date ────────────────────────────────────
      const dateEl =
        card.querySelector('.jb-date') ||
        card.querySelector('[data-automation-id="postedDate"]') ||
        card.querySelector('time') ||
        card.querySelector('[class*="date"]') ||
        card.querySelector('[class*="posted"]') ||
        card.querySelector('[class*="jb-date"]');

      let posted = '';
      if (dateEl) {
        posted = dateEl.getAttribute('datetime') || dateEl.textContent?.trim() || '';
      }

      // ── Description Snippet ────────────────────────────
      const descEl =
        card.querySelector('.jb-description') ||
        card.querySelector('[data-automation-id="jobDescription"]') ||
        card.querySelector('[class*="description"]') ||
        card.querySelector('[class*="snippet"]') ||
        card.querySelector('[class*="summary"]') ||
        card.querySelector('[class*="jb-desc"]') ||
        card.querySelector('p');

      let description = (descEl?.textContent || '').trim();
      // If description contains the title + company, trim it
      if (description.length > 5000 || description === title) {
        description = description.substring(0, 4000);
      }

      // ── Job ID ─────────────────────────────────────────
      let jobId = null;
      if (url) {
        const m = url.match(/(\d{6,})(?:\/|\?|$)/);
        if (m) jobId = m[1];
      }
      // Fallback: hash the URL if no numeric ID
      if (!jobId && url) {
        let hash = 0;
        for (let i = 0; i < url.length; i++) {
          hash = ((hash << 5) - hash) + url.charCodeAt(i);
          hash |= 0;
        }
        jobId = 'h' + Math.abs(hash).toString(36);
      }
      if (!jobId) continue;

      if (seen.has(jobId)) continue;
      seen.add(jobId);

      results.push({
        id: `bayt_${jobId}`,
        source: 'bayt',
        company,
        title,
        location,
        url,
        description: description.substring(0, 4000),
        posted,
        scrapedAt: new Date().toISOString(),
        status: 'new',
        score: null,
      });
    }

    return results;
  });
}

// ─── Scrolling & Accumulating Results ─────────────────────────

async function scrapeSearchResults(page, searchUrl, country, keyword) {
  const jobs = [];
  const seenIds = new Set();
  const MAX_SCROLLS = 7;
  const STREAK_LIMIT = 3;

  // Navigate
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log(`    ✗ Failed to load: ${e.message}`);
    return jobs;
  }

  await randomDelay();

  // Check login
  const loggedIn = await ensureLoggedIn(page);
  if (!loggedIn) {
    // User logged in — re-navigate
    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    } catch {
      return jobs;
    }
  }

  // Wait for any results to appear
  try {
    await page.waitForSelector(
      'a[href*="/jobs/"], li.has-pointer-d, [data-automation-id="jobCard"], .jb-title, h2',
      { timeout: 8000 }
    );
  } catch {
    // No results found for this search — that's OK
    return jobs;
  }

  let noNewStreak = 0;

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

    if (i % 2 === 0 || addedThisRound > 0) {
      // Reduced verbosity
    }

    // Stop conditions
    if (addedThisRound === 0) {
      noNewStreak++;
      if (noNewStreak >= STREAK_LIMIT) break;
    } else {
      noNewStreak = 0;
    }

    // Scroll down to trigger lazy loading
    await page.evaluate(() => {
      window.scrollBy(0, 800);
    });

    // Also try scrolling within job result containers
    try {
      const container = await page.$(
        'ul.jobs-list, [class*="results"], [class*="listings"], [class*="search-results"]'
      );
      if (container) {
        await container.evaluate(el => el.scrollBy(0, 600));
      }
    } catch {
      // Container not found — that's fine
    }

    await sleep(randomBetween(2000, 3500));
  }

  return jobs;
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const config = loadScrapeConfig();

  const searchUrls = buildSearchUrls();
  console.log(`\nBayt.com Job Search (#1 Middle East Job Board)`);
  console.log(`  Locations: ${COUNTRIES.map(c => c.name).join(', ')}`);
  console.log(`  Keywords: ${TECH_KEYWORDS.join(', ')}`);
  console.log(`  Total searches: ${searchUrls.length} (${COUNTRIES.length} broad + ${COUNTRIES.length * TECH_KEYWORDS.length} keyword)`);
  console.log(`  Profile dir: data/linkedin_profile\n`);

  // ── Launch browser with persistent profile ──────────────

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

  // ── Iterate over all search URLs ────────────────────────

  const allJobs = [];
  const globalSeen = new Set();

  for (let idx = 0; idx < searchUrls.length; idx++) {
    const { url, country, keyword } = searchUrls[idx];
    const label = keyword === '(all)' ? 'ALL' : keyword;
    console.log(`  [${String(idx + 1).padStart(2)}/${searchUrls.length}] ${country} — "${label}"`);

    try {
      const jobs = await scrapeSearchResults(page, url, country, keyword);
      let newForSearch = 0;
      for (const job of jobs) {
        if (!globalSeen.has(job.id)) {
          globalSeen.add(job.id);
          allJobs.push(job);
          newForSearch++;
        }
      }
      console.log(`    → ${jobs.length} extracted, ${newForSearch} new unique (total unique: ${allJobs.length})`);
    } catch (e) {
      console.log(`    ✗ Error: ${e.message}`);
    }

    // Polite delay between searches to avoid rate limiting
    if (idx < searchUrls.length - 1) {
      await sleep(randomBetween(2000, 4000));
    }
  }

  console.log(`\n───────────────────────────────────────────────`);
  console.log(`Total extracted (before filtering): ${allJobs.length} unique jobs`);

  if (allJobs.length === 0) {
    console.log('\nNo jobs found. Possible reasons:');
    console.log('  - Bayt changed its DOM structure (selectors need updating)');
    console.log('  - Search URLs returned no results');
    console.log('  - Anti-bot measures blocked scraping');
    console.log('\nTry:');
    console.log('  - Manually verify a search URL works in a regular browser');
    console.log('  - Check src/bayt_find.js selectors against current Bayt DOM');
    await context.close();
    return;
  }

  // ── Apply Config Filters ────────────────────────────────

  // Step 1: Role keyword match + exclude check
  let filtered = allJobs.filter(j =>
    isEngineeringRole(j.title, j.company, j.description, config) &&
    isMidOrSenior(j.title)
  );
  console.log(`After role filter: ${filtered.length} jobs`);

  // Step 2: Location match
  filtered = filtered.filter(j => locationMatchesTarget(j.location));
  console.log(`After location filter: ${filtered.length} jobs`);

  // Step 3: Freshness filter
  const maxAge = config.max_job_age_days || 30;
  if (maxAge && maxAge > 0) {
    const before = filtered.length;
    filtered = filtered.filter(j => {
      if (!j.posted) return true; // Keep jobs with unknown dates
      // Try to parse Bayt's relative date strings
      const parsed = parseBaytDate(j.posted);
      if (!parsed) return true; // Keep if we can't parse the date
      const daysOld = (Date.now() - parsed.getTime()) / DAY_MS;
      return daysOld <= maxAge;
    });
    console.log(`After freshness filter (${maxAge}d): ${filtered.length} jobs (removed ${before - filtered.length})`);
  }

  // Step 4: Halal compliance filter
  const halalCfg = config.strict_filter || {};
  if (halalCfg.strict_mode !== false && halalCfg.exclude_industries) {
    const before = filtered.length;
    filtered = filtered.filter(j => {
      const jobText = `${j.title || ''} ${j.company || ''} ${j.description || ''}`.toLowerCase();
      return !halalCfg.exclude_industries.some(kw => jobText.includes(kw.toLowerCase()));
    });
    console.log(`After halal filter: ${filtered.length} jobs (removed ${before - filtered.length})`);
  }

  // ── Pre-rank with computeRelevance ───────────────────────

  for (const j of filtered) {
    j.relevance = computeRelevance(j, config);
  }

  // ── Apply max_jobs_per_company cap ──────────────────────

  const cap = config.max_jobs_per_company;
  if (cap) {
    // Group by company, sort each group by relevance desc, take top N
    const byCompany = new Map();
    for (const j of filtered) {
      const key = (j.company || 'unknown').toLowerCase().trim();
      if (!byCompany.has(key)) byCompany.set(key, []);
      byCompany.get(key).push(j);
    }
    filtered = [];
    for (const [company, jobs] of byCompany) {
      jobs.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
      filtered.push(...jobs.slice(0, cap));
    }
    console.log(`After per-company cap (${cap}): ${filtered.length} jobs`);
  }

  // ── Dedup against existing jobs.json ─────────────────────

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
  console.log(`New (after dedup against jobs.json): ${newJobs.length} jobs`);

  // ── Merge and save ──────────────────────────────────────

  const merged = [...existing, ...newJobs];
  writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));

  console.log(`\n───────────────────────────────────────────────`);
  console.log(`Total pipeline: ${merged.length} jobs`);
  console.log(`New from Bayt: ${newJobs.length} jobs`);
  console.log(`Saved to: data/jobs.json`);

  if (newJobs.length > 0) {
    console.log(`\nSample new Bayt jobs:`);
    for (const j of newJobs.slice(0, 5)) {
      const loc = j.location || '(no location)';
      const rel = j.relevance ? ` [score: ${j.relevance}]` : '';
      console.log(`  - ${j.title} @ ${j.company} — ${loc}${rel}`);
    }
    if (newJobs.length > 5) {
      console.log(`  ... and ${newJobs.length - 5} more`);
    }
  }

  // ── Cleanup ─────────────────────────────────────────────

  await context.close();

  console.log(`\nNext: node src/score.js     (score jobs against your profile)`);
  console.log(`      node src/status.js    (view pipeline)`);
  console.log(`      node src/bayt_find.js  (run again for more)\n`);
}

// ─── Date Parsing ──────────────────────────────────────────────

/**
 * Parse Bayt's relative date strings like:
 *   "Posted 2 days ago", "Posted 1 week ago",
 *   "Posted 3 hours ago", "Posted 1 month ago",
 *   Or actual dates like "15 Jul 2026", "2024-07-15"
 */
function parseBaytDate(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.toLowerCase().trim();

  // ISO date
  const isoMatch = s.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    const d = new Date(isoMatch[1]);
    return isNaN(d.getTime()) ? null : d;
  }

  // Relative: "X days ago", "X weeks ago", etc.
  const relMatch = s.match(/(\d+)\s+(hour|minute|day|week|month|year)s?\s+ago/i);
  if (relMatch) {
    const num = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const now = new Date();
    switch (unit) {
      case 'minute': return new Date(now - num * 60 * 1000);
      case 'hour': return new Date(now - num * 3600 * 1000);
      case 'day': return new Date(now - num * DAY_MS);
      case 'week': return new Date(now - num * 7 * DAY_MS);
      case 'month': return new Date(now - num * 30 * DAY_MS);
      case 'year': return new Date(now - num * 365 * DAY_MS);
      default: return null;
    }
  }

  // "Today", "Yesterday"
  if (s.includes('today') || s.includes('just now')) return new Date();
  if (s.includes('yesterday')) return new Date(Date.now() - DAY_MS);

  // "Posted Xd" or "Xd ago" (abbreviated)
  const abbrMatch = s.match(/posted\s+(\d+)\s*d/i) || s.match(/(\d+)d\s+ago/i);
  if (abbrMatch) {
    return new Date(Date.now() - parseInt(abbrMatch[1], 10) * DAY_MS);
  }

  // "DD Mon YYYY" or "Mon DD, YYYY"
  const dateMatch = s.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/i);
  if (dateMatch) {
    const d = new Date(`${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

// ─── Entry Point ───────────────────────────────────────────────

main().catch(e => {
  console.error('\nFATAL ERROR:');
  console.error(e);
  process.exit(1);
});
