// find.js — Fetch jobs from Greenhouse, Lever, and Ashby ATS APIs
// Pure Node.js, zero dependencies. Saves results to jobs.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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

function loadScrapeConfig() {
  const cfgPath = resolve(ROOT, 'scrape_config.json');
  if (!existsSync(cfgPath)) {
    // Fallback defaults if config file missing
    return {
      role_keywords: ['software engineer', 'backend engineer', 'full stack', 'ai engineer', 'ml engineer', 'platform engineer', 'cloud engineer', 'data engineer', 'systems engineer', 'api engineer'],
      exclude_roles: ['junior', 'intern', 'graduate', 'entry level', 'apprentice', 'vp of', 'director', 'head of engineering', 'engineering manager', 'mobile engineer', 'ios', 'android', 'embedded', 'firmware', 'qa engineer', 'test engineer'],
      remote_preference: { remote_only: true, hybrid_ok: true, hybrid_locations: ['london', 'united kingdom', 'uk'], exclude_onsite: true },
      locations: { include: ['remote', 'london', 'united kingdom', 'uk', 'europe', 'anywhere', 'distributed'], exclude: [] },
      max_jobs_per_company: null,
    };
  }
  return JSON.parse(readFileSync(cfgPath, 'utf-8'));
}

function isEngineeringRole(job, config) {
  const text = `${job.title} ${job.description}`.toLowerCase();
  const keywords = config.role_keywords || [];
  const excludes = config.exclude_roles || [];
  // Reject if any exclude keyword matches
  if (excludes.some(kw => text.includes(kw))) return false;
  // Accept if any role keyword matches
  return keywords.some(kw => text.includes(kw));
}

function isRemoteFriendly(job, config) {
  const text = `${job.location} ${job.title} ${job.description}`.toLowerCase();
  const prefs = config.remote_preference || {};
  const locs = config.locations || { include: ['remote', 'london'], exclude: [] };

  // Check exclusions first
  if (locs.exclude && locs.exclude.some(l => text.includes(l))) return false;

  // Check inclusions
  if (locs.include && locs.include.some(l => text.includes(l))) return true;

  // If remote_only and no remote indicators, reject
  if (prefs.remote_only) {
    const remoteTerms = ['remote', 'anywhere', 'distributed', 'work from home', 'wfh'];
    if (!remoteTerms.some(r => text.includes(r))) return false;
  }

  // If exclude_onsite is set and job says on-site without remote
  if (prefs.exclude_onsite) {
    const onsite = ['on-site', 'onsite', 'in-office', 'in office'];
    const remoteTerms = ['remote', 'hybrid', 'anywhere', 'distributed'];
    if (onsite.some(o => text.includes(o)) && !remoteTerms.some(r => text.includes(r))) return false;
  }

  return true;
}

function isMidOrSenior(job, config) {
  const title = job.title.toLowerCase();
  const excludes = config.exclude_roles || [];
  // Use the exclude list from config + regex patterns
  const seniorityExcludes = ['junior', 'intern', 'graduate', 'entry.level', 'apprentice'];
  if (seniorityExcludes.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(title))) return false;
  const leadershipExcludes = ['vp of', 'vice president', 'chief ', 'director of engineering', 'head of engineering'];
  if (leadershipExcludes.some(kw => title.includes(kw))) return false;
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
    const filtered = jobs.filter(j =>
      isEngineeringRole(j, scrapeCfg) && isRemoteFriendly(j, scrapeCfg) && isMidOrSenior(j, scrapeCfg) && !existingIds.has(j.id)
    );
    // Apply per-company cap if set
    const capped = scrapeCfg.max_jobs_per_company ? filtered.slice(0, scrapeCfg.max_jobs_per_company) : filtered;
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
