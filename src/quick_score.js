// quick_score.js — Instant keyword-based scoring. No Claude, no API, under 1s.
// Usage: node src/quick_score.js [N] [pipeline]
// Default: 100 jobs, perm pipeline
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');

const PROFILE_SKILLS = {
  // Core languages
  python: 8, javascript: 6, typescript: 6, sql: 5,
  // Backend
  fastapi: 7, flask: 5, express: 5, 'express.js': 5, node: 5, 'node.js': 5, 'rest api': 6, webhooks: 5, jwt: 4,
  // Frontend
  react: 5, angular: 4, redux: 3,
  // AI/ML
  'llm': 8, 'ai ': 7, 'rag': 7, langchain: 7, faiss: 6, 'openai': 6, ocr: 5, 'yolo': 4, embeddings: 6, 'machine learning': 5,
  'prompt engineer': 6, 'ai systems': 8, 'ai engineer': 8, 'generative ai': 6, 'genai': 6, 'nlp': 4,
  // Data
  postgresql: 6, postgres: 6, mongodb: 5, redis: 6, firebase: 5, pandas: 4,
  // Cloud
  gcp: 7, 'google cloud': 7, docker: 6, 'ci/cd': 5, 'cloud run': 6, 'cloud functions': 5, 'compute engine': 4,
  terraform: 3, kubernetes: 3, aws: 4, 'cloud infrastructure': 6,
  // Integrations
  stripe: 6, oauth: 4, 'google maps': 4, podio: 4, twilio: 4, 'elevenlabs': 3, airtable: 4, 'api integration': 7,
  // Systems
  'system design': 7, architecture: 7, 'production debugging': 7, observability: 6, monitoring: 6,
  logging: 5, caching: 5, 'end-to-end': 6, refactoring: 5, modular: 5,
  // Soft
  'stakeholder': 6, client: 5, consulting: 6, leadership: 5, team: 4, mentoring: 4, onboarding: 4,
  // Geo
  geojson: 4, spatial: 4, 'google maps api': 4, 'real estate': 3,
};

const PROFILE_STRENGTHS = [
  'production', 'scale', 'deploy', 'ship', 'build', 'design', 'architect',
  'integrate', 'integration', 'automate', 'debug', 'refactor', 'optimize',
  'deliver', 'lead', 'own', 'manage', 'communicate', 'client', 'stakeholder',
];

const PROFILE_GAPS = [
  'java', 'golang', 'go ', 'rust', 'c++', 'c#', '.net', 'kotlin', 'swift',
  'scala', 'ruby', 'php', 'mobile ios android', 'game dev',
  'blockchain', 'crypto', 'web3', 'quantum', 'fpga', 'verilog',
];

