// devitjobs_find.js — Fetch IT jobs from DevITjobs UK (job_feed.xml API)
// Pure Node.js, zero dependencies. Saves to data/contract_jobs.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeRelevance, loadScrapeConfig, DAY_MS } from './shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'contract_jobs.json');

// ─── DevITjobs API Fetching ─────────────────────────────────────

/**
 * Fetch from the structured XML feed at job_feed.xml.
 * Each <job> element has: id, title, name, company, company-name,
 * link, apply_url, url, country, region, location, city, salary,
 * jobtype, job-type, pubdate, description (HTML), logo.
 */
async function fetchDevITjobsXML() {
  const url = 'https://devitjobs.uk/job_feed.xml';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobAgent/1.0)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    // Extract each <job ...>...</job> block
    const jobs = [];
    const jobBlocks = xml.split(/<job[\s>]/).slice(1); // skip content before first <job>
    for (const block of jobBlocks) {
      // Find the closing </job> — the block may contain nested tags
      const endIdx = block.lastIndexOf('</job>');
      if (endIdx === -1) continue;
      const jobXml = '<job ' + block.substring(0, endIdx);

      jobs.push({
        id: extractXmlField(jobXml, 'id'),
        title: extractXmlField(jobXml, 'title') || extractXmlField(jobXml, 'name'),
        company: extractXmlField(jobXml, 'company-name') || extractXmlField(jobXml, 'company'),
        location: extractXmlField(jobXml, 'location'),
        city: extractXmlField(jobXml, 'city'),
        region: extractXmlField(jobXml, 'region'),
        country: extractXmlField(jobXml, 'country'),
        url: extractXmlField(jobXml, 'link') || extractXmlField(jobXml, 'url'),
        applyUrl: extractXmlField(jobXml, 'apply_url'),
        salary: extractXmlField(jobXml, 'salary'),
        jobtype: extractXmlField(jobXml, 'job-type') || extractXmlField(jobXml, 'jobtype'),
        pubdate: extractXmlField(jobXml, 'pubdate'),
        description: extractXmlField(jobXml, 'description'),
        logo: extractXmlField(jobXml, 'logo'),
      });
    }
    return jobs.filter(j => j.id && j.title);
  } catch (e) {
    console.error(`  X DevITjobs XML: ${e.message}`);
    return [];
  }
}

/**
 * Fallback: RSS feed at /rss — less structured but may contain different jobs.
 * Each <item> has: title, link, guid, pubDate, description (HTML).
 */
async function fetchDevITjobsRSS() {
  const url = 'https://devitjobs.uk/rss';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobAgent/1.0)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    const jobs = [];
    const items = xml.split('<item>').slice(1);
    for (const item of items) {
      const endIdx = item.lastIndexOf('</item>');
      if (endIdx === -1) continue;
      const itemXml = '<item ' + item.substring(0, endIdx);

      const titleRaw = extractXmlContent(itemXml, 'title');
      const link = extractXmlField(itemXml, 'link');
      const guid = extractXmlField(itemXml, 'guid') || link;
      const pubDate = extractXmlField(itemXml, 'pubDate');
      const desc = extractXmlContent(itemXml, 'description');

      // Title format: "Job Title @ Company Name [£salary]"
      let title = titleRaw;
      let company = 'Unknown';
      const titleMatch = titleRaw.match(/^(.*?)\s*@\s*(.*?)\s*\[/);
      if (titleMatch) {
        title = titleMatch[1].trim();
        company = titleMatch[2].trim();
      }

      if (title && link) {
        jobs.push({
          id: 'dj_rss_' + (guid.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60) || Math.random().toString(36).slice(2, 10)),
          title,
          company,
          location: extractLocationFromRSS(desc, titleRaw),
          city: '',
          region: '',
          country: 'United Kingdom',
          url: link,
          applyUrl: link,
          salary: extractSalaryFromRSS(desc, titleRaw),
          jobtype: detectJobType(desc, titleRaw),
          pubdate: pubDate,
          description: stripHtml(desc),
          logo: '',
        });
      }
    }
    return jobs;
  } catch (e) {
    console.error(`  X DevITjobs RSS: ${e.message}`);
    return [];
  }
}

/**
 * Try the deprecated /api/jobs endpoints (may come back).
 */
