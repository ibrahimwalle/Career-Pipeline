// hn_contract_find.js — Fetch contract/freelance job listings from Hacker News
// Uses the HN Algolia API (free, no auth required) to search:
//   1. "Ask HN: Freelancer? Seeking freelancer?" monthly threads (companies post gigs)
//   2. "Ask HN: Who wants to be hired?" monthly threads (reverse — search for hiring posts)
//   3. General HN comments mentioning contract/freelance hiring
//
// Converts matches to the standard contract job format and merges into data/contract_jobs.json
//
// Usage:
//   node src/hn_contract_find.js

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeRelevance, loadScrapeConfig, DAY_MS } from './shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'contract_jobs.json');
const CONFIG_PATH = resolve(ROOT, 'scrape_config.json');

// ─── Config ─────────────────────────────────────────────────────

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return {
      role_keywords: ['software engineer', 'backend', 'full stack', 'ai engineer', 'ml engineer', 'platform engineer', 'cloud engineer', 'data engineer'],
      exclude_roles: ['junior', 'intern', 'graduate', 'entry level', 'apprentice', 'vp of', 'director', 'qa engineer', 'test engineer'],
      locations: { include: ['remote', 'london', 'united kingdom', 'uk', 'europe', 'anywhere', 'distributed'], exclude: [] },
      max_jobs_per_company: null,
    };
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

// ─── Helpers ────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function generateId(source, text, index) {
  const hash = text.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
  return `hn_${source}_${hash}_${index}`;
}

// ─── Location Matching ──────────────────────────────────────────

const TARGET_LOCATIONS = [
  'remote', 'anywhere', 'distributed', 'work from home', 'wfh',
  'united kingdom', 'uk', 'london', 'england', 'manchester', 'edinburgh', 'birmingham', 'bristol', 'cambridge',
  'ireland', 'dublin',
  'germany', 'berlin', 'munich', 'frankfurt', 'hamburg',
  'netherlands', 'amsterdam', 'rotterdam',
  'france', 'paris',
  'sweden', 'stockholm',
  'denmark', 'copenhagen',
  'switzerland', 'zurich', 'geneva',
  'austria', 'vienna',
  'spain', 'barcelona', 'madrid',
  'portugal', 'lisbon',
  'netherlands', 'amsterdam',
  'poland', 'warsaw',
  'czech', 'prague',
  'estonia', 'tallinn',
  'europe', 'eu', 'emea',
  'uae', 'dubai', 'united arab emirates', 'abu dhabi',
  'saudi arabia', 'saudi', 'riyadh', 'jeddah',
  'qatar', 'doha',
  'kuwait',
  'bahrain', 'manama',
  'oman', 'muscat',
  'lebanon', 'beirut',
];

function locationMatches(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return TARGET_LOCATIONS.some(loc => lower.includes(loc));
}

function extractLocation(text) {
  if (!text) return 'Remote';
  const lower = text.toLowerCase();

  // Try to find explicit location mentions
  const locationPatterns = [
    /(?:location|based|timezone|remote)[:\s]+([^.\n]{3,50})/i,
    /(?:in|from)\s+(London|UK|United Kingdom|England|Manchester|Edinburgh|Birmingham|Bristol|Cambridge|Dublin|Berlin|Munich|Amsterdam|Paris|Barcelona|Madrid|Lisbon|Stockholm|Copenhagen|Zurich|Vienna|Prague|Tallinn|Warsaw|Dubai|Riyadh|Jeddah|Doha|Kuwait|Muscat|Beirut|Remote|Europe|EU|EMEA)(?:\s|,|\.|$)/i,
  ];

  for (const pat of locationPatterns) {
    const m = text.match(pat);
    if (m) return m[1].trim();
  }

  // If generic remote keywords found
  if (lower.includes('remote') || lower.includes('anywhere') || lower.includes('distributed') || lower.includes('wfh')) {
    return 'Remote';
  }

  return 'Remote (not specified)';
}

