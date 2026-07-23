// linkedin_contract_find.js — Search LinkedIn for contract/freelance jobs using Playwright
// Uses the SAME persistent browser profile as linkedin_find.js (data/linkedin_profile/).
// Searches LinkedIn Jobs with contract-specific filters and saves to data/contract_jobs.json.
//
// Usage:
//   node src/linkedin_contract_find.js [search_terms]
//   node src/linkedin_contract_find.js "contract OR freelance OR consultant"
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
const JOBS_FILE = resolve(DATA_DIR, 'contract_jobs.json');
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
  const m1 = url.match(/\/jobs\/view\/(\d+)/);
  if (m1) return m1[1];
  const m2 = url.match(/currentJobId=(\d+)/);
  if (m2) return m2[1];
  return null;
}

// ─── Rate Extraction ───────────────────────────────────────────

function extractRateFromText(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  // Day rate patterns (most common for contract roles in UK/EU)
  const dayRateMatch = lower.match(/(?:£|gbp?\s*)(\d{3,4})(?:\s*[-–to]+\s*(\d{3,4}))?\s*(?:\/|per)\s*day/);
  if (dayRateMatch) {
    return { min: parseInt(dayRateMatch[1]), max: parseInt(dayRateMatch[2] || dayRateMatch[1]), currency: 'GBP', unit: 'day' };
  }

  // Hourly rate — USD
  const usdHourly = lower.match(/\$(\d{2,3})(?:\s*[-–to]+\s*\$?(\d{2,3}))?\s*(?:\/|per)\s*hr/);
  if (usdHourly) {
    return { min: parseInt(usdHourly[1]), max: parseInt(usdHourly[2] || usdHourly[1]), currency: 'USD', unit: 'hour' };
  }

  // Hourly rate — EUR
  const eurHourly = lower.match(/(?:€|eur?\s*)(\d{2,3})(?:\s*[-–to]+\s*(\d{2,3}))?\s*(?:\/|per)\s*hr/);
  if (eurHourly) {
    return { min: parseInt(eurHourly[1]), max: parseInt(eurHourly[2] || eurHourly[1]), currency: 'EUR', unit: 'hour' };
  }

  // Generic day rate (USD)
  const usdDay = lower.match(/\$(\d{3,4})(?:\s*[-–to]+\s*\$?(\d{3,4}))?\s*(?:\/|per)\s*day/);
  if (usdDay) {
    return { min: parseInt(usdDay[1]), max: parseInt(usdDay[2] || usdDay[1]), currency: 'USD', unit: 'day' };
  }

  // EUR per day
  const eurDay = lower.match(/(?:€|eur?\s*)(\d{3,4})(?:\s*[-–to]+\s*(\d{3,4}))?\s*(?:\/|per)\s*day/);
  if (eurDay) {
    return { min: parseInt(eurDay[1]), max: parseInt(eurDay[2] || eurDay[1]), currency: 'EUR', unit: 'day' };
  }

  // Generic: "rate: £X" or "£X/day"
  const genericGbp = lower.match(/(?:£|gbp?\s*)(\d{3,4})(?:\s*[-–to]+\s*(\d{3,4}))?(?:\/|per)\s*?d/);
  if (genericGbp) {
    return { min: parseInt(genericGbp[1]), max: parseInt(genericGbp[2] || genericGbp[1]), currency: 'GBP', unit: 'day' };
  }

  return null;
}

// ─── Location Matching (same as linkedin_find.js) ───────────────

