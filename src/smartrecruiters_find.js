// smartrecruiters_find.js — Fetch jobs from SmartRecruiters Job Board API
// Pure Node.js, zero dependencies. Saves results to data/jobs.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeRelevance, loadScrapeConfig, DAY_MS } from './shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');

// SmartRecruiters companies to scrape (companyId as used in the API URL)
const SMART_COMPANIES = [
  { id: 'Uber', name: 'Uber' },
  { id: 'Spotify', name: 'Spotify' },
  { id: 'Zalando', name: 'Zalando' },
  { id: 'Bolt', name: 'Bolt' },
  { id: 'N26', name: 'N26' },
  { id: 'Klarna', name: 'Klarna' },
  { id: 'Wise', name: 'Wise' },
  { id: 'Revolut', name: 'Revolut' },
  { id: 'Monzo', name: 'Monzo' },
  { id: 'Adevinta', name: 'Adevinta' },
  { id: 'Pleo', name: 'Pleo' },
];

// ─── SmartRecruiters API Fetching ──────────────────────────────────

async function fetchSmartRecruiters(company) {
  const url = `https://api.smartrecruiters.com/v1/companies/${company.id}/postings?limit=100`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.content || []).map(j => {
      // Build description from department, employment type, and custom fields
      const customFields = (j.customField || [])
        .map(f => f.valueLabel || f.valueId || '')
        .filter(Boolean);
      const descParts = [
        j.department?.label,
        j.typeOfEmployment,
        ...customFields,
      ].filter(Boolean);

      return {
        id: `sr_${company.id}_${j.id}`,
        source: 'smartrecruiters',
        company: j.company?.name || company.name,
        title: j.name || '',
        location: [j.location?.city, j.location?.country].filter(Boolean).join(', ') || 'Unknown',
        url: j.externalUrl || `https://jobs.smartrecruiters.com/${company.id}/${j.id}`,
        description: descParts.join(' | '),
        departments: [j.department?.label || 'Unknown'].filter(Boolean),
        typeOfEmployment: j.typeOfEmployment || '',
        refNumber: j.refNumber || '',
        posted: j.releasedDate,
        scrapedAt: new Date().toISOString(),
        status: 'new',
        score: null,
      };
    });
  } catch (e) {
    console.error(`  X SmartRecruiters/${company.name}: ${e.message}`);
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

  console.log(`\n  Searching ${SMART_COMPANIES.length} SmartRecruiters companies...`);
  console.log(`  Config: ${scrapeCfg.role_keywords.length} role keywords, ${scrapeCfg.exclude_roles.length} excluded`);
  console.log(`  Remote: ${scrapeCfg.remote_preference.remote_only ? 'only' : 'not required'}`);
  if (scrapeCfg.strict_filter?.strict_mode) {
    console.log(`  Halal: ${scrapeCfg.strict_filter.exclude_industries.length} excluded industries (strict mode)\n`);
  } else {
    console.log('');
  }

  const allJobs = [];
  for (const c of SMART_COMPANIES) {
    process.stdout.write(`  ${c.name} (smartrecruiters)... `);
    let jobs = await fetchSmartRecruiters(c);

    // Apply filters from scrape_config.json
    const filtered = jobs.filter(j => {
      if (!isEngineeringRole(j, scrapeCfg)) return false;
      if (!isRemoteFriendly(j, scrapeCfg)) return false;
      if (!isMidOrSenior(j, scrapeCfg)) return false;
      if (!isHalalCompliant(j, scrapeCfg)) return false;
      // Freshness filter: skip jobs older than max_job_age_days
      const maxAge = scrapeCfg.max_job_age_days || null;
      if (maxAge && j.posted) {
        const daysOld = (Date.now() - new Date(j.posted)) / DAY_MS;
        if (daysOld > maxAge) return false;
      }
      if (existingIds.has(j.id)) return false;
      return true;
    });
    // Apply per-company cap: sort by date (newest first), then take top N
    const cap = scrapeCfg.max_jobs_per_company;
    let capped = filtered;
    if (cap) {
      capped = filtered
        .sort((a, b) => new Date(b.posted || 0) - new Date(a.posted || 0))
        .slice(0, cap);
    }
    console.log(`${capped.length} new matches`);
    allJobs.push(...capped);
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
