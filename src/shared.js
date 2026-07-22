// shared.js — Common utilities for all scrapers
export const DAY_MS = 86400000;

// Pre-rank: fast relevance score before Claude scoring (0-100). No API calls.
export function computeRelevance(job, config) {
  let score = 50;
  const text = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  const loc = (job.location || '').toLowerCase();

  // 1. Role keyword matches (up to +25)
  const keywords = config.role_keywords || [];
  let kwHits = 0;
  for (const kw of keywords) if (text.includes(kw)) kwHits++;
  score += Math.min(kwHits * 4, 25);

  // 2. Title quality
  const title = (job.title || '').toLowerCase();
  if (/\b(senior|lead|principal|staff|architect|head)\b/.test(title)) score += 15;
  else if (/\b(mid|associate|junior)\b/.test(title)) score -= 5;

  // 3. Location bonus (tiered by user preference: UK > Europe > Lebanon > Gulf > Remote)
  const tier1 = ['london', 'united kingdom', 'uk', 'england', 'manchester', 'edinburgh', 'birmingham', 'bristol', 'cambridge'];
  const tier2 = ['spain', 'barcelona', 'madrid', 'germany', 'berlin', 'munich', 'netherlands', 'amsterdam',
    'france', 'paris', 'sweden', 'stockholm', 'denmark', 'copenhagen', 'switzerland', 'zurich',
    'austria', 'vienna', 'portugal', 'lisbon', 'ireland', 'dublin', 'belgium', 'brussels',
    'italy', 'milan', 'rome', 'finland', 'helsinki', 'norway', 'oslo', 'europe', 'eu'];
  const tier3 = ['beirut', 'lebanon'];
  const tier4 = ['dubai', 'uae', 'abu dhabi', 'riyadh', 'jeddah', 'saudi', 'doha', 'qatar',
    'kuwait', 'bahrain', 'manama', 'muscat', 'oman', 'sharjah'];
  const tier5 = ['remote', 'anywhere', 'distributed', 'wfh', 'work from home'];

  if (tier1.some(l => loc.includes(l))) score += 15;       // UK: top choice
  else if (tier2.some(l => loc.includes(l))) score += 12;  // Western/Central Europe
  else if (tier3.some(l => loc.includes(l))) score += 14;  // Lebanon: home country, high priority
  else if (tier4.some(l => loc.includes(l))) score += 10;  // Gulf
  else if (tier5.some(l => loc.includes(l))) score += 5;   // Remote-only (no specific location)

  // 4. Freshness
  if (job.posted) {
    const daysOld = (Date.now() - new Date(job.posted)) / DAY_MS;
    if (daysOld <= 7) score += 10;
    else if (daysOld <= 14) score += 5;
    else if (daysOld > 30) score -= 5;
  }

  // 5. Preferred sector match
  const prefs = config.strict_filter?.preferred_sectors || [];
  if (prefs.some(s => text.includes(s))) score += 5;

  // 6. Company stage bonus (startups: +8, scale-ups: +5, big tech: +2)
  const startups = ['monzo', 'revolut', 'wise', 'ramp', 'vercel', 'linear', 'elevenlabs',
    'livekit', 'retool', 'mercury', 'rippling', 'deel', 'bolt', 'n26', 'careem', 'sentry',
    'airtable', 'plaid', 'duolingo', 'postman'];
  const scaleups = ['stripe', 'spotify', 'figma', 'notion', 'cloudflare', 'discord',
    'canva', 'shopify', 'reddit', 'adyen'];
  const bigTech = ['google', 'meta', 'apple', 'amazon', 'microsoft', 'netflix', 'uber',
    'anthropic', 'openai', 'databricks', 'airbnb', 'atlassian', 'palantir', 'dropbox',
    'twilio', 'asana', 'pagerduty', 'gitlab', 'github', 'elastic',
    'zalando', 'delivery hero', 'klarna', 'booking'];

  const coName = (job.company || '').toLowerCase();
  if (startups.some(c => coName.includes(c))) score += 8;
  else if (scaleups.some(c => coName.includes(c))) score += 5;
  else if (bigTech.some(c => coName.includes(c))) score += 2;

  return Math.max(0, Math.min(100, score));
}

// Load scrape config with defaults
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __shared_dirname = dirname(fileURLToPath(import.meta.url));
const __shared_root = resolve(__shared_dirname, '..');
const CONFIG_PATH = resolve(__shared_root, 'scrape_config.json');

export function loadScrapeConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return {
      role_keywords: ['software engineer', 'backend engineer', 'full stack', 'ai engineer', 'ml engineer', 'platform engineer', 'cloud engineer', 'data engineer', 'systems engineer', 'api engineer'],
      exclude_roles: ['junior', 'intern', 'graduate', 'entry level', 'apprentice', 'vp of', 'director', 'head of engineering', 'engineering manager', 'mobile engineer', 'ios', 'android', 'embedded', 'firmware', 'qa engineer', 'test engineer'],
      remote_preference: { remote_only: true, hybrid_ok: true, hybrid_locations: ['london', 'united kingdom', 'uk'], exclude_onsite: true },
      locations: { include: ['remote', 'london', 'united kingdom', 'uk', 'europe', 'anywhere', 'distributed'], exclude: [] },
      max_jobs_per_company: null,
    };
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}
