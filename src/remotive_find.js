// remotive_find.js — Fetch remote jobs from Remotive + Arbeitnow APIs
// Pure Node.js, zero dependencies. Saves results to data/jobs.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeRelevance, loadScrapeConfig, DAY_MS } from './shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');

// ─── Source API Fetching ───────────────────────────────────────────

async function fetchRemotive() {
  const url = 'https://remotive.com/api/remote-jobs?category=software-dev';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.jobs || []).map(j => ({
      id: `rem_${j.id}`,
      source: 'remotive',
      company: j.company_name || 'Unknown',
      title: j.title || '',
      location: j.candidate_required_location || 'Remote',
      url: j.url || '',
      description: j.description || '',
      tags: j.tags || [],
      jobType: j.job_type || '',
      salary: j.salary || null,
      posted: j.publication_date,
      scrapedAt: new Date().toISOString(),
      status: 'new',
      score: null,
    }));
  } catch (e) {
    console.error(`  X Remotive: ${e.message}`);
    return [];
  }
}

async function fetchArbeitnow() {
  const url = 'https://www.arbeitnow.com/api/job-board-api';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(j => ({
      id: `arb_${j.slug}`,
      source: 'arbeitnow',
      company: j.company_name || 'Unknown',
      title: j.title || '',
      location: j.location || 'Remote',
      url: j.url || '',
      description: j.description || '',
      tags: j.tags || [],
      jobTypes: j.job_types || [],
      posted: j.created_at,
      scrapedAt: new Date().toISOString(),
      status: 'new',
      score: null,
    }));
  } catch (e) {
    console.error(`  X Arbeitnow: ${e.message}`);
    return [];
  }
}

// ─── Filtering (reads scrape_config.json) ──────────────────────────


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

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const scrapeCfg = loadScrapeConfig();

  // Load existing jobs for dedup
  let existing = [];
  if (existsSync(JOBS_FILE)) {
    existing = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  }
  const existingIds = new Set(existing.map(j => j.id));

  console.log(`\n  Searching remote job platforms (Remotive + Arbeitnow)...`);
  console.log(`  Config: ${scrapeCfg.role_keywords.length} role keywords, ${scrapeCfg.exclude_roles.length} excluded`);
  console.log(`  Remote: ${scrapeCfg.remote_preference.remote_only ? 'only' : 'not required'}`);
  if (scrapeCfg.strict_filter?.strict_mode) {
    console.log(`  Halal: ${scrapeCfg.strict_filter.exclude_industries.length} excluded industries (strict mode)\n`);
  } else {
    console.log('');
  }

  const allJobs = [];

  // ── Remotive ──
  process.stdout.write('  Remotive (software-dev)... ');
  try {
    let jobs = await fetchRemotive();
    const filtered = jobs.filter(j => {
      if (!isEngineeringRole(j, scrapeCfg)) return false;
      if (!isRemoteFriendly(j, scrapeCfg)) return false;
      if (!isMidOrSenior(j, scrapeCfg)) return false;
      if (!isHalalCompliant(j, scrapeCfg)) return false;
      const maxAge = scrapeCfg.max_job_age_days || null;
      if (maxAge && j.posted) {
        const daysOld = (Date.now() - new Date(j.posted)) / DAY_MS;
        if (daysOld > maxAge) return false;
      }
      if (existingIds.has(j.id)) return false;
      return true;
    });
    // Apply per-company cap (use same cap for the entire source)
    const cap = scrapeCfg.max_jobs_per_company;
    let capped = filtered;
    if (cap) {
      capped = filtered
        .sort((a, b) => new Date(b.posted || 0) - new Date(a.posted || 0))
        .slice(0, cap);
    }
    console.log(`${capped.length} new matches`);
    allJobs.push(...capped);
  } catch (e) {
    console.log(`failed: ${e.message}`);
  }

  // ── Arbeitnow ──
  process.stdout.write('  Arbeitnow... ');
  try {
    let jobs = await fetchArbeitnow();
    const filtered = jobs.filter(j => {
      if (!isEngineeringRole(j, scrapeCfg)) return false;
      if (!isRemoteFriendly(j, scrapeCfg)) return false;
      if (!isMidOrSenior(j, scrapeCfg)) return false;
      if (!isHalalCompliant(j, scrapeCfg)) return false;
      const maxAge = scrapeCfg.max_job_age_days || null;
      if (maxAge && j.posted) {
        const daysOld = (Date.now() - new Date(j.posted)) / DAY_MS;
        if (daysOld > maxAge) return false;
      }
      if (existingIds.has(j.id)) return false;
      return true;
    });
    const cap = scrapeCfg.max_jobs_per_company;
    let capped = filtered;
    if (cap) {
      capped = filtered
        .sort((a, b) => new Date(b.posted || 0) - new Date(a.posted || 0))
        .slice(0, cap);
    }
    console.log(`${capped.length} new matches`);
    allJobs.push(...capped);
  } catch (e) {
    console.log(`failed: ${e.message}`);
  }

  // Merge: keep existing + new
  const merged = [...existing, ...allJobs];
  writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));

  console.log(`\n  Total: ${merged.length} jobs in pipeline (${allJobs.length} new this run)`);
  console.log(`  Saved to: data/jobs.json`);
  console.log(`\nNext: node src/score.js     (score jobs against your profile)`);
  console.log(`      node src/status.js    (view pipeline)`);
}

main().catch(e => { console.error(e); process.exit(1); });
