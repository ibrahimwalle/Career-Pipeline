// actions.js — Daily prioritized action list
// Combines: job age, scores, inbox results, application timeline
// Run: node src/actions.js                    (terminal)
//      node src/actions.js --no-inbox         (skip inbox scan)
//      node src/actions.js --no-inbox --json  (machine-readable JSON for dashboard)
// API: /api/actions           (dashboard)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');
const CONTRACT_JOBS_FILE = resolve(DATA_DIR, 'contract_jobs.json');
const INBOX_RESULTS_FILE = resolve(DATA_DIR, 'inbox_results.json');

const DAY = 86400000;
const ARGS = process.argv.slice(2);
const FLAG_NO_INBOX = ARGS.includes('--no-inbox');
const FLAG_JSON = ARGS.includes('--json');

function load(f) { return existsSync(f) ? JSON.parse(readFileSync(f,'utf-8')) : []; }
function daysAgo(d) { return d ? Math.round((Date.now() - new Date(d)) / DAY) : null; }
function daysOld(j) { return daysAgo(j.posted || j.scrapedAt); }

// ─── Action generators ──────────────────────────────────────

function followUpActions(jobs) {
  const applied = jobs.filter(j =>
    ['applied'].includes(j.status) && j.appliedAt && daysAgo(j.appliedAt) >= 7
  );
  return applied.map(j => {
    const age = daysAgo(j.appliedAt);
    return {
      priority: age > 21 ? 'HIGH' : age > 14 ? 'MEDIUM' : 'LOW',
      type: 'follow_up',
      title: `Follow up on application to ${j.company}`,
      detail: `Applied ${age}d ago for "${j.title}". No reply yet.`,
      job: j,
      suggested: age > 21
        ? 'Send a polite follow-up or consider this one cold. Move to rejected if no response after 30d.'
        : 'Send a brief follow-up email if you have a contact.',
      age_days: age,
    };
  }).sort((a,b) => b.age_days - a.age_days);
}

function urgentInboxActions(inboxResults) {
  // inboxResults comes from the /api/action/inbox endpoint result
  // For now, check if there were recent recruiter emails
  if (!inboxResults || !inboxResults.length) return [];
  return inboxResults
    .filter(e => ['interviewing', 'screening'].includes(e.classification))
    .map(e => ({
      priority: 'HIGH',
      type: 'reply_needed',
      title: `Reply to interview request from ${e.company || 'Unknown'}`,
      detail: `Email: "${e.subject}" from ${e.from}. Detected as: ${e.classification}.`,
      suggested: 'Reply within 24 hours. Schedule the call. Confirm availability and rate.',
    }));
}

function expiringJobs(jobs) {
  const expiring = jobs.filter(j => {
    if (j.score < 60) return false;
    if (['applied','screening','interviewing','offer','rejected'].includes(j.status)) return false;
    const age = daysOld(j);
    return age && age > 14;
  });
  return expiring.map(j => ({
    priority: j.score >= 80 ? 'HIGH' : j.score >= 70 ? 'MEDIUM' : 'LOW',
    type: 'expiring',
    title: `${j.score >= 80 ? 'STRONG MATCH' : 'Good fit'} — ${j.title} @ ${j.company} (${daysOld(j)}d old)`,
    detail: `Posted ${daysOld(j)}d ago. Score: ${j.score}/100. ${j.scoring?.reasoning || ''}`,
    job: j,
    suggested: j.score >= 80
      ? 'Apply TODAY. This job may close soon. Materials are ready — just send.'
      : 'Apply this week if still interested. Jobs older than 30d are likely filled.',
    age_days: daysOld(j),
  })).sort((a,b) => b.priority.localeCompare(a.priority) || b.age_days - a.age_days);
}

