// score.js — Score jobs against your profile using Claude Code
// Reads jobs.json, scores each new job, saves results
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');
const PROFILE_FILE = resolve(ROOT, 'profile', 'master_doc.md');

// ─── Claude Code Scoring ────────────────────────────────────────

function buildScorePrompt(job) {
  const jobText = `
JOB TITLE: ${job.title}
COMPANY: ${job.company} (via ${job.source})
LOCATION: ${job.location}
URL: ${job.url}

DESCRIPTION:
${job.description.slice(0, 4000)}
`;

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
${jobText}`;
}

function scoreWithClaude(job) {
  try {
    // Write a temp prompt file
    const promptDir = resolve(DATA_DIR, 'prompts');
    if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });
    const promptFile = resolve(promptDir, `score_${job.id}.txt`);
    writeFileSync(promptFile, buildScorePrompt(job));

    // Call Claude Code headless
    const cmd = `claude --print --output-format text --dangerously-skip-permissions -p "$(cat '${promptFile.replace(/'/g, "'\\''")}')"`;
    console.log(`  Scoring ${job.id}...`);
    const result = execSync(cmd, {
      cwd: ROOT,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
    });

    // Extract JSON from response (may have markdown wrapping)
    const jsonMatch = result.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        score: parsed.score,
        verdict: parsed.verdict,
        strengths: parsed.strengths || [],
        gaps: parsed.gaps || [],
        tailoring_angles: parsed.tailoring_angles || [],
        reasoning: parsed.reasoning || '',
      };
    }
    console.error(`  ⚠ Could not parse score from Claude response`);
    return null;
  } catch (e) {
    console.error(`  ✗ Claude error for ${job.id}: ${e.message}`);
    return null;
  }
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  if (!existsSync(JOBS_FILE)) {
    console.error('No jobs found. Run "node src/find.js" first.');
    process.exit(1);
  }

  const jobs = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  const unscored = jobs.filter(j => j.status === 'new' && j.score === null);

  if (unscored.length === 0) {
    console.log('All jobs already scored. Run "node src/status.js" to view.');
    process.exit(0);
  }

  // Ask user how many to score
  const count = Math.min(process.argv[2] ? parseInt(process.argv[2]) : 10, unscored.length);
  const toScore = unscored.slice(0, count);

  console.log(`\n🎯 Scoring ${toScore.length} jobs against your profile...\n`);
  console.log(`Profile: ${PROFILE_FILE}\n`);

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
      process.stdout.write(`${scoring.verdict} (${scoring.score}/100)\n`);

      // Save after each job
      writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
    } else {
      process.stdout.write(`FAILED\n`);
    }
  }

  console.log(`\n✅ Done. Run "node src/status.js" to view ranked pipeline.`);
}

main().catch(e => { console.error(e); process.exit(1); });
