// contract_score.js — Score contract jobs against your contract profile
// Different criteria from permanent: rate fit, availability, IR35, delivery focus
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'contract_jobs.json');

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

function scoreWithClaude(job) {
  try {
    const promptDir = resolve(DATA_DIR, 'contract_prompts');
    if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });
    const promptFile = resolve(promptDir, `score_${job.id}.txt`);
    writeFileSync(promptFile, buildScorePrompt(job));

    const cmd = `claude --print --output-format text --dangerously-skip-permissions -p "$(cat '${promptFile.replace(/'/g, "'\\''")}')"`;
    console.log(`  Scoring ${job.id}...`);
    const result = execSync(cmd, {
      cwd: ROOT, timeout: 60000, maxBuffer: 1024 * 1024, encoding: 'utf-8',
    });

    const jsonMatch = result.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        score: parsed.score,
        verdict: parsed.verdict,
        rate_fit: parsed.rate_fit,
        rate_note: parsed.rate_note,
        strengths: parsed.strengths || [],
        gaps: parsed.gaps || [],
        pitch_angles: parsed.pitch_angles || [],
        ir35_note: parsed.ir35_note || '',
        reasoning: parsed.reasoning || '',
      };
    }
    return null;
  } catch (e) {
    console.error(`  X Claude error for ${job.id}: ${e.message}`);
    return null;
  }
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

  console.log(`\nScoring ${toScore.length} contract jobs against contract profile...\n`);
  console.log(`Profile: profile/contract_profile.json + profile/master_doc.md\n`);

  for (let i = 0; i < toScore.length; i++) {
    const job = toScore[i];
    process.stdout.write(`[${i + 1}/${toScore.length}] ${job.title} @ ${job.company}... `);

    const scoring = scoreWithClaude(job);
    if (scoring) {
      const idx = jobs.findIndex(j => j.id === job.id);
      jobs[idx].score = scoring.score;
      jobs[idx].verdict = scoring.verdict;
      jobs[idx].scoring = scoring;
      jobs[idx].status = 'scored';
      jobs[idx].scoredAt = new Date().toISOString();
      const rateStr = scoring.rate_fit !== 'UNKNOWN' ? ` [rate: ${scoring.rate_fit}]` : '';
      process.stdout.write(`${scoring.verdict} (${scoring.score}/100)${rateStr}\n`);
      writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
    } else {
      process.stdout.write(`FAILED\n`);
    }
  }

  console.log(`\nDone. Contract jobs saved to data/contract_jobs.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