function freshHighMatchActions(jobs) {
  const fresh = jobs.filter(j => {
    if (j.score < 70) return false;
    if (j.status !== 'scored' && j.status !== 'new') return false;
    const age = daysOld(j);
    return age !== null && age <= 14;
  });
  return fresh.slice(0, 15).map(j => ({
    priority: j.score >= 85 ? 'HIGH' : j.score >= 75 ? 'MEDIUM' : 'LOW',
    type: 'fresh_match',
    title: `${j.score >= 85 ? 'TOP MATCH' : 'Good fit'} — ${j.title} @ ${j.company}`,
    detail: `Score: ${j.score}/100 (${j.verdict}). Posted ${daysOld(j)}d ago. ${j.scoring?.reasoning || ''}`,
    job: j,
    suggested: j.score >= 85
      ? 'Generate tailored materials and apply today.'
      : 'Generate tailored materials. Apply within 3 days.',
    age_days: daysOld(j),
  })).sort((a,b) => b.priority.localeCompare(a.priority) || (b.job?.score||0) - (a.job?.score||0));
}

function staleApplications(jobs) {
  return jobs.filter(j =>
    ['applied'].includes(j.status) && j.appliedAt && daysAgo(j.appliedAt) >= 30
  ).map(j => ({
    priority: 'LOW',
    type: 'close_out',
    title: `Close out: ${j.title} @ ${j.company} (${daysAgo(j.appliedAt)}d no reply)`,
    detail: `Applied ${daysAgo(j.appliedAt)}d ago. No response. Consider this one dead.`,
    suggested: 'Run: node src/email.js status ' + j.id + ' rejected',
  }));
}

function inboxReplyActions(inboxResults) {
  if (!inboxResults || !inboxResults.length) return [];
  return inboxResults
    .filter(e => e.classification === 'rejected' && e.company)
    .map(e => ({
      priority: 'LOW',
      type: 'rejection_acknowledged',
      title: `Rejected: ${e.company} — ${e.subject?.slice(0,50) || ''}`,
      detail: `From: ${e.from}. Status auto-updated to rejected.`,
      suggested: 'No action needed. The pipeline was updated.',
    }));
}

// ─── Load saved inbox results ────────────────────────────────

function loadInboxResults() {
  // Read previously-saved inbox scan results (from inbox.py --json)
  try {
    if (existsSync(INBOX_RESULTS_FILE)) {
      const data = JSON.parse(readFileSync(INBOX_RESULTS_FILE, 'utf-8'));
      return data.emails || [];
    }
  } catch {}
  return [];
}

// ─── Summarize ───────────────────────────────────────────────

