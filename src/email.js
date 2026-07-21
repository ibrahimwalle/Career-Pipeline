// email.js — Send applications & scan inbox for recruiter replies
// Uses Gmail SMTP (nodemailer) + Python IMAP scanner (built-in imaplib).
import { createTransport } from 'nodemailer';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');
const CONFIG_FILE = resolve(ROOT, 'email_config.json');
const RULES_FILE = resolve(ROOT, 'rules.json');

function loadRules() {
  if (!existsSync(RULES_FILE)) return { sending: { auto_send: { threshold: 'STRONG_MATCH' } } };
  return JSON.parse(readFileSync(RULES_FILE, 'utf-8'));
}

function canAutoSend(job, rules) {
  const threshold = rules?.sending?.auto_send?.threshold || 'STRONG_MATCH';
  const dryRunDefault = rules?.sending?.dry_run_default || false;
  if (dryRunDefault) return { allowed: false, reason: 'Dry-run mode is on (rules.json).' };
  if (!job.score && !job.verdict) return { allowed: false, reason: 'Job not scored yet. Score it first.' };
  if (threshold === 'STRONG_MATCH') {
    if (job.verdict === 'STRONG_MATCH' || job.score >= 80) return { allowed: true };
    return { allowed: false, reason: `Score ${job.score}/100 (${job.verdict}) is below STRONG_MATCH threshold. Review required.` };
  }
  if (threshold === 'GOOD_FIT') {
    if (['STRONG_MATCH', 'GOOD_FIT'].includes(job.verdict) || job.score >= 60) return { allowed: true };
    return { allowed: false, reason: `Score ${job.score}/100 (${job.verdict}) is below GOOD_FIT threshold. Review required.` };
  }
  return { allowed: false, reason: `Auto-send disabled in rules.json.` };
}

// ─── Config ─────────────────────────────────────────────────────

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    console.error('No email config found. Create email_config.json:');
    console.error(JSON.stringify({
      smtp: { host: "smtp.gmail.com", port: 587, user: "you@gmail.com", pass: "APP_PASSWORD_HERE" },
      imap: { host: "imap.gmail.com", port: 993, user: "you@gmail.com", pass: "APP_PASSWORD_HERE", tls: true },
      from: "Ibrahim Al Wali <you@gmail.com>",
      signature: "\n--\nIbrahim Al Wali\nibrahimwalle20@gmail.com\n+44 7762890154"
    }, null, 2));
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
}

function getTransporter(config) {
  return createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: false,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
}

// ─── Send Application Email ─────────────────────────────────────

async function sendApplication(jobId, opts = {}) {
  const config = loadConfig();
  const jobs = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  const job = jobs.find(j => j.id === jobId);
  if (!job) { console.error(`Job ${jobId} not found.`); process.exit(1); }

  const transporter = getTransporter(config);

  // Load tailored materials if they exist
  let coverLetter = '';
  const coverFile = resolve(ROOT, 'output', jobId, 'cover_letter.md');
  if (existsSync(coverFile)) {
    coverLetter = readFileSync(coverFile, 'utf-8');
  }

  const subject = opts.subject || `Application: ${job.title} — Ibrahim Al Wali`;
  const body = opts.body || coverLetter || `Hello,\n\nI am writing to apply for the ${job.title} position at ${job.company}.\n\nPlease find my CV attached.\n\nBest regards,\nIbrahim Al Wali`;

  const mailOptions = {
    from: config.from,
    to: opts.to || config.smtp.user, // Default to self — user fills the real address
    subject,
    text: body + (config.signature || ''),
    attachments: opts.attachments || [],
  };

  // Attach CV if available
  const cvPath = resolve(ROOT, 'profile', 'cv.md');
  const cvPdf = resolve(ROOT, '..', 'AI_CVs', 'IBRAHIM AL WALI - AI revised.pdf');
  if (existsSync(cvPdf) && !opts.noCv) {
    mailOptions.attachments.push({ path: cvPdf, filename: 'Ibrahim_Al_Wali_CV.pdf' });
  }

  // ─── Rules check ────────────────────────────────────────
  const rules = loadRules();
  const autoCheck = canAutoSend(job, rules);
  console.log(`\n📧 Application: ${job.title} @ ${job.company}`);
  console.log(`   Score: ${job.score || 'unscored'}/100 — ${job.verdict || 'unscored'}`);
  console.log(`   Auto-send: ${autoCheck.allowed ? '✅ ALLOWED (STRONG_MATCH)' : '⚠ REVIEW REQUIRED'}`);
  if (!autoCheck.allowed) {
    console.log(`   Reason: ${autoCheck.reason}`);
  }

  console.log(`\n   From: ${config.from}`);
  console.log(`   To: ${mailOptions.to}`);
  console.log(`   Subject: ${subject}`);

  if (opts.dryRun) {
    console.log(`\n⚠ PREVIEW ONLY — email NOT sent (--dry-run).`);
    console.log('─'.repeat(60));
    console.log(body.slice(0, 800));
    console.log('─'.repeat(60));
    return;
  }

  if (!autoCheck.allowed && !opts.force) {
    console.log(`\n⚠ PREVIEW ONLY — email NOT sent (${autoCheck.reason})`);
    console.log('─'.repeat(60));
    console.log(body.slice(0, 800));
    console.log('─'.repeat(60));
    console.log('\n💡 To send anyway:');
    console.log('   node src/email.js send <jobId> --to email@company.com --force');
    return;
  }

  if (opts.force) {
    console.log('   ⚠ Sending despite rules threshold (--force)');
  }

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`   ✅ Sent! Message ID: ${info.messageId}`);

    // Update job status
    const idx = jobs.findIndex(j => j.id === jobId);
    jobs[idx].status = 'applied';
    jobs[idx].appliedAt = new Date().toISOString();
    jobs[idx].appliedTo = mailOptions.to;
    jobs[idx].emailMessageId = info.messageId;
    writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));

    console.log(`   📝 Status updated → applied`);
  } catch (e) {
    console.error(`   ✗ Failed: ${e.message}`);
    console.error('\n💡 Gmail setup:');
    console.error('   1. Enable 2FA: https://myaccount.google.com/security');
    console.error('   2. Generate App Password: https://myaccount.google.com/apppasswords');
    console.error('   3. Paste it in email_config.json');
  }
}

