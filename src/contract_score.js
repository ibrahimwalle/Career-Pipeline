// contract_score.js — Score contract jobs against your contract profile
// Different criteria from permanent: rate fit, availability, IR35, delivery focus
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'contract_jobs.json');
const CRASH_LOG = resolve(ROOT, 'crash.log');

function logCrash(id, reason, extra = {}) {
  try { appendFileSync(CRASH_LOG, JSON.stringify({ ts: new Date().toISOString(), jobId: id, reason, ...extra }) + '\n'); } catch {}
}

function buildScorePrompt(job) {
  const hasRate = job.rate ? `Rate: ${job.rate.currency} ${job.rate.min}-${job.rate.max}` : 'Rate: Not specified';
  return `Score this CONTRACT role against my contract profile.

Read profile/contract_profile.json for my rates (£350-450/day), IR35 status, availability, and contract preferences.
Read profile/master_doc.md for my full experience.

JOB:
Title: ${job.title}
Company: ${job.company}
Source: ${job.source}
Location: ${job.location}
${hasRate}
URL: ${job.url}
Description: ${(job.description || '').slice(0, 4000)}

Return a JSON object with NO other text:
{
  "score": <0-100 contract fit>,
  "verdict": "<BID|APPLY|REACH|SKIP>",
  "rate_fit": "<UNDER|IN_RANGE|ABOVE|UNKNOWN>",
  "rate_note": "<e.g. 'At £350/day this is in your range'>",
  "strengths": ["<3 delivery strengths matching this contract>"],
  "gaps": ["<2-3 things you'd need to learn or lack>"],
  "pitch_angles": ["<3 angles for a short contract pitch>"],
  "ir35_note": "<if this looks inside/outside IR35, note it>",
  "reasoning": "<2 sentences on contract fit>"
}`;
}

function scoreOneWithClaude(job) {
  return new Promise((resolve) => {
    const promptDir = resolve(DATA_DIR, 'contract_prompts');
    if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });
    const promptFile = resolve(promptDir, `score_${job.id}.txt`);
    writeFileSync(promptFile, buildScorePrompt(job));

    const child = spawn('claude', ['--print', '--output-format', 'text', '--dangerously-skip-permissions'], {
      cwd: ROOT, timeout: 180000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf-8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    child.stdin.write(readFileSync(promptFile, 'utf-8'));
    child.stdin.end();
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (code !== 0) { logCrash(job.id, `exit ${code}`, { stderr: stderr.slice(0, 200) }); resolve(null); return; }
      const jsonMatch = stdout.match(/\{[\s\S]*"score"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const p = JSON.parse(jsonMatch[0]);
          resolve({ score: p.score, verdict: p.verdict, rate_fit: p.rate_fit, rate_note: p.rate_note, strengths: p.strengths || [], gaps: p.gaps || [], pitch_angles: p.pitch_angles || [], ir35_note: p.ir35_note || '', reasoning: p.reasoning || '' });
        } catch { resolve(null); }
      } else { resolve(null); }
    });
    child.on('error', () => resolve(null));
  });
}

function detectIR35(job) {
  const desc = (job.description || '').toLowerCase();
  const tags = {};
  // Check for outside IR35
  if (desc.includes('outside ir35')) {
    tags.ir35_status = 'outside';
  }
  // Check for inside IR35
  if (desc.includes('inside ir35')) {
    tags.ir35_status = 'inside';
  }
  // Check for day rate mention
  if (/day rate|£\/day|per day|daily rate|£\d+.*\/\s*day/i.test(job.description || '')) {
    tags.rate_type = 'day';
  }
  return tags;
}

async function main() {
  if (!existsSync(JOBS_FILE)) {
    console.error('No contract jobs found. Run "node src/contract_find.js" first.');
    process.exit(1);
  }

  const jobs = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  const unscored = jobs.filter(j => j.status === 'new' && j.score === null);

  if (unscored.length === 0) {
    console.log('All contract jobs already scored.');
    process.exit(0);
  }

  const count = Math.min(process.argv[2] ? parseInt(process.argv[2]) : 10, unscored.length);
  const toScore = unscored.slice(0, count);

  const BATCH = 5;
  console.log(`\nScoring ${toScore.length} contract jobs (${BATCH} at a time)...\n`);
  console.log(`Profile: profile/contract_profile.json + profile/master_doc.md\n`);

  let scored = 0; let failed = 0;
  for (let i = 0; i < toScore.length; i += BATCH) {
    const batch = toScore.slice(i, i + BATCH);
    const startN = i + 1;
    const endN = Math.min(i + BATCH, toScore.length);
    process.stdout.write(`[${startN}-${endN}/${toScore.length}] Scoring... `);

    const results = await Promise.all(batch.map(job => scoreOneWithClaude(job)));
    let bs = 0; let bf = 0;
    for (let r = 0; r < batch.length; r++) {
      const scoring = results[r];
      if (scoring) {
        const job = batch[r];
        const idx = jobs.findIndex(j => j.id === job.id);
        if (idx !== -1) {
          jobs[idx].score = scoring.score; jobs[idx].verdict = scoring.verdict;
          jobs[idx].scoring = scoring; jobs[idx].status = 'scored'; jobs[idx].scoredAt = new Date().toISOString();
          const ir35 = detectIR35(jobs[idx]);
          if (ir35.ir35_status) jobs[idx].ir35_status = ir35.ir35_status;
          if (ir35.rate_type) jobs[idx].rate_type = ir35.rate_type;
        }
        bs++;
      } else { bf++; }
    }
    process.stdout.write(`${bs} scored, ${bf} failed\n`);
    scored += bs; failed += bf;
    try { writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2)); } catch {}
  }

  console.log(`\nDone. ${scored} scored, ${failed} failed. Contract jobs saved.`);
}

main().catch(e => { console.error(e); process.exit(1); });
