// tailor.js — Generate tailored CV + cover letter for a specific job
// Uses Claude Code to read your profile and generate materials
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');
const OUTPUT_DIR = resolve(ROOT, 'output');

function buildTailorPrompt(job) {
  return `Read my profile in profile/master_doc.md and my CV in profile/cv.md.

Generate tailored application materials for this job:

COMPANY: ${job.company}
TITLE: ${job.title}
LOCATION: ${job.location}
URL: ${job.url}

DESCRIPTION:
${job.description.slice(0, 5000)}

Return a JSON object with:
{
  "tailored_cv_summary": "<3-4 bullet professional summary rewritten for this role>",
  "cover_letter_draft": "<full cover letter, 3-4 paragraphs, referencing specific matches between my experience and their requirements>",
  "key_talking_points": ["<5 things to bring up in interview>"],
  "skills_to_highlight": ["<5 skills from my stack to emphasize>"],
  "missing_requirements": ["<anything they ask for that I don't have>"]
}`;
}

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('Usage: node src/tailor.js <jobId>');
    console.error('Find IDs with: node src/status.js');
    process.exit(1);
  }

  if (!existsSync(JOBS_FILE)) {
    console.error('No jobs found. Run "node src/find.js" first.');
    process.exit(1);
  }

  const jobs = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  const job = jobs.find(j => j.id === jobId);
  if (!job) {
    console.error(`Job "${jobId}" not found.`);
    process.exit(1);
  }

  console.log(`\n✂️  Tailoring application for: ${job.title} @ ${job.company}\n`);

  // Write prompt
  if (!existsSync(DATA_DIR + '/prompts')) mkdirSync(DATA_DIR + '/prompts', { recursive: true });
  const promptFile = resolve(DATA_DIR, 'prompts', `tailor_${jobId}.txt`);
  writeFileSync(promptFile, buildTailorPrompt(job));

  try {
    console.log('🤖 Asking Claude to tailor...');
    const result = execSync(`claude --model claude-sonnet-5 --print --output-format text --dangerously-skip-permissions`, {
      cwd: ROOT,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      input: readFileSync(promptFile, 'utf-8'),
    });

    // Parse JSON from response
    const jsonMatch = result.match(/\{[\s\S]*"tailored_cv_summary"[\s\S]*\}/);
    if (jsonMatch) {
      const materials = JSON.parse(jsonMatch[0]);

      // Save to output
      if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
      const outDir = resolve(OUTPUT_DIR, jobId);
      if (!existsSync(outDir)) mkdirSync(outDir);

      // Write cover letter
      writeFileSync(resolve(outDir, 'cover_letter.md'), materials.cover_letter_draft);

      // Write full brief
      const brief = `# Tailored Application Brief\n\n**Job:** ${job.title} @ ${job.company}\n**URL:** ${job.url}\n**Location:** ${job.location}\n\n---\n\n## Tailored CV Summary\n\n${materials.tailored_cv_summary}\n\n---\n\n## Key Talking Points\n\n${materials.key_talking_points.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\n---\n\n## Skills to Highlight\n\n${materials.skills_to_highlight.map(s => `- ${s}`).join('\n')}\n\n---\n\n## Missing Requirements\n\n${materials.missing_requirements.map(s => `- ${s}`).join('\n')}\n`;
      writeFileSync(resolve(outDir, 'brief.md'), brief);

      console.log(`\n✅ Materials saved to: output/${jobId}/`);
      console.log(`   - cover_letter.md`);
      console.log(`   - brief.md`);
      console.log(`\n📝 Cover Letter Preview:\n`);
      console.log(materials.cover_letter_draft.slice(0, 500) + '...');
    } else {
      console.error('Could not parse Claude response.');
      console.log('Raw output:', result.slice(0, 1000));
    }
  } catch (e) {
    console.error(`✗ Error: ${e.message}`);
    if (e.stdout) console.log('Output:', e.stdout.toString().slice(0, 1000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