async function fetchDevITjobsAPI(endpoint) {
  try {
    const res = await fetch(endpoint, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobAgent/1.0)' }
    });
    if (!res.ok) return [];
    const text = await res.text();
    if (text.includes('Deprecated')) return [];
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : (data.jobs || data.data || []);
    return arr.map(j => ({
      id: `dj_api_${j.id || j._id || Math.random().toString(36).slice(2, 10)}`,
      title: j.title || j.name || '',
      company: j.company || j.company_name || j.companyName || 'Unknown',
      location: j.location || j.city || '',
      city: j.city || '',
      region: j.region || '',
      country: j.country || 'United Kingdom',
      url: j.url || j.link || j.apply_url || '',
      applyUrl: j.apply_url || j.url || '',
      salary: j.salary || j.salary_range || '',
      jobtype: j.jobtype || j.job_type || j.type || '',
      pubdate: j.pubdate || j.published_at || j.created_at || '',
      description: j.description || j.summary || '',
      logo: j.logo || '',
    }));
  } catch {
    return [];
  }
}

// ─── XML Parsing Helpers ────────────────────────────────────────

function extractXmlField(xml, tag) {
  // Match <tag>CDATA</tag> or <tag attr="val">text</tag> or <tag/>
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`, 's');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const stdRe = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's');
  const stdMatch = xml.match(stdRe);
  if (stdMatch) return stdMatch[1].trim();

  // Self-closing or attribute-only
  const attrRe = new RegExp(`<${tag}\\s+([^>]*?)/?>`, 's');
  const attrMatch = xml.match(attrRe);
  if (attrMatch) {
    // Try to extract a value from attributes
    const valMatch = attrMatch[1].match(/="([^"]*)"/);
    if (valMatch) return valMatch[1];
  }

  return '';
}

function extractXmlContent(xml, tag) {
  // Same as extractXmlField but also handles non-CDATA content with HTML
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`, 's');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const stdRe = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's');
  const stdMatch = xml.match(stdRe);
  if (stdMatch) return stdMatch[1].trim();
  return '';
}

// ─── RSS-specific Parsing ───────────────────────────────────────

function extractSalaryFromRSS(desc, titleRaw) {
  // From description: "Salary: £35,000 - 40,000 per year"
  const salaryMatch = desc.match(/Salary:\s*([^<]+)/i);
  if (salaryMatch) return salaryMatch[1].trim();
  // From title: "[£35,000 - 35,000]"
  const titleMatch = titleRaw.match(/\[([^\]]*£[^\]]*)\]/);
  if (titleMatch) return titleMatch[1].trim();
  return '';
}

function extractLocationFromRSS(desc, titleRaw) {
  // Try to find location in the "More" section or within description text
  const locationPatterns = [
    /based in ([^.<]+)/i,
    /located in ([^.<]+)/i,
    /office in ([^.<]+)/i,
    /in (London|Manchester|Edinburgh|Birmingham|Bristol|Cambridge|Leeds|Glasgow|Oxford|Newcastle|Sheffield|Nottingham|Liverpool|Cardiff|Belfast|Brighton|Reading|Southampton|Leicester|Portsmouth|Aberdeen|Dundee|Exeter|York|Bath|Norwich|Coventry|Swansea|Stoke[^.<]*)/i,
  ];
  for (const re of locationPatterns) {
    const m = desc.match(re);
    if (m) return m[1].trim();
  }
  // Fallback: Remote or UK
  if (/remote/i.test(desc) || /work from home/i.test(desc)) return 'Remote, UK';
  return 'United Kingdom';
}

function detectJobType(desc, titleRaw) {
  const text = `${desc} ${titleRaw}`.toLowerCase();
  if (/contract/i.test(text)) return 'Contract';
  if (/freelance/i.test(text)) return 'Freelance';
  if (/part.time/i.test(text)) return 'Part-Time';
  if (/temporary|temp\b/i.test(text)) return 'Temporary';
  if (/b2b/i.test(text)) return 'B2B';
  return 'Full-Time';
}

function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Salary Parsing ─────────────────────────────────────────────

