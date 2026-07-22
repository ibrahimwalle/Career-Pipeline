// contract_tailor.js — Generate contract-specific pitch + CV for a contract job
// Output: short pitch (not cover letter), contract CV summary, rate justification
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'contract_jobs.json');
const OUTPUT_DIR = resolve(ROOT, 'output', 'contracts');

function buildPitchPrompt(job) {
  return `Read my contract profile (profile/contract_profile.json) and my full experience (profile/master_doc.md).

Generate contract application materials for this freelance/contract role:

COMPANY: ${job.company}
TITLE: ${job.title}
LOCATION: ${job.location}
SOURCE: ${job.source}
URL: ${job.url}

DESCRIPTION:
${(job.description || '').slice(0, 5000)}

Return a JSON object with:
{
  "contract_pitch": "<short pitch — 2 paragraphs max. State: what you deliver, your rate, your availability. No fluff. This is for freelance platforms where hiring managers read 3 sentences max.>",
  "delivery_evidence": ["<3-4 past deliverables relevant to this contract, with metrics>"],
  "rate_justification": "<1 sentence explaining why your rate matches this role>",
  "skills_to_highlight": ["<5 skills from your stack that directly apply>"],
  "contract_cv_summary": "<3-4 bullet professional summary rewritten for contract role — delivery-focused, not career-narrative>",
  "availability_statement": "<1 line stating your start date and notice period>",
  "questions_to_ask": ["<3 smart questions to ask the client — shows you understand the problem, not the process>"]
}`;
}

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('Usage: node src/contract_tailor.js <jobId>');
    console.error('Find IDs with: node src/contract_status.js');
    process.exit(1);
  }

  if (!existsSync(JOBS_FILE)) {
    console.error('No contract jobs found. Run: node src/contract_find.js');
    process.exit(1);
  }

  const jobs = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  const job = jobs.find(j => j.id === jobId);
  if (!job) { console.error(`Job "${jobId}" not found.`); process.exit(1); }

  console.log(`\nTailoring contract pitch for: ${job.title} @ ${job.company}\n`);

  if (!existsSync(DATA_DIR + '/contract_prompts')) mkdirSync(DATA_DIR + '/contract_prompts', { recursive: true });
  const promptFile = resolve(DATA_DIR, 'contract_prompts', `pitch_${jobId}.txt`);
  writeFileSync(promptFile, buildPitchPrompt(job));

  try {
    console.log('Generating contract materials...');
    const result = execSync(`claude --print --output-format text --dangerously-skip-permissions`, {
      cwd: ROOT, timeout: 120000, maxBuffer: 1024 * 1024, encoding: 'utf-8',
      input: readFileSync(promptFile, 'utf-8'),
    });

    const jsonMatch = result.match(/\{[\s\S]*"contract_pitch"[\s\S]*\}/);
    if (jsonMatch) {
      const m = JSON.parse(jsonMatch[0]);

      const outDir = resolve(OUTPUT_DIR, jobId);
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

      writeFileSync(resolve(outDir, 'pitch.md'), m.contract_pitch);
      writeFileSync(resolve(outDir, 'cv_summary.md'), m.contract_cv_summary);
      writeFileSync(resolve(outDir, 'rate_justification.md'), m.rate_justification);
      writeFileSync(resolve(outDir, 'availability.md'), m.availability_statement + '\n\nRate: £350-450/day (negotiable)\nIR35: Open to both inside and outside');

      const brief = `# Contract Application Brief

**Role:** ${job.title}
**Company:** ${job.company}
**Source:** ${job.source}
**URL:** ${job.url}

---

## Contract Pitch
${m.contract_pitch}

---

## Delivery Evidence
${m.delivery_evidence.map((d, i) => `${i + 1}. ${d}`).join('\n')}

---

## Rate Justification
${m.rate_justification}

---

## Skills to Highlight
${m.skills_to_highlight.map(s => `- ${s}`).join('\n')}

---

## Availability
${m.availability_statement}

---

## Questions for Client
${m.questions_to_ask.map((q, i) => `${i + 1}. ${q}`).join('\n')}
`;
      writeFileSync(resolve(outDir, 'brief.md'), brief);

      console.log(`\nMaterials saved to: output/contracts/${jobId}/`);
      console.log(`   - pitch.md           (short contract pitch)`);
      console.log(`   - cv_summary.md      (contract CV bullets)`);
      console.log(`   - rate_justification.md`);
      console.log(`   - availability.md`);
      console.log(`   - brief.md           (everything combined)`);
      console.log(`\n--- PITCH PREVIEW ---`);
      console.log(m.contract_pitch.slice(0, 500));
    } else {
      console.error('Could not parse Claude response');
      console.log('Raw output:', result.slice(0, 1000));
    }
  } catch (e) {
    console.error(`X Error: ${e.message}`);
    if (e.stdout) console.log(e.stdout.toString().slice(0, 1000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
