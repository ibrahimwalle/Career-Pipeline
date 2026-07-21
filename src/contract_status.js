// contract_status.js — Contract pipeline dashboard
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const JOBS_FILE = resolve(ROOT, 'data', 'contract_jobs.json');

function daysAgo(dateStr) {
  if (!dateStr) return '—';
  const days = Math.round((Date.now() - new Date(dateStr)) / (1000 * 60 * 60 * 24));
  return days === 0 ? 'today' : `${days}d ago`;
}

function main() {
  if (!existsSync(JOBS_FILE)) {
    console.log('\n  No contract jobs yet. Start here:');
    console.log('    node src/contract_find.js        # Scrape contract platforms');
    console.log('    node src/contract_score.js 10    # Score top 10 against contract profile');
    process.exit(0);
  }

  const jobs = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  const scored = jobs.filter(j => j.score !== null).sort((a, b) => b.score - a.score);
  const unscored = jobs.filter(j => j.score === null);
  const applied = jobs.filter(j => j.status === 'applied' || j.status === 'bid');
  const interviewing = jobs.filter(j => j.status === 'interviewing' || j.status === 'client_call');
  const offer = jobs.filter(j => j.status === 'offer' || j.status === 'won');
  const rejected = jobs.filter(j => j.status === 'rejected' || j.status === 'lost');

  console.log('\n  CONTRACT PIPELINE');
  console.log('  ' + '═'.repeat(60));
  console.log(`  Total: ${jobs.length}  |  Scored: ${scored.length}  |  Applied/Bid: ${applied.length}  |  Calls: ${interviewing.length}  |  Won: ${offer.length}  |  Lost: ${rejected.length}`);

  // Show rate distribution
  const withRates = jobs.filter(j => j.rate);
  if (withRates.length > 0) {
    console.log(`\n  Rate range: ${withRates.length} jobs with rate info`);
  }

  if (scored.length > 0) {
    console.log('\n  TOP CONTRACT MATCHES:');
    console.log('  ' + '─'.repeat(60));
    const top = scored.slice(0, 10);
    for (const j of top) {
      const icon = j.verdict === 'BID' ? '[$]' : j.verdict === 'APPLY' ? '[+]' : j.verdict === 'REACH' ? '[?]' : '[x]';
      const bar = '█'.repeat(Math.round(j.score / 10)) + '░'.repeat(10 - Math.round(j.score / 10));
      const rate = j.rate ? ` [${j.rate.currency || ''} ${j.rate.min || '?'}-${j.rate.max || '?'}]` : '';
      const rateFit = j.scoring?.rate_fit ? ` rate:${j.scoring.rate_fit}` : '';
      console.log(`  ${icon} ${String(j.score).padStart(3)}/100 ${bar}  ${j.title} @ ${j.company}${rate}${rateFit}`);
      console.log(`       ${j.source}  |  ${j.url}`);
      if (j.scoring?.reasoning) console.log(`       ${j.scoring.reasoning}`);
      console.log();
    }
  }

  console.log('\n  COMMANDS:');
  console.log('    node src/contract_find.js           Refresh contract listings');
  console.log('    node src/contract_score.js 10       Score N contract jobs');
  console.log('    node src/contract_tailor.js <id>    Generate contract pitch + CV');
}

main();
