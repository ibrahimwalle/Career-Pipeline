// status.js — Full pipeline dashboard with email integration
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const JOBS_FILE = resolve(ROOT, 'data', 'jobs.json');

function daysAgo(dateStr) {
  if (!dateStr) return '—';
  const days = Math.round((Date.now() - new Date(dateStr)) / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function main() {
  if (!existsSync(JOBS_FILE)) {
    console.log('\n  No jobs yet. Start here:');
    console.log('    node src/find.js              # Scrape 25 companies');
    console.log('    node src/score.js 10          # Score top 10 against your profile');
    console.log('    node src/status.js            # View this dashboard');
    process.exit(0);
  }

  const jobs = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  const scored = jobs.filter(j => j.score !== null).sort((a, b) => b.score - a.score);
  const unscored = jobs.filter(j => j.score === null);
  const applied = jobs.filter(j => j.status === 'applied');
  const interviewing = jobs.filter(j => j.status === 'interviewing');
  const screening = jobs.filter(j => j.status === 'screening');
  const offer = jobs.filter(j => j.status === 'offer');
  const rejected = jobs.filter(j => j.status === 'rejected');

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║           JOB PIPELINE DASHBOARD                 ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  🔍 Total found:    ${String(jobs.length).padStart(5)}                        ║`);
  console.log(`║  🎯 Scored:         ${String(scored.length).padStart(5)}                        ║`);
  console.log(`║  📋 Unscored:       ${String(unscored.length).padStart(5)}                        ║`);
  console.log(`║  ✉️  Applied:        ${String(applied.length).padStart(5)}                        ║`);
  console.log(`║  📞 Screening:      ${String(screening.length).padStart(5)}                        ║`);
  console.log(`║  🎙️  Interviewing:   ${String(interviewing.length).padStart(5)}                        ║`);
  console.log(`║  🏆 Offer:          ${String(offer.length).padStart(5)}                        ║`);
  console.log(`║  ❌ Rejected:       ${String(rejected.length).padStart(5)}                        ║`);
  console.log('╚══════════════════════════════════════════════════╝');

  // ─── Active Applications ──────────────────────────────────
  const active = jobs.filter(j => ['applied', 'screening', 'interviewing'].includes(j.status));
  if (active.length > 0) {
    console.log('\n📬 ACTIVE APPLICATIONS:');
    console.log('─'.repeat(70));
    for (const j of active) {
      const icon = j.status === 'interviewing' ? '🎙️' : j.status === 'screening' ? '📞' : '✉️';
      const when = daysAgo(j.appliedAt);
      const stale = new Date(j.appliedAt) && (Date.now() - new Date(j.appliedAt)) > 7 * 24 * 60 * 60 * 1000;
      const staleWarn = stale ? ' ⚠ STALE — follow up?' : '';
      console.log(`  ${icon} ${j.title} @ ${j.company} — ${when} [${j.status}]${staleWarn}`);
    }
  }

  // ─── Top Matches ─────────────────────────────────────────
  if (scored.length > 0) {
    console.log('\n🏆 TOP MATCHES:');
    console.log('─'.repeat(70));
    const top = scored.slice(0, Math.min(8, scored.length));
    for (const j of top) {
      const icon = j.verdict === 'STRONG_MATCH' ? '🔥' : j.verdict === 'GOOD_FIT' ? '✅' : j.verdict === 'REACH' ? '🤞' : '❌';
      const bar = '█'.repeat(Math.round(j.score / 10)) + '░'.repeat(10 - Math.round(j.score / 10));
      console.log(`  ${icon} ${String(j.score).padStart(3)}/100 ${bar}  ${j.title} @ ${j.company}`);
      console.log(`     ${j.url}`);
      if (j.scoring?.reasoning) {
        console.log(`     💬 ${j.scoring.reasoning}`);
      }
      console.log();
    }
  }

  // ─── Unscored ────────────────────────────────────────────
  if (unscored.length > 0) {
    console.log(`📋 ${unscored.length} jobs need scoring — run: node src/score.js 10`);
  }

  // ─── Commands ────────────────────────────────────────────
  console.log('═'.repeat(70));
  console.log('COMMANDS:');
  console.log('  node src/find.js                          Refresh listings');
  console.log('  node src/score.js 10                      Score N jobs');
  console.log('  node src/tailor.js <id>                   Generate CV + cover letter');
  console.log('  node src/email.js draft <id>              Preview email draft');
  console.log('  node src/email.js send <id> --to <email>  Send application');
  console.log('  node src/email.js status <id> <status>    Update status manually');
  console.log('  node src/email.js inbox                   Check active applications');
}

main();