// ─── Rate Detection ─────────────────────────────────────────────

function extractRate(text) {
  if (!text) return null;

  // Hourly rates
  const hourlyMatch = text.match(/(?:\$|USD\s?|€|EUR\s?|£|GBP\s?)(\d{2,3})\s*(?:\/|per)\s*(?:hr|hour)/i);
  if (hourlyMatch) {
    const currency = text.includes('£') || text.toLowerCase().includes('gbp') ? 'GBP' :
                     text.includes('€') || text.toLowerCase().includes('eur') ? 'EUR' : 'USD';
    return { min: parseInt(hourlyMatch[1]), max: parseInt(hourlyMatch[1]), currency, unit: 'hour' };
  }

  // Day rates
  const dayMatch = text.match(/(?:\$|USD\s?|€|EUR\s?|£|GBP\s?)(\d{3,4})\s*(?:\/|per)\s*(?:day|d\b)/i);
  if (dayMatch) {
    const currency = text.includes('£') || text.toLowerCase().includes('gbp') ? 'GBP' :
                     text.includes('€') || text.toLowerCase().includes('eur') ? 'EUR' : 'USD';
    return { min: parseInt(dayMatch[1]), max: parseInt(dayMatch[1]), currency, unit: 'day' };
  }

  // Rate range: "$50-80/hr" or "£300-500/day"
  const rangeMatch = text.match(/(?:\$|USD\s?|€|EUR\s?|£|GBP\s?)(\d{2,4})\s*[-–to]+\s*(?:\$|€|£)?(\d{2,4})\s*(?:\/|per)\s*(hr|hour|d|day)/i);
  if (rangeMatch) {
    const currency = text.includes('£') || text.toLowerCase().includes('gbp') ? 'GBP' :
                     text.includes('€') || text.toLowerCase().includes('eur') ? 'EUR' : 'USD';
    const unit = rangeMatch[3].startsWith('h') ? 'hour' : 'day';
    return { min: parseInt(rangeMatch[1]), max: parseInt(rangeMatch[2]), currency, unit };
  }

  return null;
}

// ─── Role Filtering ─────────────────────────────────────────────

function isEngineeringRole(title, description, config) {
  const text = `${title} ${description || ''}`.toLowerCase();
  const keywords = config.role_keywords || [];
  const excludes = config.exclude_roles || [];

  if (excludes.some(kw => text.includes(kw))) return false;
  return keywords.some(kw => text.includes(kw));
}

// ─── Contract Keyword Filtering ─────────────────────────────────

function hasContractIndicators(text) {
  const lower = text.toLowerCase();
  const indicators = [
    'contract', 'freelance', 'freelancer', 'consultant', 'temporary',
    'hourly', 'project-based', 'project based', 'b2b', 'independent',
    'self-employed', 'gig', 'day rate', 'outside ir35', 'inside ir35',
    'short term', 'short-term', 'part time', 'part-time',
    '$/hr', '£/day', '€/hr', '$/hour', '£/hour', 'per hour', 'per day',
  ];
  return indicators.some(kw => lower.includes(kw));
}

function hasHiringIndicators(text) {
  const lower = text.toLowerCase();
  const indicators = [
    'hiring', 'looking for', 'seeking', 'need a', 'need an',
    'looking to hire', 'want to hire', 'we need', 'join us',
    'join our team', 'work with us', 'help us', 'we are looking',
    'we\'re looking', 'we\'re hiring', 'we are hiring', 'client',
    'opportunity', 'available', 'open role', 'open position',
    'apply here', 'email me', 'contact me', 'reach out', 'dm me',
    'please apply', 'send cv', 'send resume',
  ];
  return indicators.some(kw => lower.includes(kw));
}

// ─── Algolia API Call ───────────────────────────────────────────