// ─── Generate Email Draft ───────────────────────────────────────

async function generateDraft(jobId) {
  const config = loadConfig();
  const jobs = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  const job = jobs.find(j => j.id === jobId);
  if (!job) { console.error(`Job ${jobId} not found.`); process.exit(1); }

  // Load tailored materials
  const briefFile = resolve(ROOT, 'output', jobId, 'brief.md');
  const coverFile = resolve(ROOT, 'output', jobId, 'cover_letter.md');
  const brief = existsSync(briefFile) ? readFileSync(briefFile, 'utf-8') : '';
  const cover = existsSync(coverFile) ? readFileSync(coverFile, 'utf-8') : '';

  console.log(`\n📝 APPLICATION EMAIL DRAFT`);
  console.log('═'.repeat(60));
  console.log(`To: [FIND RECRUITER/HIRING MANAGER EMAIL]`);
  console.log(`From: ${config.from}`);
  console.log(`Subject: Application: ${job.title} — Ibrahim Al Wali`);
  console.log('═'.repeat(60));

  if (cover) {
    console.log(`\n${cover}`);
  } else {
    console.log(`\nHello,\n\nI am writing to apply for the ${job.title} position at ${job.company}.\n\nI am an AI Systems & Solutions Engineer with experience building production AI systems, backend infrastructure, and integration-heavy applications. My background aligns well with this role:\n\n- Built production systems serving 11,000+ users\n- Designed and delivered AI systems across legal, education, healthcare, and real estate\n- Experienced with Python/FastAPI, GCP, Docker, PostgreSQL, and AI/LLM pipelines\n\nI would love the opportunity to discuss how I can contribute to ${job.company}.\n\nCV attached.\n\nBest regards,\nIbrahim Al Wali`);
  }

  console.log('\n═'.repeat(60));
  console.log(`\n💡 Send with: node src/email.js send ${jobId} --to recruiter@company.com`);
  console.log(`   Preview only: node src/email.js send ${jobId} --dry-run`);
}

// ─── Monitor Inbox for Replies ──────────────────────────────────