function quickScore(job) {
  let score = 40; // baseline
  const title = (job.title || '').toLowerCase();
  const desc = (job.description || '').toLowerCase();
  const text = title + ' ' + desc;
  const loc = (job.location || '').toLowerCase();
  let reasons = [];

  // 1. Skill matches (+up to 40)
  let skillScore = 0;
  let skillsMatched = [];
  for (const [skill, weight] of Object.entries(PROFILE_SKILLS)) {
    if (text.includes(skill)) {
      skillScore += weight;
      if (weight >= 6) skillsMatched.push(skill);
    }
  }
  skillScore = Math.min(skillScore, 40);
  score += skillScore;

  // 2. Title relevance (+up to 15)
  const strongTitles = ['ai engineer', 'integration engineer', 'fde', 'forward deployed', 'solutions engineer',
    'backend engineer', 'full stack', 'platform engineer', 'cloud engineer', 'systems engineer',
    'implementation engineer', 'technical account manager', 'sales engineer', 'customer engineer',
    'software engineer', 'project manager', 'developer advocate', 'devrel'];
  const weakTitles = ['staff engineer', 'senior staff', 'principal', 'architect', 'director',
    'vp ', 'head of engineering', 'machine learning engineer', 'data scientist', 'research scientist'];
  if (strongTitles.some(t => title.includes(t))) score += 15;
  else if (weakTitles.some(t => title.includes(t))) score -= 5;

  // 3. Location (+up to 15)
  const uk = ['london', 'united kingdom', 'uk', 'england', 'dublin', 'ireland'];
  const europe = ['germany', 'berlin', 'netherlands', 'amsterdam', 'france', 'paris',
    'spain', 'barcelona', 'madrid', 'sweden', 'stockholm', 'switzerland', 'zurich'];
  const gulf = ['dubai', 'uae', 'abu dhabi', 'saudi', 'riyadh', 'doha', 'qatar'];
  const lebanon = ['beirut', 'lebanon'];
  const remote = ['remote', 'anywhere', 'distributed', 'wfh'];

  if (uk.some(l => loc.includes(l))) score += 15;
  else if (lebanon.some(l => loc.includes(l))) score += 14;
  else if (europe.some(l => loc.includes(l))) score += 12;
  else if (gulf.some(l => loc.includes(l))) score += 8;
  else if (remote.some(l => loc.includes(l))) score += 5;
  else score -= 3; // on-site somewhere not preferred

  // 4. Profile gap penalties (-up to 15)
  let gapPenalty = 0;
  for (const gap of PROFILE_GAPS) {
    if (text.includes(gap)) {
      // Only penalize if it's a hard requirement (appears early in description, near "required"/"must")
      const idx = desc.indexOf(gap);
      const before = desc.slice(Math.max(0, idx - 100), idx);
      if (/require|must have|essential|need|proficient/i.test(before)) {
        gapPenalty += 3;
      }
    }
  }
  score -= Math.min(gapPenalty, 15);

  // 5. Freshness (+up to 5)
  if (job.posted) {
    const daysOld = (Date.now() - new Date(job.posted)) / 86400000;
    if (daysOld <= 3) score += 5;
    else if (daysOld <= 7) score += 3;
    else if (daysOld > 30) score -= 2;
  }

  // Clamp
  score = Math.max(5, Math.min(100, score));

  // Generate verdict
  let verdict = 'REACH';
  if (score >= 75) verdict = 'STRONG_MATCH';
  else if (score >= 55) verdict = 'GOOD_FIT';
  else if (score < 25) verdict = 'SKIP';

  const reasoning = `${skillsMatched.slice(0, 3).join(', ')} match. Location: ${loc.slice(0, 40)}. ` +
    (gapPenalty > 0 ? `${gapPenalty}pt gap penalty. ` : '') +
    `Quick score based on keyword match.`;

  return { score, verdict, reasoning, skillScore, gapPenalty, quick: true };
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  const count = parseInt(process.argv[2] || '100');
  const pipeline = process.argv[3] || 'perm';
  const file = pipeline === 'contract' ? 'contract_jobs.json' : 'jobs.json';
  const JOBS_FILE = resolve(DATA_DIR, file);

  if (!existsSync(JOBS_FILE)) {
    console.error(`No ${pipeline} jobs found.`);
    process.exit(1);
  }

  const jobs = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  const unscored = jobs.filter(j => j.score === null && j.status === 'new');
  const toScore = unscored.slice(0, Math.min(count, unscored.length));

  if (!toScore.length) {
    console.log('All jobs already scored.');
    process.exit(0);
  }

  console.log(`Quick-scoring ${toScore.length} ${pipeline} jobs (instant — no API)...`);

  let done = 0;
  const BATCH = 20; // batch save every 20
  for (const job of toScore) {
    const result = quickScore(job);
    const idx = jobs.findIndex(j => j.id === job.id);
    if (idx !== -1) {
      jobs[idx].score = result.score;
      jobs[idx].verdict = result.verdict;
      jobs[idx].scoring = {
        strengths: [], gaps: [],
        reasoning: result.reasoning,
        quick: true,
      };
      jobs[idx].status = 'scored';
      jobs[idx].scoredAt = new Date().toISOString();
    }
    done++;
    if (done % BATCH === 0) {
      writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
      process.stdout.write(`\r  ${done}/${toScore.length}...`);
    }
  }

  // Final save + auto-sort by score
  jobs.sort((a, b) => (b.score || b.relevance || 0) - (a.score || a.relevance || 0));
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
  console.log(`\r  ${done}/${toScore.length} — done.\n`);

  const strong = toScore.filter(j => (j.score || 0) >= 75).length;
  const good = toScore.filter(j => (j.score || 0) >= 55 && (j.score || 0) < 75).length;
  console.log(`${strong} strong matches, ${good} good fits (of ${toScore.length} scored)`);
  console.log(`\nTip: use Claude scoring for better accuracy on top matches.`);
}

main().catch(e => { console.error(e); process.exit(1); });