const TARGET_LOCATION_PATTERNS = [
  // United Kingdom
  'united kingdom', 'uk', 'london', 'england', 'manchester', 'birmingham',
  'edinburgh', 'glasgow', 'bristol', 'cambridge', 'oxford', 'leeds',
  // Europe — major tech hubs
  'ireland', 'dublin',
  'germany', 'berlin', 'munich', 'frankfurt', 'hamburg',
  'netherlands', 'amsterdam', 'rotterdam',
  'france', 'paris',
  'sweden', 'stockholm',
  'denmark', 'copenhagen',
  'norway', 'oslo',
  'finland', 'helsinki',
  'switzerland', 'zurich', 'geneva',
  'austria', 'vienna',
  'spain', 'barcelona', 'madrid',
  'portugal', 'lisbon',
  'belgium', 'brussels',
  'poland', 'warsaw',
  'czech', 'prague',
  'estonia', 'tallinn',
  'slovenia', 'ljubljana',
  'croatia', 'zagreb',
  'bosnia', 'sarajevo',
  'albania', 'tirana',
  'kosovo', 'pristina',
  'europe', 'eu', 'emea',
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
];

function locationMatchesTarget(locationText) {
  if (!locationText) return false;
  const lower = locationText.toLowerCase();
  return TARGET_LOCATION_PATTERNS.some(loc => lower.includes(loc));
}

// ─── Role Filtering ─────────────────────────────────────────────

function isEngineeringRole(title, company, description, config) {
  const text = `${title} ${company} ${description || ''}`.toLowerCase();
  const keywords = config.role_keywords || [];
  const excludes = config.exclude_roles || [];

  // Reject if any exclude keyword matches
  if (excludes.some(kw => text.includes(kw))) return false;

  // Accept if any role keyword matches
  return keywords.some(kw => text.includes(kw));
}

// ─── Contract-Specific Roles — also match contract-common titles ─

function isContractRelevant(job) {
  const text = `${job.title} ${job.description || ''}`.toLowerCase();

  // Titles commonly found in contract/freelance that might not be in standard role_keywords
  const contractTitles = [
    'contract', 'freelance', 'consultant', 'temporary', 'interim',
    'outside ir35', 'inside ir35', 'b2b', 'hourly', 'day rate',
    'statement of work', 'sow', 'short term', 'short-term',
    'independent contractor', 'subcontractor', 'associate',
  ];

  // If any contract keyword is found, consider it potentially relevant
  const isContract = contractTitles.some(kw => text.includes(kw));
  if (isContract) return true;

  // Also accept jobs with clear rate mentions
  const hasExplicitRate = /(?:£|\$|€)\s*\d{2,4}\s*(?:\/|per)\s*(?:day|hr|hour)/i.test(text);
  if (hasExplicitRate) return true;

  return false;
}

// ─── LinkedIn URL Builder (CONTRACT-SPECIFIC) ──────────────────

function buildSearchUrl(searchTerms) {
  const keywords = encodeURIComponent(searchTerms);
  // f_WT=2       → Remote
  // f_TPR=r1592000 → Past 15 days (1,592,000 seconds)
  // f_JT=C%2CT   → Contract + Temporary (URL-encoded comma)
  // sortBy=R     → Most recent first
  // refresh=true → Force fresh search (bypass cache)
  // NOTE: No f_AL=true — contract jobs less likely to have Easy Apply, we want more results
  return (
    'https://www.linkedin.com/jobs/search/?' +
    `keywords=${keywords}` +
    `&f_WT=2` +
    `&f_TPR=r1592000` +
    `&f_JT=C%2CT` +
    `&sortBy=R` +
    `&refresh=true` +
    `&origin=JOB_SEARCH_PAGE_JOB_FILTER`
  );
}

// ─── Login / Verification Check (same as linkedin_find.js) ─────

