// score.js — Score jobs against your profile using Claude Code
// Reads jobs.json, scores each new job, saves results.
// Uses spawn() for crash-safe process isolation.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');
const PROFILE_FILE = resolve(ROOT, 'profile', 'master_doc.md');
const CRASH_LOG = resolve(ROOT, 'crash.log');

// ─── Logging ──────────────────────────────────────────────────

function logCrash(id, reason, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    jobId: id,
    reason,
    ...extra,
  };
  try {
    appendFileSync(CRASH_LOG, JSON.stringify(entry) + '\n');
  } catch {}
}

// ─── Claude Code Scoring (async, concurrent batches) ──────────

function buildScorePrompt(job) {
  return `Score this job against my profile (read profile/master_doc.md for my full experience).

Return a JSON object with NO other text:
{
  "score": <0-100 overall fit>,
  "verdict": "<STRONG_MATCH|GOOD_FIT|REACH|SKIP>",
  "strengths": ["<3 things from my profile that match well>"],
  "gaps": ["<3 things I'm missing or weak on>"],
  "tailoring_angles": ["<3 angles to emphasize in cover letter>"],
  "reasoning": "<2 sentence summary>"
}

Job:
Title: ${job.title}
Company: ${job.company} (via ${job.source})
Location: ${job.location}
URL: ${job.url}
Description: ${(job.description || '').slice(0, 4000)}`;
}

function scoreOneWithClaude(job) {
  return new Promise((resolve) => {
    const promptDir = resolve(DATA_DIR, 'prompts');
    if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });
    const promptFile = resolve(promptDir, `score_${job.id}.txt`);
    writeFileSync(promptFile, buildScorePrompt(job));

    const child = spawn('claude', [
      '--print', '--output-format', 'text', '--dangerously-skip-permissions'
    ], {
      cwd: ROOT, timeout: 180000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf-8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    child.stdin.write(readFileSync(promptFile, 'utf-8'));
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', code => {
      if (code !== 0) {
        const msg = `exited ${code}`;
        logCrash(job.id, msg, { stderr: stderr.slice(0, 200) });
        resolve(null);
        return;
      }
      const jsonMatch = stdout.match(/\{[\s\S]*"score"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          resolve({
            score: parsed.score, verdict: parsed.verdict,
            strengths: parsed.strengths || [], gaps: parsed.gaps || [],
            tailoring_angles: parsed.tailoring_angles || [], reasoning: parsed.reasoning || '',
          });
        } catch { resolve(null); }
      } else {
        logCrash(job.id, 'no_json', { stdoutLen: stdout.length });
        resolve(null);
      }
    });

    child.on('error', () => {
      logCrash(job.id, 'spawn_error');
      resolve(null);
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  if (!existsSync(JOBS_FILE)) {
    console.error('No jobs found. Run "node src/find.js" first.');
    process.exit(1);
  }

  try {
    var jobs = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  } catch (e) {
    console.error(`✗ Could not read jobs.json — file may be corrupt: ${e.message}`);
    process.exit(1);
  }

  const unscored = jobs.filter(j => j.status === 'new' && j.score === null);

  if (unscored.length === 0) {
    console.log('All jobs already scored. Run "node src/status.js" to view.');
    process.exit(0);
  }

  const count = Math.min(process.argv[2] ? parseInt(process.argv[2]) : 10, unscored.length);
  const toScore = unscored.slice(0, count);

  const BATCH = 5; // concurrent Claude calls
  console.log(`\nScoring ${toScore.length} jobs (${BATCH} at a time)...\n`);
  console.log(`Profile: ${PROFILE_FILE}\n`);

  let scored = 0;
  let failed = 0;

  for (let i = 0; i < toScore.length; i += BATCH) {
    const batch = toScore.slice(i, i + BATCH);
    const startN = i + 1;
    const endN = Math.min(i + BATCH, toScore.length);
    process.stdout.write(`[${startN}-${endN}/${toScore.length}] Scoring ${batch.map(j => j.company).join(', ')}... `);

    // Launch all in parallel
    const results = await Promise.all(batch.map(job => scoreOneWithClaude(job)));

    // Process results
    let batchScored = 0;
    let batchFailed = 0;
    for (let r = 0; r < batch.length; r++) {
      const job = batch[r];
      const scoring = results[r];
      if (scoring) {
        const idx = jobs.findIndex(j => j.id === job.id);
        if (idx !== -1) {
          jobs[idx].score = scoring.score;
          jobs[idx].verdict = scoring.verdict;
          jobs[idx].scoring = scoring;
          jobs[idx].status = 'scored';
          jobs[idx].scoredAt = new Date().toISOString();
        }
        batchScored++;
      } else {
        batchFailed++;
      }
    }
    process.stdout.write(`${batchScored} scored, ${batchFailed} failed\n`);
    scored += batchScored;
    failed += batchFailed;

    // Save after each batch
    try { writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2)); } catch {}
  }

  console.log(`\nDone. ${scored} scored, ${failed} failed (of ${toScore.length} attempted).`);
  if (failed > 0) console.log(`Check ${CRASH_LOG} for failure details.`);
  console.log(`Run "node src/status.js" to view ranked pipeline.`);
}

main().catch(e => {
  console.error(`FATAL: ${e.message}`);
  try { appendFileSync(CRASH_LOG, JSON.stringify({ ts: new Date().toISOString(), fatal: e.message, stack: e.stack?.slice(0, 500) }) + '\n'); } catch {}
  process.exit(1);
});
