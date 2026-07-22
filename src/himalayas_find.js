// himalayas_find.js — Fetch remote jobs from Himalayas.app public API
// Free API, no auth, no key, no Playwright needed.
// Search endpoint: https://himalayas.app/jobs/api/search
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { computeRelevance, loadScrapeConfig, DAY_MS } from './shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');

const BASE = 'https://himalayas.app/jobs/api/search';
const MAX_PAGES = 3;
const DELAY_MS = 600; // polite delay between requests

// ─── Helpers ────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Stable ID from the job's unique guid URL */
function jobId(guid) {
  return 'him_' + createHash('md5').update(guid).digest('hex').slice(0, 12);
}

// ─── Normalize to standard job format ───────────────────────────────

function normalize(job) {
  const locs = (job.locationRestrictions || []);
  const location = locs.length > 0
    ? locs.map(l => l.name).join(', ')
    : 'Remote (Worldwide)';

  return {
    id: jobId(job.guid),
    source: 'himalayas',
    company: job.companyName || 'Unknown',
    title: job.title || '',
    location,
    url: job.applicationLink || job.guid || '',
    description: job.description || '',
    posted: new Date(job.pubDate).toISOString(),
    scrapedAt: new Date().toISOString(),
    status: 'new',
    score: null,
  };
}

// ─── Fetch one search query (paginated) ─────────────────────────────

async function fetchSearch(params, label) {
  const url = new URL(BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  const allJobs = [];
  let rateLimitRetries = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    url.searchParams.set('page', String(page));
    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        if (res.status === 429) {
          if (++rateLimitRetries > 3) {
            console.error(`    Too many rate limits, skipping remaining pages`);
            break;
          }
          console.error(`    Rate limited, waiting 65s...`);
          await sleep(65000);
          page--; // retry same page (for-loop will increment it back)
          continue;
        }
        if (page === 1) {
          console.error(`  X ${label} p${page}: HTTP ${res.status}`);
        }
        break;
      }
      const data = await res.json();
      const jobs = (data.jobs || []).map(normalize);
      allJobs.push(...jobs);

      // Stop if last page (fewer than 20 results)
      if (!data.jobs || data.jobs.length < 20) break;

      await sleep(DELAY_MS);
    } catch (e) {
      if (page === 1) console.error(`  X ${label} p${page}: ${e.message}`);
      break;
    }
  }
  return allJobs;
}

// ─── Filtering (mirrors remotive_find.js / find.js patterns) ────────

function isEngineeringRole(job, config) {
  const text = `${job.title} ${job.description}`.toLowerCase();
  const keywords = config.role_keywords || [];
  const excludes = config.exclude_roles || [];
  for (const kw of excludes) {
    if (kw.length <= 4) {
      if (new RegExp(`\\b${kw}\\b`).test(text)) return false;
    } else if (text.includes(kw)) {
      return false;
    }
  }
  return keywords.some(kw => text.includes(kw));
}

function isRemoteFriendly(job, config) {
  const text = `${job.location} ${job.title} ${job.description}`.toLowerCase();
  const prefs = config.remote_preference || {};
  const locs = config.locations || { include: ['remote', 'london'], exclude: [] };

  if (locs.exclude && locs.exclude.some(l => text.includes(l))) return false;
  if (locs.include && locs.include.some(l => text.includes(l))) return true;

  if (prefs.remote_only) {
    const remoteTerms = ['remote', 'anywhere', 'distributed', 'work from home', 'wfh'];
    if (!remoteTerms.some(r => text.includes(r))) return false;
  }

  if (prefs.exclude_onsite) {
    const onsite = ['on-site', 'onsite', 'in-office', 'in office'];
    const remoteTerms = ['remote', 'hybrid', 'anywhere', 'distributed'];
    if (onsite.some(o => text.includes(o)) && !remoteTerms.some(r => text.includes(r))) return false;
  }

  return true;
}

function isMidOrSenior(job, config) {
  const title = job.title.toLowerCase();
  const seniorityExcludes = ['junior', 'intern', 'graduate', 'entry.level', 'apprentice'];
  if (seniorityExcludes.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(title))) return false;
  const leadershipExcludes = ['vp of', 'vice president', 'chief ', 'director of engineering', 'head of engineering'];
  if (leadershipExcludes.some(kw => title.includes(kw))) return false;
  return true;
}

function isHalalCompliant(job, config) {
  const halal = config.strict_filter;
  if (!halal || !halal.strict_mode) return true;
  const excludeIndustries = halal.exclude_industries || [];
  if (excludeIndustries.length === 0) return true;
  const text = `${job.company} ${job.title} ${job.description}`.toLowerCase();
  for (const industry of excludeIndustries) {
    if (text.includes(industry.toLowerCase())) return false;
  }
  return true;
}

// ─── Query builder ──────────────────────────────────────────────────

const SEARCH_QUERIES = [
  'software engineer',
  'backend engineer',
  'ai engineer',
  'platform engineer',
  'data engineer',
  'integration engineer',
  'solutions engineer',
  'devops',
];