async function ensureLoggedIn(page, context) {
  await sleep(3000);
  const currentUrl = page.url();

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
    return false;
  }

  const hasAuthWall = await page.evaluate(() => {
    const bodyText = (document.body.textContent || '').toLowerCase();
    if (bodyText.includes('welcome to your professional community') &&
        bodyText.includes('sign in')) {
      return true;
    }
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

function waitForEnter() {
  return new Promise(resolve => {
    const onData = () => {
      process.stdin.removeListener('data', onData);
      resolve();
    };
    process.stdin.on('data', onData);
  });
}

// ─── Job Extraction (DOM scraping — same selectors as linkedin_find.js) ──

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    const results = [];
    const jobCards = document.querySelectorAll('[data-job-id]');
    const seen = new Set();

    for (const card of jobCards) {
      const jobId = card.getAttribute('data-job-id');
      if (!jobId || seen.has(jobId)) continue;

      // Skip small child elements (not the main card container)
      const tag = card.tagName.toLowerCase();
      if (tag === 'span' || tag === 'a' || tag === 'button') {
        const parent = card.closest('[data-job-id]');
        if (parent && parent !== card) continue;
      }

      seen.add(jobId);

      // Title
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

      // Location — from metadata items
      const metadataItems = card.querySelectorAll(
        '.job-card-container__metadata-item, ' +
        '.job-card-search__location, ' +
        '.artdeco-entity-lockup__caption span, ' +
        '.artdeco-entity-lockup__caption'
      );

      let location = '';
      for (const item of metadataItems) {
        const text = (item.textContent || '').trim();
        if (!text) continue;
        if (/^\d/.test(text) && (text.includes('day') || text.includes('week') || text.includes('month') || text.includes('hour') || text.includes('minute'))) continue;
        if (text.includes('Easy Apply') || text.includes('Applicants') || text.includes('applicant')) continue;
        if (text.includes('Contract') || text.includes('Temporary') || text.includes('Freelance')) {
          // This is employment type, skip — location usually follows
          continue;
        }
        location = text;
        break;
      }
      // If we didn't find a location in metadata (because we skipped employment type labels),
      // try the second metadata item
      if (!location && metadataItems.length > 1) {
        for (let i = 0; i < metadataItems.length; i++) {
          const text = (metadataItems[i].textContent || '').trim();
          if (!text) continue;
          // Skip employment type indicators
          if (/contract|temporary|freelance|part.time|full.time|internship/i.test(text) && text.split(' ').length <= 3) {
            continue;
          }
          // Skip date/time patterns
          if (/^\d/.test(text) && /\d/.test(text) && (text.includes('day') || text.includes('week') || text.includes('ago'))) continue;
          if (text.includes('Easy Apply') || text.includes('Applicants')) continue;
          location = text;
          break;
        }
      }

      // Posted date
      let posted = '';
      const timeEl = card.querySelector('time');
      if (timeEl) {
        posted = timeEl.getAttribute('datetime') || timeEl.textContent?.trim() || '';
      }
      if (!posted) {
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
          url = 'https://www.linkedin.com' + url.split('?')[0];
        }
      }
      if (!url && jobId) {
        url = `https://www.linkedin.com/jobs/view/${jobId}/`;
      }

      // Description snippet from the card
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
          source: 'linkedin_contract',
          type: 'contract',
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
          rate: null, // Will be populated from description enrichment or card text
        });
      }
    }

    return results;
  });
}

// ─── Scrolling & Accumulating (same as linkedin_find.js) ────────

async function scrapeLinkedInJobs(page, config) {
  const jobs = [];
  const seenIds = new Set();
  const TARGET_MIN = 30; // Contract listings are sparser — lower target
  const MAX_SCROLLS = 30;
  const STREAK_LIMIT = 3;

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
    const pageJobs = await extractJobsFromPage(page);
    pageJobs.forEach(j => { seenIds.add(j.id); jobs.push(j); });
    return jobs;
  }

  await randomDelay();
  console.log('  Scrolling job list to load results...');

  let noNewStreak = 0;

  const scrollContainerSelectors = [
    '.jobs-search-results-list',
    '.jobs-search__results-list',
    '.scaffold-layout__list-container',
    '.scaffold-layout__list',
    '.jobs-search__left-rail',
  ];

  for (let i = 0; i < MAX_SCROLLS; i++) {
    const pageJobs = await extractJobsFromPage(page);
    let addedThisRound = 0;

    for (const job of pageJobs) {
      if (job.id && !seenIds.has(job.id) && job.title && job.company) {
        seenIds.add(job.id);
        jobs.push(job);
        addedThisRound++;
      }
    }

    if (i % 3 === 0 || addedThisRound > 0) {
      console.log(`    Scroll ${String(i + 1).padStart(2)}: ${jobs.length} unique jobs (+${addedThisRound})`);
    }

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

    await sleep(randomBetween(2000, 4000));
  }

  return jobs;
}