async function searchHN(query, tags = 'comment', page = 0) {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const encodedQuery = encodeURIComponent(query);
  const encodedTags = encodeURIComponent(tags);

  const url = `https://hn.algolia.com/api/v1/search?query=${encodedQuery}&tags=${encodedTags}&hitsPerPage=200&page=${page}&numericFilters=created_at_i>${thirtyDaysAgo}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.error(`    HTTP ${res.status} for: ${url.slice(0, 100)}...`);
      return { hits: [], nbPages: 0 };
    }
    return await res.json();
  } catch (e) {
    console.error(`    X Algolia fetch failed: ${e.message}`);
    return { hits: [], nbPages: 0 };
  }
}

async function searchHNStories(query, page = 0) {
  return searchHN(query, 'story', page);
}

// ─── Fetch: "Freelancer? Seeking freelancer?" threads ───────────

async function fetchSeekingFreelancerThreads() {
  console.log('  Searching: "Ask HN: Freelancer? Seeking freelancer?" threads...');

  // Search for the monthly thread titles
  const result = await searchHNStories(
    'Freelancer Seeking freelancer',
    0
  );

  if (!result.hits || result.hits.length === 0) {
    console.log('    No matching threads found in past 30 days.');
    return [];
  }

  // Filter to just the actual monthly threads
  const threads = result.hits.filter(h =>
    h.title &&
    h.title.toLowerCase().includes('freelancer') &&
    h.title.toLowerCase().includes('seeking')
  );

  console.log(`    Found ${threads.length} "Seeking freelancer?" threads.`);
  return threads;
}

// ─── Fetch comments from a specific thread ──────────────────────

async function fetchThreadComments(storyId, page = 0) {
  // Search for comments on this specific story that contain hiring keywords
  const result = await searchHN(
    `hiring OR contract OR freelance OR looking for OR seeking OR remote`,
    `comment,story_${storyId}`,
    page
  );
  return result.hits || [];
}

// ─── Parse a comment into a contract job ────────────────────────

function parseCommentAsJob(comment, config, index) {
  const text = comment.comment_text || '';
  if (!text || text.length < 80) return null;

  // Must have contract indicators
  if (!hasContractIndicators(text)) return null;
  // Must have hiring indicators
  if (!hasHiringIndicators(text)) return null;

  // Extract company/author info
  const author = comment.author || 'Unknown';
  const authorText = `Posted by: ${author}`;

  // Try to extract company name from the text
  let company = author;
  const companyPatterns = [
    /(?:at|for|with)\s+([A-Z][a-zA-Z0-9\s]{2,30})(?:,|\.|\s+we|\s+and|\s+is|\s+are|\s+looking|\s+seeking)/,
    /^(?:We(?:'re)?\s+(?:at|from))\s+([A-Z][a-zA-Z0-9\s]{2,30})/i,
    /Company(?:\/Name)?[:\s]+([A-Za-z0-9\s]{2,30})(?:\n|,|\.)/i,
    /^([A-Z][a-zA-Z0-9\s]{2,30})\s+(?:is|are)\s+(?:looking|hiring|seeking)/m,
  ];
  for (const pat of companyPatterns) {
    const m = text.match(pat);
    if (m) {
      company = m[1].trim();
      break;
    }
  }

  // Extract role title
  let title = 'Contract Engineer';
  const titlePatterns = [
    /(?:hiring|seeking|looking for|need)\s+(?:a|an|senior|lead|principal|staff)?\s*([A-Za-z0-9\s/+#.-]{3,60})\s*(?:engineer|developer|architect|consultant|designer|manager|specialist)/i,
    /(?:role|position|job)[:\s]+([A-Za-z0-9\s/+#.-]{3,60})/i,
    /^(?:I(?:'m)?\s+(?:hiring|looking for|seeking))\s+(?:a|an)?\s*([A-Za-z0-9\s/+#.-]{3,60})/im,
  ];
  for (const pat of titlePatterns) {
    const m = text.match(pat);
    if (m) {
      title = m[1].trim() + ' (Contract via HN)';
      break;
    }
  }

  // Extract location
  const location = extractLocation(text);

  // Extract rate
  const rate = extractRate(text);

  // Build HN URL — link to the original comment
  const storyId = comment.story_id;
  const commentId = comment.objectID;
  const url = storyId
    ? `https://news.ycombinator.com/item?id=${commentId}`
    : `https://news.ycombinator.com/item?id=${comment.objectID}`;

  // Truncate description
  const description = text.substring(0, 2000);

  const posted = comment.created_at || new Date().toISOString();

  return {
    id: generateId('seeking', text, index),
    source: 'hackernews',
    type: 'contract',
    company,
    title,
    location,
    url,
    description,
    tags: ['hn', 'freelancer_thread', author],
    posted,
    scrapedAt: new Date().toISOString(),
    status: 'new',
    score: null,
    rate,
    hn_author: author,
    hn_story_id: storyId,
    hn_comment_id: commentId,
  };
}