async function monitorInbox(days = 14) {
  console.log(`\n📬 Connecting to ibrahimwalle20@gmail.com...`);
  console.log(`   Scanning last ${days} days for recruiter replies...\n`);

  try {
    const inboxScript = resolve(__dirname, 'inbox.py');
    if (!existsSync(inboxScript)) {
      console.error('❌ src/inbox.py not found.');
      process.exit(1);
    }

    // Run the Python inbox scanner (force UTF-8 for Windows)
    const result = execSync(`python "${inboxScript}" ${days}`, {
      cwd: ROOT,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    console.log(result);
  } catch (e) {
    if (e.stdout) console.log(e.stdout.toString());
    if (e.stderr) console.error(e.stderr.toString());
    if (!e.stdout && !e.stderr) {
      console.error(`\n❌ Could not connect to inbox.`);
      console.error('\n💡 Setup (one-time):');
      console.error('  1. Enable 2FA: https://myaccount.google.com/security');
      console.error('  2. App Password: https://myaccount.google.com/apppasswords');
      console.error('     Select "Mail" → "Other" → "Job Agent"');
      console.error('  3. Copy email_config.example.json → email_config.json');
      console.error('  4. Paste the 16-char password in both smtp.pass and imap.pass');
    }
  }
}

// ─── Status Update ──────────────────────────────────────────────

function updateStatus(jobId, newStatus) {
  if (!existsSync(JOBS_FILE)) { console.error('No jobs found.'); process.exit(1); }

  const valid = ['applied', 'screening', 'interviewing', 'offer', 'rejected', 'withdrawn', 'archived'];
  if (!valid.includes(newStatus)) {
    console.error(`Invalid status. Use: ${valid.join(', ')}`);
    process.exit(1);
  }

  const jobs = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'));
  const job = jobs.find(j => j.id === jobId);
  if (!job) { console.error(`Job ${jobId} not found.`); process.exit(1); }

  job.status = newStatus;
  job.statusUpdatedAt = new Date().toISOString();
  if (newStatus === 'interviewing') job.interviewingAt = new Date().toISOString();
  if (newStatus === 'rejected') job.rejectedAt = new Date().toISOString();
  if (newStatus === 'offer') job.offerAt = new Date().toISOString();

  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
  console.log(`✅ ${job.title} @ ${job.company} → ${newStatus}`);
}

// ─── CLI ────────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2];
  const jobId = process.argv[3];

  // Parse flags
  const flags = {};
  for (let i = 4; i < process.argv.length; i++) {
    if (process.argv[i] === '--to') flags.to = process.argv[++i];
    else if (process.argv[i] === '--dry-run') flags.dryRun = true;
    else if (process.argv[i] === '--no-cv') flags.noCv = true;
    else if (process.argv[i] === '--subject') flags.subject = process.argv[++i];
    else if (process.argv[i] === '--force') flags.force = true;
  }

  switch (cmd) {
    case 'send':
      if (!jobId) { console.error('Usage: node src/email.js send <jobId> --to email@company.com'); process.exit(1); }
      await sendApplication(jobId, flags);
      break;

    case 'draft':
      if (!jobId) { console.error('Usage: node src/email.js draft <jobId>'); process.exit(1); }
      await generateDraft(jobId);
      break;

    case 'inbox':
      await monitorInbox(parseInt(process.argv[3]) || 14);
      break;

    case 'status':
      if (!jobId) { console.error('Usage: node src/email.js status <jobId> <newStatus>'); process.exit(1); }
      updateStatus(jobId, process.argv[4] || 'applied');
      break;

    default:
      console.log(`
📧 Job Agent Email Commands
═══════════════════════════════════════════

  node src/email.js draft <jobId>
      Generate a ready-to-send email draft with tailored content

  node src/email.js send <jobId> --to <email>
      Send application email with CV attached
      --dry-run     Preview without sending
      --force       Send even if score is below auto-send threshold
      --no-cv       Skip CV attachment
      --subject     Custom subject line

      Auto-send rules (from rules.json):
        STRONG_MATCH (≥80): sent automatically
        GOOD_FIT / REACH / unscored: preview only, needs --force

  node src/email.js inbox [days]
      Scan your Gmail inbox for recruiter replies
      Auto-detects: interviews, rejections, offers, screening calls
      Auto-updates pipeline statuses in data/jobs.json
      Default: last 14 days. Example: node src/email.js inbox 7

  node src/email.js status <jobId> <newStatus>
      Update application status manually
      (applied | screening | interviewing | offer | rejected | archived)

SETUP (one-time):
  1. Enable 2FA on your Gmail: https://myaccount.google.com/security
  2. Generate App Password: https://myaccount.google.com/apppasswords
     Select "Mail" → "Other" → "Job Agent"
  3. Copy email_config.example.json → email_config.json
  4. Paste the 16-char code in both smtp.pass and imap.pass
  5. Test inbox scan: node src/email.js inbox 7
  6. npm install nodemailer (already installed)

RULES (rules.json):
  📬 Inbox: read unlimited, write blocked, pipeline companies only
  ✉️ Send: auto-send STRONG_MATCH, review required below
  📝 Pipeline: auto-update statuses on recruiter reply

email_config.json template:
  {
    "smtp": {
      "host": "smtp.gmail.com",
      "port": 587,
      "user": "ibrahimwalle20@gmail.com",
      "pass": "YOUR_16_CHAR_APP_PASSWORD"
    },
    "from": "Ibrahim Al Wali <ibrahimwalle20@gmail.com>",
    "signature": "\\n--\\nIbrahim Al Wali\\nibrahimwalle20@gmail.com\\n+44 7762890154"
  }
`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