function parseRate(salaryStr, description, jobtype) {
  // Try to extract a day rate or annual salary from salary string and description
  const text = `${salaryStr} ${description}`.toLowerCase();
  const descText = description || '';

  // Day rate patterns
  const dayRatePatterns = [
    /(?:day rate|daily rate)[^\d]*[£$€]?\s*(\d[\d,]*)/i,
    /[£$€]\s*(\d[\d,]*)\s*(?:\/day|per day|p\/d|per diem)/i,
    /(\d[\d,]*)\s*(?:gbp|£)\s*(?:\/day|per day|p\/d)/i,
  ];
  for (const re of dayRatePatterns) {
    const m = descText.match(re);
    if (m) return { min: parseInt(m[1].replace(/,/g, '')), unit: 'day', currency: 'GBP' };
  }

  // Hourly rate patterns
  const hourlyPatterns = [
    /(?:hourly rate)[^\d]*[£$€]?\s*(\d[\d,]*)/i,
    /[£$€]\s*(\d[\d,]*)\s*(?:\/hr|per hour|p\/h|\/hour)/i,
  ];
  for (const re of hourlyPatterns) {
    const m = descText.match(re);
    if (m) return { min: parseInt(m[1].replace(/,/g, '')), unit: 'hour', currency: 'GBP' };
  }

  // IR35 inside/outside day rates
  const ir35Pattern = /[£$€]\s*(\d[\d,]*)\s*(?:per day|a day|p\/d|inside|outside)/i;
  const ir35Match = descText.match(ir35Pattern);
  if (ir35Match) return { min: parseInt(ir35Match[1].replace(/,/g, '')), unit: 'day', currency: 'GBP' };

  // Annual salary
  const salaryMatch = (salaryStr || '').match(/[£$€]\s*(\d[\d,]*)\s*-\s*(\d[\d,]*)/);
  if (salaryMatch) {
    return {
      min: parseInt(salaryMatch[1].replace(/,/g, '')),
      max: parseInt(salaryMatch[2].replace(/,/g, '')),
      unit: 'year',
      currency: salaryStr.includes('$') ? 'USD' : salaryStr.includes('€') ? 'EUR' : 'GBP',
    };
  }

  return null;
}

function isContractType(jobtype) {
  if (!jobtype) return false;
  const t = jobtype.toLowerCase();
  return ['contract', 'freelance', 'temporary', 'part-time', 'b2b'].includes(t);
}

function isContractFromText(description, title) {
  const text = `${description} ${title}`.toLowerCase();
  const contractKeywords = [
    'contract', 'freelance', 'freelancer', 'b2b', 'temporary',
    'day rate', 'daily rate', 'per day', 'p/d',
    'inside ir35', 'outside ir35', '6-month', '3-month',
    '12-month', '6 month', '3 month', '12 month',
    'fixed term', 'fixed-term', 'rolling contract',
  ];
  return contractKeywords.some(kw => text.includes(kw));
}

// ─── Filters (from scrape_config.json) ──────────────────────────


function isGoodLocation(job, config) {
  const text = `${job.location} ${job.city} ${job.region} ${job.country} ${job.description}`.toLowerCase();
  const locs = config.locations || { include: ['remote', 'united kingdom', 'uk', 'london', 'europe'], exclude: [] };

  // Exclusions first
  if (locs.exclude && locs.exclude.some(l => text.includes(l))) return false;

  // Inclusions
  if (locs.include && locs.include.some(l => text.includes(l))) return true;

  // DevITjobs UK is UK-focused, so default accept
  return true;
}

function isRelevantRate(job) {
  if (!job.rate) return true; // No rate info, keep it

  const r = job.rate;
  if (r.unit === 'day') {
    if (r.currency === 'GBP' && r.min < 150) return false;
    if (r.currency === 'USD' && r.min < 200) return false;
    if (r.currency === 'EUR' && r.min < 175) return false;
  }
  if (r.unit === 'year') {
    if (r.currency === 'GBP' && r.min < 25000) return false;
    if (r.currency === 'USD' && r.min < 30000) return false;
    if (r.currency === 'EUR' && r.min < 28000) return false;
  }
  if (r.unit === 'hour') {
    if (r.currency === 'GBP' && r.min < 15) return false;
    if (r.currency === 'USD' && r.min < 20) return false;
    if (r.currency === 'EUR' && r.min < 18) return false;
  }
  return true;
}

// ─── Pubdate Parsing ────────────────────────────────────────────