// ─── Description Enrichment (visit job pages for missing descriptions) ──

async function enrichDescriptions(page, jobs, maxEnrich = 15) {
  if (jobs.length === 0) return;
  console.log(`  Enriching descriptions + rate detection (up to ${maxEnrich})...`);

  const toEnrich = jobs.filter(j => !j.description || j.description.length < 100).slice(0, maxEnrich);
  let enriched = 0;

  for (const job of toEnrich) {
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(randomBetween(1500, 3000));

      const result = await page.evaluate(() => {
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
        let desc = '';
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim().length > 50) {
            desc = el.textContent.trim();
            break;
          }
        }
        // Also capture the whole page text for rate detection
        return { desc, fullText: (document.body.textContent || '').substring(0, 20000) };
      });

      if (result.desc) {
        job.description = result.desc.substring(0, 5000);
        enriched++;
      }

      // Try to extract rate from full description
      if (!job.rate) {
        const rateText = result.desc || result.fullText || job.description || '';
        // Use the same rate extraction logic
        const rate = extractRateFromText(rateText);
        if (rate) {
          job.rate = rate;
          console.log(`    Found rate: ${rate.currency} ${rate.min}${rate.max !== rate.min ? '-' + rate.max : ''}/${rate.unit}`);
        }
      }

      // Detect contract-specific fields from the job description
      const fullText = (result.desc || result.fullText || '').toLowerCase();
      if (fullText.includes('outside ir35')) job.ir35 = 'outside';
      else if (fullText.includes('inside ir35')) job.ir35 = 'inside';
      if (fullText.match(/contract\s*(?:length|duration)[:\s]*(\d+[-\s]+\d+\s*(?:months?|weeks?))/i)) {
        job.contract_length = fullText.match(/contract\s*(?:length|duration)[:\s]*(\d+[-\s]+\d+\s*(?:months?|weeks?))/i)[0];
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
    'contract OR freelance OR consultant OR B2B OR hourly OR "outside IR35" OR ' +
    '"inside IR35" OR "day rate" OR temporary OR "statement of work" OR interim';
  const searchTerms = args.length > 0 ? args.join(' ') : DEFAULT_SEARCH;

  console.log(`\nLinkedIn CONTRACT Job Search`);
  console.log(`  Search: "${searchTerms}"`);
  console.log(`  Filters: Remote + Contract/Temporary + Past 30 days + Most Recent`);
  console.log(`  Target locations: UK, Europe, Gulf, Lebanon + Remote`);
  console.log(`  Profile dir: data/linkedin_profile`);
  console.log(`  Output: data/contract_jobs.json\n`);

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

  console.log(`\nExtracted ${rawJobs.length} raw contract jobs from LinkedIn.`);

  if (rawJobs.length === 0) {
    console.log('\nNo jobs found. Possible reasons:');
    console.log('  - LinkedIn changed its DOM structure (selectors need updating)');
    console.log('  - Search returned no results for these terms');
    console.log('  - Anti-bot measures blocked scraping');
    console.log('  - f_JT=C%2CT filter may need format adjustment');
    console.log('\nTry:');
    console.log('  - Manually verify the search URL works in a regular browser');
    console.log('  - Check src/linkedin_contract_find.js selectors against current LinkedIn DOM');
    await context.close();
    return;
  }

  // ── Apply config filters ───────────────────────────────────

  // Step 1: Role keyword match + exclude check
  let filtered = rawJobs.filter(j =>
    isEngineeringRole(j.title, j.company, j.description, config)
  );
  console.log(`After role filter: ${filtered.length} jobs`);

  // Step 2: Contract relevance check — keep jobs that mention contract/freelance terms
  let contractFiltered = filtered.filter(j => isContractRelevant(j));
  console.log(`After contract relevance filter: ${contractFiltered.length} jobs (${filtered.length - contractFiltered.length} non-contract removed)`);

  // If contract filter removed everything, fall back to just the role filter
  // (some companies don't explicitly say "contract" in the title/snippet but the URL filter ensures they are contract roles)
  if (contractFiltered.length === 0 && filtered.length > 0) {
    console.log('  Contract keyword filter removed all jobs — using role-only filter instead.');
    console.log('  (LinkedIn f_JT filter already ensures these are contract/temporary roles)');
    contractFiltered = filtered;
  }

  // Step 3: Location match
  const locationFiltered = contractFiltered.filter(j => locationMatchesTarget(j.location));
  console.log(`After location filter: ${locationFiltered.length} jobs`);

  // Step 4: Halal compliance filter
  let halalFiltered = locationFiltered;
  const halalCfg = config.strict_filter || {};
  if (halalCfg.strict_mode !== false && halalCfg.exclude_industries) {
    halalFiltered = locationFiltered.filter(j => {
      const jobText = `${j.title || ''} ${j.company || ''} ${j.description || ''}`.toLowerCase();
      return !halalCfg.exclude_industries.some(kw => jobText.includes(kw.toLowerCase()));
    });
    console.log(`After halal filter: ${halalFiltered.length} jobs`);
  }

  // ── Enrich descriptions ─────────────────────────────────────

  const missingDesc = halalFiltered.filter(j => !j.description || j.description.length < 50).length;
  if (missingDesc > 0) {
    console.log(`\n${missingDesc} jobs have minimal descriptions. Visiting pages for enrichment + rate detection...`);
    console.log('(LinkedIn contract jobs often show rates in the full description)\n');
    await enrichDescriptions(page, halalFiltered, Math.min(missingDesc, 15));
  }

  // ── Dedup against existing contract jobs ────────────────────

  let existing = [];
  if (existsSync(JOBS_FILE)) {
    try {
      existing = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
    } catch {
      console.log('Warning: Could not parse existing contract_jobs.json. Starting fresh.');
      existing = [];
    }
  }
  const existingIds = new Set(existing.map(j => j.id));

  const newJobs = halalFiltered.filter(j => !existingIds.has(j.id));
  console.log(`\nNew contract jobs (after dedup): ${newJobs.length}`);

  // ── Merge and save ─────────────────────────────────────────

  const merged = [...existing, ...newJobs];
  writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));

  console.log(`\n───────────────────────────────────────────────`);
  console.log(`Total contract pipeline: ${merged.length} jobs`);
  console.log(`New from LinkedIn Contract: ${newJobs.length} jobs`);
  console.log(`Saved to: data/contract_jobs.json`);

  // Quick stats
  const withRates = newJobs.filter(j => j.rate);
  const withIr35 = newJobs.filter(j => j.ir35);
  if (withRates.length > 0) {
    console.log(`  Jobs with detected rates: ${withRates.length}`);
  }
  if (withIr35.length > 0) {
    console.log(`  Jobs with IR35 status: ${withIr35.length}`);
  }

  if (newJobs.length > 0) {
    console.log(`\nSample new contract jobs:`);
    for (const j of newJobs.slice(0, 5)) {
      const loc = j.location || '(no location)';
      const rate = j.rate ? ` [${j.rate.currency}${j.rate.min}/${j.rate.unit}]` : '';
      const ir35 = j.ir35 ? ` (${j.ir35} IR35)` : '';
      console.log(`  - ${j.title} @ ${j.company} — ${loc}${rate}${ir35}`);
    }
    if (newJobs.length > 5) {
      console.log(`  ... and ${newJobs.length - 5} more`);
    }
  }

  // ── Cleanup ────────────────────────────────────────────────

  await context.close();

  console.log(`\nNext: node src/contract_score.js 10    (score contract jobs)`);
  console.log(`      node src/contract_status.js      (view contract pipeline)\n`);
}

main().catch(e => {
  console.error('\nFATAL ERROR:');
  console.error(e);
  process.exit(1);
});