// ─── Fetch: General HN comments with contract hiring keywords ───

async function fetchGeneralContractPosts() {
  console.log('  Searching HN comments for contract/freelance hiring...');

  // Multiple queries to maximize coverage
  const queries = [
    'hiring contract remote engineer',
    'freelance remote developer needed',
    'looking for contract developer remote',
    '"day rate" engineer remote',
    '"outside IR35" engineer',
    'contract software engineer remote',
  ];

  const allHits = [];
  const seenIds = new Set();

  for (const query of queries) {
    console.log(`    Query: "${query}"`);

    for (let page = 0; page < 2; page++) {
      const result = await searchHN(query, 'comment', page);
      if (!result.hits || result.hits.length === 0) break;

      let added = 0;
      for (const hit of result.hits) {
        if (!seenIds.has(hit.objectID)) {
          seenIds.add(hit.objectID);
          allHits.push(hit);
          added++;
        }
      }
      console.log(`      Page ${page}: ${added} new results`);

      if (result.nbPages <= page + 1) break;
      await sleep(500); // Rate limiting courtesy
    }
    await sleep(300);
  }

  console.log(`    Total unique matches: ${allHits.length}`);
  return allHits;
}

// ─── Also search the "Who wants to be hired?" thread ────────────

async function fetchWhoWantsToBeHired() {
  console.log('  Searching: "Ask HN: Who wants to be hired?" threads for hiring posts...');

  // Find the monthly "Who wants to be hired?" threads
  const result = await searchHNStories(
    '"Who wants to be hired"',
    0
  );

  if (!result.hits || result.hits.length === 0) {
    console.log('    No "Who wants to be hired" threads found in past 30 days.');
    return [];
  }

  const threads = result.hits.filter(h =>
    h.title &&
    h.title.toLowerCase().includes('who wants to be hired')
  );

  console.log(`    Found ${threads.length} "Who wants to be hired?" threads.`);

  // Search comments in these threads that mention "hiring" or "looking for"
  // (Some companies reply to freelancer posts saying they're hiring)
  const allComments = [];
  for (const thread of threads) {
    const comments = await fetchThreadComments(thread.objectID, 0);
    const hiringComments = comments.filter(c => {
      const text = (c.comment_text || '').toLowerCase();
      return (
        hasHiringIndicators(c.comment_text || '') &&
        (text.includes('contract') || text.includes('freelance') || text.includes('remote'))
      );
    });
    console.log(`      Thread ${thread.objectID}: ${hiringComments.length} hiring comments found`);
    allComments.push(...hiringComments);
    await sleep(500);
  }

  return allComments;
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const config = loadConfig();

  // Load existing contract jobs for dedup
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

  console.log(`\nHacker News Contract Job Search`);
  console.log(`  API: HN Algolia (free, no auth)`);
  console.log(`  Window: Past 30 days`);
  console.log(`  Target: UK, Europe, Gulf, Lebanon + Remote\n`);

  // ── Phase 1: "Freelancer? Seeking freelancer?" threads ─────

  const seekingThreads = await fetchSeekingFreelancerThreads();
  const allComments = [];

  for (const thread of seekingThreads) {
    console.log(`  Fetching comments from: "${thread.title}" (ID: ${thread.objectID})...`);
    const comments = await fetchThreadComments(thread.objectID, 0);
    console.log(`    Got ${comments.length} comments.`);
    allComments.push(...comments);
    await sleep(500);
  }

  // ── Phase 2: "Who wants to be hired?" threads ──────────────

  const whowtbComments = await fetchWhoWantsToBeHired();
  allComments.push(...whowtbComments);

  // ── Phase 3: General HN comments with contract hiring keywords ──

  const generalComments = await fetchGeneralContractPosts();
  allComments.push(...generalComments);

  // ── Deduplicate all comments by objectID ────────────────────

  const seenCommentIds = new Set();
  const uniqueComments = [];
  for (const c of allComments) {
    if (!seenCommentIds.has(c.objectID)) {
      seenCommentIds.add(c.objectID);
      uniqueComments.push(c);
    }
  }

  console.log(`\nTotal unique comments to process: ${uniqueComments.length}`);

  // ── Parse comments into contract jobs ───────────────────────

  const contractJobs = [];
  let skipped = 0;

  for (let i = 0; i < uniqueComments.length; i++) {
    const comment = uniqueComments[i];
    const text = comment.comment_text || '';
    if (!text || text.length < 80) { skipped++; continue; }

    // Quick pre-filter before detailed parsing
    if (!hasContractIndicators(text)) { skipped++; continue; }
    if (!hasHiringIndicators(text)) { skipped++; continue; }

    const job = parseCommentAsJob(comment, config, i);
    if (!job) { skipped++; continue; }

    // Apply role and location filters
    if (config.role_keywords && !isEngineeringRole(job.title, job.description, config)) { skipped++; continue; }
    if (!locationMatches(job.location)) { skipped++; continue; }

    // Halal compliance: exclude haram industries
    const halal = config.strict_filter || {};
    if (halal.strict_mode !== false && halal.exclude_industries) {
      const jobText = `${job.title || ''} ${job.company || ''} ${job.description || ''}`.toLowerCase();
      if (halal.exclude_industries.some(kw => jobText.includes(kw.toLowerCase()))) { skipped++; continue; }
    }

    job.relevance = computeRelevance(job, scrapeCfg);
    contractJobs.push(job);
  }

  console.log(`  Parsed ${contractJobs.length} contract jobs from HN (${skipped} skipped)`);

  // ── Dedup against existing and add ──────────────────────────

  const newJobs = contractJobs.filter(j => !existingIds.has(j.id));
  console.log(`  New jobs (after dedup with existing): ${newJobs.length}`);

  // ── Merge and save ─────────────────────────────────────────

  const merged = [...existing, ...newJobs];
  writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));

  console.log(`\n───────────────────────────────────────────────`);
  console.log(`Total contract pipeline: ${merged.length} jobs`);
  console.log(`New from Hacker News: ${newJobs.length} jobs`);
  console.log(`Saved to: data/contract_jobs.json`);

  if (newJobs.length > 0) {
    console.log(`\nSample HN contract listings:`);
    for (const j of newJobs.slice(0, 5)) {
      const rate = j.rate ? ` [${j.rate.currency}${j.rate.min}/${j.rate.unit}]` : '';
      console.log(`  - ${j.title} @ ${j.company} — ${j.location}${rate}`);
      console.log(`    ${j.url}`);
    }
  } else {
    console.log('\n  (No new listings — all found were duplicates of existing jobs)');
  }

  // Quick stats for debugging
  if (contractJobs.length > 0) {
    const withRates = contractJobs.filter(j => j.rate);
    console.log(`\n  Quality stats:`);
    console.log(`    With detected rates: ${withRates.length}/${contractJobs.length}`);
    console.log(`    Sources: threads=${seekingThreads.length}, whowtb=${whowtbComments.length}, general=${generalComments.length}`);
  }

  console.log(`\nNext: node src/contract_score.js 10`);
}

main().catch(e => { console.error(e); process.exit(1); });