function parsePubDate(pubdate) {
  if (!pubdate) return new Date().toISOString();
  // DevITjobs XML format: "04.10.2023" (dd.mm.yyyy)
  const dotMatch = pubdate.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    return new Date(`${dotMatch[3]}-${dotMatch[2].padStart(2, '0')}-${dotMatch[1].padStart(2, '0')}`).toISOString();
  }
  // RSS format: "Tue, 21 Jul 2026 15:12:38 GMT"
  const d = new Date(pubdate);
  if (!isNaN(d.getTime())) return d.toISOString();
  return new Date().toISOString();
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const scrapeCfg = loadScrapeConfig();

  // Load existing contract jobs for dedup
  let existing = [];
  if (existsSync(JOBS_FILE)) {
    existing = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  }
  const existingIds = new Set(existing.map(j => j.id));

  console.log(`\n🔍 DevITjobs UK — searching for contract IT jobs...`);
  console.log(`   Config: ${scrapeCfg.role_keywords.length} role keywords, ${scrapeCfg.exclude_roles.length} excluded`);
  console.log(`   Locations: ${(scrapeCfg.locations?.include || []).length} included\n`);

  // ─── 1. Fetch from the structured XML feed (primary source) ───
  process.stdout.write('   DevITjobs XML feed... ');
  const xmlJobs = await fetchDevITjobsXML();
  console.log(`${xmlJobs.length} raw jobs`);

  // ─── 2. Try the deprecated /api/jobs endpoints ──────────────────
  process.stdout.write('   DevITjobs API (contract)... ');
  const apiContract = await fetchDevITjobsAPI('https://devitjobs.uk/api/jobs?workType=contract');
  process.stdout.write(`${apiContract.length} `);
  const apiB2b = await fetchDevITjobsAPI('https://devitjobs.uk/api/jobs?employmentType=b2b');
  process.stdout.write(`/ B2B: ${apiB2b.length} `);
  const apiSenior = await fetchDevITjobsAPI('https://devitjobs.com/api/jobs?seniority=mid,senior');
  console.log(`/ Mid+Senior: ${apiSenior.length}`);

  // ─── 3. Merge all raw sources, dedup by ID ─────────────────────
  const seen = new Set();
  const allRaw = [...xmlJobs, ...apiContract, ...apiB2b, ...apiSenior].filter(j => {
    if (!j.id || !j.title || seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  });
  console.log(`   Total unique raw jobs: ${allRaw.length}`);

  // ─── 4. Convert to contract job format & filter ────────────────
  const contractJobs = [];
  let contractCount = 0;
  let nonContractKept = 0;

  for (const raw of allRaw) {
    const isContract = isContractType(raw.jobtype) || isContractFromText(raw.description, raw.title);

    // Parse salary/rate
    const rate = parseRate(raw.salary || '', raw.description || '', raw.jobtype || '');

    // Build fields from description HTML
    const descText = stripHtml(raw.description || '');
    const technologies = extractTechnologies(raw.description || '');

    const job = {
      id: `dj_${raw.id}`,
      source: 'devitjobs',
      type: isContract ? 'contract' : 'permanent',
      company: raw.company || 'Unknown',
      title: raw.title || '',
      location: raw.location || raw.city || raw.country || 'United Kingdom',
      url: raw.url || raw.applyUrl || '',
      description: descText,
      technologies: technologies,
      posted: parsePubDate(raw.pubdate),
      scrapedAt: new Date().toISOString(),
      status: 'new',
      score: null,
      rate: rate,
      is_explicit_contract: isContract,
    };

    // Apply filters
    if (!isEngineeringRole(job, scrapeCfg)) continue;
    if (!isGoodLocation(job, scrapeCfg)) continue;
    if (!isRelevantRate(job)) continue;
    // Halal compliance: exclude haram industries
    const halal = scrapeCfg.strict_filter || {};
    if (halal.strict_mode !== false && halal.exclude_industries) {
      const jobText = `${job.title || ''} ${job.company || ''} ${job.description || ''}`.toLowerCase();
      if (halal.exclude_industries.some(kw => jobText.includes(kw.toLowerCase()))) continue;
    }
    // Freshness filter: skip jobs older than max_job_age_days
    const maxAge = scrapeCfg.max_job_age_days || null;
    if (maxAge && job.posted) {
      const daysOld = (Date.now() - new Date(job.posted)) / DAY_MS;
      if (daysOld > maxAge) continue;
    }
    if (existingIds.has(job.id)) continue;

    job.relevance = computeRelevance(job, scrapeCfg);
    contractJobs.push(job);
    if (isContract) contractCount++;
    else nonContractKept++;
  }

  console.log(`   After filtering: ${contractJobs.length} matched`);
  console.log(`   Explicit contract/freelance: ${contractCount}`);
  console.log(`   Non-contract but matched: ${nonContractKept}`);

  // ─── 5. Merge and save ─────────────────────────────────────────
  const merged = [...existing, ...contractJobs];
  writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));

  console.log(`\n📊 Total contract jobs in pipeline: ${merged.length} (${contractJobs.length} new)`);
  console.log(`📁 Saved to: data/contract_jobs.json`);
  console.log(`\nNext: node src/contract_score.js 10`);
}

// ─── Technology Extraction ──────────────────────────────────────

function extractTechnologies(descHtml) {
  if (!descHtml) return [];
  // Look for <b>Technologies:</b> section
  const techMatch = descHtml.match(/<b>Technologies:<\/b>\s*<ul>(.*?)<\/ul>/s);
  if (!techMatch) return [];
  const lis = techMatch[1].match(/<li>(.*?)<\/li>/gs);
  if (!lis) return [];
  return lis.map(li => li.replace(/<\/?li>/g, '').trim()).filter(t => t && t !== '•');
}

main().catch(e => { console.error(e); process.exit(1); });
