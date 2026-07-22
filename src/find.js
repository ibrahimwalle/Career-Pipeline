// find.js — Fetch jobs from Greenhouse, Lever, and Ashby ATS APIs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeRelevance, loadScrapeConfig, DAY_MS } from './shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');


// ─── ATS API Fetching ───────────────────────────────────────────

async function fetchGreenhouse(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.jobs || []).map(j => ({
      id: `gh_${slug}_${j.id}`,
      source: 'greenhouse',
      company: slug,
      title: j.title,
      location: j.location?.name || 'Unknown',
      url: j.absolute_url,
      description: j.content || '',
      departments: (j.departments || []).map(d => d.name),
      posted: j.updated_at,
      scrapedAt: new Date().toISOString(),
      status: 'new',
      score: null,
    }));
  } catch (e) {
    console.error(`  ✗ Greenhouse/${slug}: ${e.message}`);
    return [];
  }
}

async function fetchLever(slug) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data || []).map(j => ({
      id: `lv_${slug}_${j.id}`,
      source: 'lever',
      company: slug,
      title: j.text,
      location: j.categories?.location || 'Unknown',
      url: j.hostedUrl || j.applyUrl,
      description: j.descriptionPlain || j.description || '',
      departments: [j.categories?.team || j.categories?.department || 'Unknown'].filter(Boolean),
      posted: j.createdAt,
      scrapedAt: new Date().toISOString(),
      status: 'new',
      score: null,
    }));
  } catch (e) {
    console.error(`  ✗ Lever/${slug}: ${e.message}`);
    return [];
  }
}

async function fetchAshby(slug) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.jobs || []).map(j => ({
      id: `ab_${slug}_${j.id}`,
      source: 'ashby',
      company: slug,
      title: j.title,
      location: j.location || 'Unknown',
      url: j.jobUrl || `https://jobs.ashbyhq.com/${slug}/${j.id}`,
      description: j.descriptionPlain || j.description || '',
      departments: [j.department || 'Unknown'],
      posted: j.publishedAt || j.createdAt,
      scrapedAt: new Date().toISOString(),
      status: 'new',
      score: null,
    }));
  } catch (e) {
    console.error(`  ✗ Ashby/${slug}: ${e.message}`);
    return [];
  }
}

// ─── Filtering (reads scrape_config.json) ──────────────────────

function isEngineeringRole(job, config) {
  const title = (job.title || '').toLowerCase();
  const text = `${title} ${job.description || ''}`.toLowerCase();
  const keywords = config.role_keywords || [];
  const excludes = config.exclude_roles || [];
  // Only check excludes against the JOB TITLE, not the full description.
  // Descriptions often mention "work with account executives" etc.
  for (const kw of excludes) {
    if (kw.length <= 4) {
      if (new RegExp(`\\b${kw}\\b`, 'i').test(title)) return false;
    } else if (title.includes(kw)) {
      return false;
    }
  }
  // Role keywords checked against title + description
  return keywords.some(kw => text.includes(kw));
}

function isRemoteFriendly(job, config) {
  const loc = (job.location || '').toLowerCase();
  const text = `${loc} ${job.title || ''}`.toLowerCase();
  const prefs = config.remote_preference || {};
  const locs = config.locations || { include: ['remote', 'london'], exclude: [] };

  // Remote jobs bypass location exclusion
  const remoteTerms = ['remote', 'anywhere', 'distributed', 'work from home', 'wfh'];
  const isRemote = remoteTerms.some(r => text.includes(r));

  // Check inclusions first (preferred locations pass unconditionally)
  if (locs.include && locs.include.some(l => loc.includes(l) || text.includes(l))) return true;

  // Remote jobs are always OK
  if (isRemote) return true;

  // Location exclusion (only for non-remote jobs)
  if (locs.exclude && locs.exclude.some(l => text.includes(l))) return false;

  // If remote_only and no remote indicators, reject
  if (prefs.remote_only) return false;

  // If exclude_onsite and job says on-site without remote
  if (prefs.exclude_onsite) {
    const onsite = ['on-site', 'onsite', 'in-office', 'in office'];
    if (onsite.some(o => text.includes(o)) && !isRemote) return false;
  }

  return true;
}

function isMidOrSenior(job, config) {
  const title = job.title.toLowerCase();
  // Only exclude interns, graduates, entry-level
  const seniorityExcludes = ['intern', 'graduate', 'entry level', 'apprentice'];
  if (seniorityExcludes.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(title))) return false;
  return true;
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const companyConfig = JSON.parse(readFileSync(resolve(ROOT, 'companies.json'), 'utf-8'));
  const companies = companyConfig.companies;
  const scrapeCfg = loadScrapeConfig();

  // Load existing jobs for dedup
  let existing = [];
  if (existsSync(JOBS_FILE)) {
    existing = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  }
  const existingIds = new Set(existing.map(j => j.id));

  console.log(`\n  Searching ${companies.length} companies...`);
  console.log(`  Config: ${scrapeCfg.role_keywords.length} role keywords, ${scrapeCfg.exclude_roles.length} excluded`);
  console.log(`  Remote: ${scrapeCfg.remote_preference.remote_only ? 'only' : 'not required'}\n`);

  const allJobs = [];
  for (const c of companies) {
    process.stdout.write(`  ${c.name} (${c.source})... `);
    let jobs = [];
    if (c.source === 'greenhouse') jobs = await fetchGreenhouse(c.slug);
    else if (c.source === 'lever') jobs = await fetchLever(c.slug);
    else if (c.source === 'ashby') jobs = await fetchAshby(c.slug);

    // Apply filters from scrape_config.json
    const filtered = jobs.filter(j => {
      if (!isEngineeringRole(j, scrapeCfg)) return false;
      if (!isRemoteFriendly(j, scrapeCfg)) return false;
      if (!isMidOrSenior(j, scrapeCfg)) return false;
      // Freshness filter: skip jobs older than max_job_age_days
      const maxAge = scrapeCfg.max_job_age_days || null;
      if (maxAge && j.posted) {
        const daysOld = (Date.now() - new Date(j.posted)) / DAY_MS;
        if (daysOld > maxAge) return false;
      }
      // Halal compliance: exclude haram industries
      const halal = scrapeCfg.strict_filter || {};
      if (halal.strict_mode !== false && halal.exclude_industries) {
        const jobText = `${j.title || ''} ${j.company || ''} ${j.description || ''}`.toLowerCase();
        if (halal.exclude_industries.some(kw => jobText.includes(kw.toLowerCase()))) return false;
      }
      if (existingIds.has(j.id)) return false;
      return true;
    });
    // Pre-rank: add relevance hint before Claude scoring
    for (const j of filtered) {
      j.relevance = computeRelevance(j, scrapeCfg);
    }

    // Sort by relevance (descending), then apply per-company cap
    const cap = scrapeCfg.max_jobs_per_company;
    let capped = filtered.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
    if (cap) capped = capped.slice(0, cap);
    // Final sort within company cap: newest first
    capped.sort((a, b) => new Date(b.posted || 0) - new Date(a.posted || 0));

    console.log(`${capped.length} new matches`);
    allJobs.push(...capped);
  }

  // Merge: keep existing + new
  const merged = [...existing, ...allJobs];
  writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));

  console.log(`\n📊 Total: ${merged.length} jobs in pipeline (${allJobs.length} new this run)`);
  console.log(`📁 Saved to: data/jobs.json`);
  console.log(`\nNext: node src/score.js     (score jobs against your profile)`);
  console.log(`      node src/status.js    (view pipeline)`);
}

main().catch(e => { console.error(e); process.exit(1); });
