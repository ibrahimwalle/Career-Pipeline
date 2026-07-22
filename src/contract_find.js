// contract_find.js — Fetch contract/freelance jobs from platforms with RSS/API access
// RemoteOK, WeWorkRemotely, WorkingNomads, Arc.dev, Contra
// Saves to data/contract_jobs.json alongside the main jobs.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeRelevance, loadScrapeConfig, DAY_MS } from './shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'contract_jobs.json');

// ─── Contract Job Sources ──────────────────────────────────────

async function fetchRemoteOK() {
  // RemoteOK has a free JSON API: https://remoteok.com/api
  try {
    const res = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // First element is metadata, rest are jobs
    return data.slice(1).map(j => ({
      id: `rok_${j.id || j.slug}`,
      source: 'remoteok',
      type: 'contract',
      company: j.company || 'Unknown',
      title: j.position || '',
      location: j.location || 'Remote',
      url: j.url || `https://remoteok.com/remote-jobs/${j.slug}`,
      description: j.description || '',
      tags: j.tags || [],
      posted: new Date(j.epoch * 1000).toISOString(),
      scrapedAt: new Date().toISOString(),
      status: 'new',
      score: null,
      rate: j.salary_min ? { min: j.salary_min, max: j.salary_max, currency: 'USD' } : null,
    }));
  } catch (e) {
    console.error(`  X RemoteOK: ${e.message}`);
    return [];
  }
}

async function fetchWeWorkRemotely() {
  // Weworkremotely has RSS: https://weworkremotely.com/categories/remote-programming-jobs.rss
  try {
    const res = await fetch('https://weworkremotely.com/categories/remote-programming-jobs.rss');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const jobs = [];
    // Simple RSS parsing (no deps)
    const items = xml.split('<item>').slice(1);
    for (const item of items) {
      const title = extractXml(item, 'title');
      const link = extractXml(item, 'link');
      const desc = extractXml(item, 'description');
      const pubDate = extractXml(item, 'pubDate');
      const company = extractXml(item, 'title')?.split(':')[0] || '';
      if (title && link) {
        jobs.push({
          id: `wwr_${link.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}`,
          source: 'weworkremotely',
          type: 'contract',
          company: company,
          title: title.includes(':') ? title.split(':').slice(1).join(':').trim() : title,
          location: 'Remote',
          url: link,
          description: stripHtml(desc || ''),
          tags: [],
          posted: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
          scrapedAt: new Date().toISOString(),
          status: 'new',
          score: null,
        });
      }
    }
    return jobs;
  } catch (e) {
    console.error(`  X WeWorkRemotely: ${e.message}`);
    return [];
  }
}

async function fetchWorkingNomads() {
  // WorkingNomads has a JSON-style output
  // Their jobs page is scrapable via their API endpoint
  try {
    const res = await fetch('https://www.workingnomads.com/jobsapi/job/_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: { bool: { must: [{ term: { category: 'development' } }] } },
        size: 100,
        sort: [{ pub_date: 'desc' }]
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.hits?.hits || []).map(h => {
      const j = h._source || h;
      return {
        id: `wn_${j.url?.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40) || Math.random().toString(36)}`,
        source: 'workingnomads',
        type: 'contract',
        company: j.company_name || 'Unknown',
        title: j.title || '',
        location: j.location || 'Remote',
        url: j.url || j.apply_url || '',
        description: j.description || j.preview || '',
        tags: j.tags || [],
        posted: j.pub_date || new Date().toISOString(),
        scrapedAt: new Date().toISOString(),
        status: 'new',
        score: null,
      };
    });
  } catch (e) {
    console.error(`  X WorkingNomads: ${e.message}`);
    return [];
  }
}