const COUNTRIES = [
  { name: 'United Kingdom', code: 'GB' },
  { name: 'Spain', code: 'ES' },
  { name: 'Germany', code: 'DE' },
  { name: 'Netherlands', code: 'NL' },
  { name: 'United Arab Emirates', code: 'AE' },
  { name: 'Saudi Arabia', code: 'SA' },
  { name: 'Lebanon', code: 'LB' },
];

const EMPLOYMENT_TYPES = [
  { param: 'Full Time', label: 'full_time' },
  { param: 'Contractor', label: 'contract' },
];

  // Only essential queries — 4 roles × 2 emp types = 8 worldwide
  // + 4 roles × 4 countries × 2 emp types = 32 country-specific = 40 total
  const essentialQueries = ['software engineer', 'backend engineer', 'ai engineer', 'platform engineer'];
  const essentialCountries = [
    { name: 'United Kingdom', code: 'GB' },
    { name: 'Spain', code: 'ES' },
    { name: 'Germany', code: 'DE' },
    { name: 'United Arab Emirates', code: 'AE' },
  ];

function buildSearchTasks() {
  const tasks = [];

  // Worldwide searches
  for (const q of essentialQueries) {
    for (const emp of EMPLOYMENT_TYPES) {
      tasks.push({
        params: { q, worldwide: 'true', employment_type: emp.param, sort: 'recent' },
        label: `"${q}" worldwide ${emp.label}`,
      });
    }
  }

  // Country-specific — only top 4 countries
  for (const q of essentialQueries) {
    for (const country of essentialCountries) {
      for (const emp of EMPLOYMENT_TYPES) {
        tasks.push({
          params: { q, country: country.name, employment_type: emp.param, sort: 'recent' },
          label: `"${q}" ${country.name} ${emp.label}`,
        });
      }
    }
  }

  return tasks;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const scrapeCfg = loadScrapeConfig();

  // Load existing jobs for dedup
  let existing = [];
  if (existsSync(JOBS_FILE)) {
    existing = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  }
  const existingIds = new Set(existing.map(j => j.id));

  console.log(`\n  Himalayas.app — Remote job board (public API, no auth)`);
  console.log(`  Config: ${scrapeCfg.role_keywords.length} role keywords, ${scrapeCfg.exclude_roles.length} excluded`);
  console.log(`  Remote: ${scrapeCfg.remote_preference.remote_only ? 'only' : 'not required'}`);
  if (scrapeCfg.strict_filter?.strict_mode) {
    console.log(`  Halal: ${scrapeCfg.strict_filter.exclude_industries.length} excluded industries (strict mode)`);
  }

  const tasks = buildSearchTasks();
  console.log(`\n  Running ${tasks.length} queries (4 at a time, ${MAX_PAGES} pages max each)...\n`);

  // ── Fetch in parallel batches of 4 ──
  const seen = new Set();
  const rawJobs = [];
  let completed = 0;
  const BATCH = 4;

  for (let i = 0; i < tasks.length; i += BATCH) {
    const batch = tasks.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(task => fetchSearch(task.params, task.label)));
    for (let r = 0; r < batch.length; r++) {
      const jobs = results[r];
      const task = batch[r];
      let added = 0;
      for (const j of jobs) {
        if (!seen.has(j.id)) { seen.add(j.id); rawJobs.push(j); added++; }
      }
      completed++;
      process.stdout.write(`  [${String(completed).padStart(3,' ')}/${tasks.length}] ${task.label}... ${jobs.length} fetched, ${added} new\n`);
    }
    if (i + BATCH < tasks.length) await sleep(DELAY_MS);
  }

  console.log(`\n  Total unique raw jobs fetched: ${rawJobs.length}`);

  // ── Apply filters ──
  const maxAge = scrapeCfg.max_job_age_days || null;

  const filtered = rawJobs.filter(j => {
    if (!isEngineeringRole(j, scrapeCfg)) return false;
    if (!isRemoteFriendly(j, scrapeCfg)) return false;
    if (!isMidOrSenior(j, scrapeCfg)) return false;
    if (!isHalalCompliant(j, scrapeCfg)) return false;
    if (maxAge && j.posted) {
      const daysOld = (Date.now() - new Date(j.posted)) / DAY_MS;
      if (daysOld > maxAge) return false;
    }
    if (existingIds.has(j.id)) return false;
    return true;
  });

  console.log(`  After filtering: ${filtered.length} new matches`);

  // ── Compute relevance & sort ──
  for (const j of filtered) {
    j.relevance = computeRelevance(j, scrapeCfg);
  }

  const cap = scrapeCfg.max_jobs_per_company;
  let capped = filtered.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
  if (cap) capped = capped.slice(0, cap);
  // Final sort: newest first
  capped.sort((a, b) => new Date(b.posted || 0) - new Date(a.posted || 0));

  // ── Merge & save ──
  const merged = [...existing, ...capped];
  writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));

  console.log(`\n  Himalayas: ${merged.length} total jobs in pipeline (${capped.length} new this run)`);
  console.log(`  Saved to: data/jobs.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