function generateSummary(actions) {
  const high = actions.filter(a => a.priority === 'HIGH');
  const med = actions.filter(a => a.priority === 'MEDIUM');
  const total = actions.length;

  return {
    summary: `${high.length} urgent actions, ${med.length} medium priority, ${total} total items to review today.`,
    focus_today: high.length > 0
      ? high.map(a => a.title).slice(0, 3)
      : ['No urgent actions. Focus on fresh applications.'],
  };
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const permJobs = load(JOBS_FILE);
  const contractJobs = load(CONTRACT_JOBS_FILE);
  const allJobs = [...permJobs, ...contractJobs];

  // Load saved inbox results (from previous inbox.py --json scans)
  const inboxResults = FLAG_NO_INBOX ? [] : loadInboxResults();

  // Collect actions from all sources
  const actions = [
    ...urgentInboxActions(inboxResults),
    ...freshHighMatchActions(allJobs),
    ...expiringJobs(allJobs),
    ...followUpActions(allJobs),
    ...staleApplications(allJobs),
    ...inboxReplyActions(inboxResults),
  ];

  // Sort: HIGH → MEDIUM → LOW, then by age/score
  const priorityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  actions.sort((a,b) =>
    priorityOrder[a.priority] - priorityOrder[b.priority] ||
    (a.age_days||0) - (b.age_days||0) ||
    (b.job?.score||0) - (a.job?.score||0)
  );

  const info = generateSummary(actions);

  // Compute pipeline health
  const scored = allJobs.filter(j => j.score != null);
  const applied = allJobs.filter(j => ['applied','bid'].includes(j.status));
  const active = allJobs.filter(j => ['screening','interviewing','client_call'].includes(j.status));
  const offers = allJobs.filter(j => ['offer','won'].includes(j.status));
  const strong = scored.filter(j => j.score >= 80);
  const appliedStrong = strong.filter(j => ['applied','bid','screening','interviewing','client_call'].includes(j.status));

  const health = {
    total: allJobs.length,
    scored: scored.length,
    strong: strong.length,
    applied: applied.length,
    active: active.length,
    offers: offers.length,
    strongUnapplied: strong.length - appliedStrong.length,
    appliedRatio: strong.length > 0 ? Math.round(appliedStrong.length/strong.length*100) : 0,
  };

  // ─── JSON output mode (for dashboard) ──────────────────
  if (FLAG_JSON) {
    const output = {
      date: new Date().toISOString(),
      dateFormatted: new Date().toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long'}),
      summary: info.summary,
      focusToday: info.focus_today,
      totalActions: actions.length,
      highCount: actions.filter(a => a.priority === 'HIGH').length,
      mediumCount: actions.filter(a => a.priority === 'MEDIUM').length,
      lowCount: actions.filter(a => a.priority === 'LOW').length,
      health,
      inboxCount: inboxResults.length,
      actions: actions.map(a => ({
        priority: a.priority,
        type: a.type,
        title: a.title,
        detail: a.detail || '',
        suggested: a.suggested || '',
        ageDays: a.age_days || null,
        jobId: a.job?.id || null,
        jobUrl: a.job?.url || null,
        jobScore: a.job?.score || null,
        jobCompany: a.job?.company || null,
        jobTitle: a.job?.title || null,
        jobStatus: a.job?.status || null,
      })),
    };
    console.log(JSON.stringify(output));
    return;
  }

  // ─── Display (terminal) ────────────────────────────────
  const W = process.stdout.columns || 80;
  const pad = (s,n) => (s||'').padEnd(n);

  console.log('\n' + '═'.repeat(Math.min(W, 80)));
  console.log('  DAILY ACTION LIST — ' + new Date().toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long'}));
  console.log('═'.repeat(Math.min(W, 80)));
  console.log(`  ${info.summary}\n`);

  if (actions.length === 0) {
    console.log('  Nothing to do today. Run "node src/find.js && node src/score.js 20" to build your pipeline.\n');
    return;
  }

  const grouped = { HIGH: 'URGENT — Do Today', MEDIUM: 'This Week', LOW: 'Housekeeping' };

  for (const [level, label] of Object.entries(grouped)) {
    const items = actions.filter(a => a.priority === level);
    if (!items.length) continue;

    const icon = level === 'HIGH' ? '!' : level === 'MEDIUM' ? '·' : ' ';
    const color = level === 'HIGH' ? '\x1b[31m' : level === 'MEDIUM' ? '\x1b[33m' : '\x1b[0m';
    console.log(`  ${color}${label}${'\x1b[0m'}`);
    console.log('  ' + '─'.repeat(60));

    for (const a of items) {
      console.log(`  ${color}[${icon}] ${a.title}${'\x1b[0m'}`);
      if (a.detail) console.log(`      ${a.detail}`);
      if (a.suggested) console.log(`      \x1b[36m→ ${a.suggested}\x1b[0m`);
      if (a.job?.url) console.log(`      \x1b[90m${a.job.url}\x1b[0m`);
      if (a.job?.id) console.log(`      \x1b[90mID: ${a.job.id}\x1b[0m`);
      console.log();
    }
  }

  // ─── Pipeline health ──────────────────────────────────
  console.log('  PIPELINE HEALTH');
  console.log('  ' + '─'.repeat(60));
  console.log(`  Pipeline size:   ${allJobs.length} total  |  ${scored.length} scored  |  ${strong.length} strong matches`);
  console.log(`  Applications:    ${applied.length} sent  |  ${active.length} active conversations  |  ${offers.length} offers`);
  if (strong.length > 0) {
    console.log(`  Strong matches:  ${appliedStrong.length}/${strong.length} applied (${Math.round(appliedStrong.length/strong.length*100)}%)`);
  }
  if (strong.length > appliedStrong.length + 5) {
    console.log(`  \x1b[33m  ⚠ You have ${strong.length - appliedStrong.length} strong matches you haven't applied to yet!\x1b[0m`);
  }
  if (applied.length > 0 && active.length === 0) {
    console.log(`  \x1b[33m  ⚠ ${applied.length} applications sent, 0 active conversations. Review your approach?\x1b[0m`);
  }

  console.log(`\n  Run anytime: node src/actions.js`);
  console.log(`  Dashboard: node src/dashboard.js  →  http://localhost:3456\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