async function fetchArcDev() {
  // Arc.dev has a public API for job listings
  try {
    const res = await fetch('https://arc.dev/api/feed/public/v1/jobs?category=engineering&remote=true&employment_type_ids=4', {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data?.jobs || data || []).map(j => ({
      id: `arc_${j.id || j.slug}`,
      source: 'arc_dev',
      type: 'contract',
      company: j.company_name || j.company?.name || 'Unknown',
      title: j.title || j.name || '',
      location: j.location || 'Remote',
      url: j.url || `https://arc.dev/job/${j.slug}`,
      description: j.description || j.summary || '',
      tags: j.tags || j.skills || [],
      posted: j.published_at || j.created_at || new Date().toISOString(),
      scrapedAt: new Date().toISOString(),
      status: 'new',
      score: null,
      rate: j.salary_range ? { min: j.salary_range.min, max: j.salary_range.max, currency: j.salary_currency || 'USD' } : null,
    }));
  } catch (e) {
    console.error(`  X Arc.dev: ${e.message}`);
    return [];
  }
}

async function fetchContra() {
  // Contra has a public page but no API — scrape the job listing page
  try {
    const res = await fetch('https://contra.com/jobs/category/software-engineering?remote=true', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Look for embedded JSON data in script tags
    const jsonMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/);
    const jobs = [];
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        const listings = data?.props?.pageProps?.initialJobs || data?.props?.pageProps?.jobs || [];
        for (const j of listings) {
          jobs.push({
            id: `contra_${j.id || j._id}`,
            source: 'contra',
            type: 'contract',
            company: j.company?.name || j.companyName || 'Unknown',
            title: j.title || j.name || '',
            location: j.location || 'Remote',
            url: j.url || `https://contra.com/job/${j.slug || j.id}`,
            description: j.description || j.summary || '',
            tags: j.skills || j.tags || [],
            posted: j.createdAt || j.publishedAt || new Date().toISOString(),
            scrapedAt: new Date().toISOString(),
            status: 'new',
            score: null,
            rate: j.budget ? { min: j.budget.min, max: j.budget.max, currency: j.budget.currency || 'USD' } : null,
          });
        }
      } catch {}
    }
    return jobs;
  } catch (e) {
    console.error(`  X Contra: ${e.message}`);
    return [];
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function extractXml(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`, 's'));
  if (match) return match[1];
  const match2 = xml.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's'));
  return match2 ? match2[1] : '';
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Filters ─────────────────────────────────────────────────

const ROLE_KEYWORDS = [
  'software engineer', 'backend', 'full stack', 'fullstack', 'ai engineer',
  'ml engineer', 'machine learning', 'platform engineer', 'infrastructure',
  'cloud engineer', 'solutions engineer', 'integration', 'data engineer',
  'systems engineer', 'python', 'javascript', 'typescript', 'fastapi',
  'react', 'node', 'api developer', 'devops', 'gcp', 'aws',
];

function isEngineeringRole(job) {
  const text = `${job.title} ${job.description}`.toLowerCase();
  return ROLE_KEYWORDS.some(kw => text.includes(kw));
}

function isContractRole(job) {
  const text = `${job.title} ${job.description}`.toLowerCase();
  const contractKeywords = [
    'contract', 'freelance', 'freelancer', 'consultant', 'temporary',
    'part-time', 'part time', 'hourly', 'project-based', 'project based',
    'b2b', 'independent', 'self-employed', 'gig',
  ];
  // RemoteOK and WeWorkRemotely are mostly remote/ft so cast a wider net
  // But tag what's explicitly contract
  const isExplicit = contractKeywords.some(kw => text.includes(kw));
  job.is_explicit_contract = isExplicit;
  return true; // Keep all remote jobs, tag the ones explicitly contract
}

function isRelevantRate(job) {
  if (!job.rate) return true; // No rate info, keep it
  const dayRate = job.rate.unit === 'day' ? job.rate.min :
                  job.rate.unit === 'hour' ? job.rate.min * 8 : // Approximate
                  job.rate.min / 20; // Monthly → daily approx
  const currency = job.rate.currency;
  if (currency === 'GBP' && dayRate < 200) return false;
  if (currency === 'USD' && dayRate < 250) return false;
  if (currency === 'EUR' && dayRate < 225) return false;
  return true;
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  // Load max_job_age_days from scrape config
  let scrapeCfg = {};
  const cfgPath = resolve(ROOT, 'scrape_config.json');
  if (existsSync(cfgPath)) {
    try { scrapeCfg = JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch {}
  }

  let existing = [];
  if (existsSync(JOBS_FILE)) {
    existing = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  }
  const existingIds = new Set(existing.map(j => j.id));

  console.log(`\nSearching contract/freelance platforms...\n`);

  const fetchers = [
    { name: 'RemoteOK', fn: fetchRemoteOK },
    { name: 'WeWorkRemotely', fn: fetchWeWorkRemotely },
    { name: 'Arc.dev', fn: fetchArcDev },
    { name: 'WorkingNomads', fn: fetchWorkingNomads },
    { name: 'Contra', fn: fetchContra },
  ];

  const allJobs = [];
  for (const { name, fn } of fetchers) {
    process.stdout.write(`  ${name}... `);
    try {
      let jobs = await fn();
      const filtered = jobs.filter(j => {
        if (!isEngineeringRole(j)) return false;
        if (!isContractRole(j)) return false;
        if (!isRelevantRate(j)) return false;
        // Halal compliance: exclude haram industries
        const halal = scrapeCfg.strict_filter || {};
        if (halal.strict_mode !== false && halal.exclude_industries) {
          const jobText = `${j.title || ''} ${j.company || ''} ${j.description || ''}`.toLowerCase();
          if (halal.exclude_industries.some(kw => jobText.includes(kw.toLowerCase()))) return false;
        }
        // Freshness filter: skip jobs older than max_job_age_days
        const maxAge = scrapeCfg.max_job_age_days || null;
        if (maxAge && j.posted) {
          const daysOld = (Date.now() - new Date(j.posted)) / DAY_MS;
          if (daysOld > maxAge) return false;
        }
        if (existingIds.has(j.id)) return false;
        return true;
      });
      console.log(`${filtered.length} new matches`);
      allJobs.push(...filtered);
    } catch (e) {
      console.log(`failed: ${e.message}`);
    }
  }

  // Merge
  const merged = [...existing, ...allJobs];
  writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));

  const explicit = allJobs.filter(j => j.is_explicit_contract);
  console.log(`\n  Total contract jobs: ${merged.length} (${allJobs.length} new)`);
  console.log(`  Explicitly contract/freelance: ${explicit.length}`);
  console.log(`  Saved to: data/contract_jobs.json\n`);
  console.log(`Next: node src/contract_score.js 10`);
}

main().catch(e => { console.error(e); process.exit(1); });
