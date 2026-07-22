// app.js — Interactive Terminal UI for Job Pipeline
// Pure Node.js, zero dependencies. Keyboard-driven like lazydocker/lazygit.
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');

// ─── State ──────────────────────────────────────────────────
let tab = 'perm';          // 'perm' | 'contract'
let jobs = [];
let filter = 'all';        // 'all' | 'scored' | 'applied' | 'interviewing' | 'offer' | 'rejected'
let sortCol = 'score';
let sortDir = 'desc';
let selected = 0;
let scroll = 0;
let search = '';
let expanded = null;
let msg = '';
let msgTimer = null;

// ─── ANSI escape helpers ────────────────────────────────────
const CSI = '\x1b[';
const HOME = CSI + 'H';
const CLEAR = CSI + '2J';
const HIDE = CSI + '?25l';
const SHOW = CSI + '?25h';
const ALT = CSI + '?1049h';  // alt screen
const DEALT = CSI + '?1049l';
function pos(r, c) { return CSI + r + ';' + c + 'H'; }
const R = '\x1b[0m';
const B = '\x1b[1m';
const DIM = '\x1b[2m';
const FG = (n) => CSI + '38;5;' + n + 'm';
const BG = (n) => CSI + '48;5;' + n + 'm';

// Colors
const C = { bg: 234, surface: 236, border: 240, text: 250, muted: 243, accent: 39, green: 76, yellow: 178, red: 203, purple: 141, white: 255 };

function F(n) { return CSI + '38;5;' + n + 'm'; }
function Bg(n) { return CSI + '48;5;' + n + 'm'; }
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ─── Data loading ───────────────────────────────────────────
function loadJobs() {
  const file = tab === 'perm' ? 'jobs.json' : 'contract_jobs.json';
  const path = resolve(DATA_DIR, file);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function getAPI() {
  return tab === 'perm'
    ? { stats: '/api/stats', scored: 'scored', applied: ['applied'], interviewing: ['interviewing'], offer: ['offer'], rejected: ['rejected'], strongLabel: 'Strong Match', goodLabel: 'Good Fit', cmd: 'tailor.js' }
    : { stats: '/api/contract-stats', scored: 'scored', applied: ['applied','bid'], interviewing: ['interviewing','client_call'], offer: ['offer','won'], rejected: ['rejected','lost'], strongLabel: 'Bid Now', goodLabel: 'Apply', cmd: 'contract_tailor.js' };
}

// ─── Filtering / sorting ────────────────────────────────────
function filteredJobs() {
  let j = [...jobs];
  const api = getAPI();
  if (filter === 'scored') j = j.filter(x => x.score != null);
  else if (api.applied.includes(filter)) j = j.filter(x => api.applied.includes(x.status));
  else if (api.interviewing.includes(filter)) j = j.filter(x => api.interviewing.includes(x.status));
  else if (api.offer.includes(filter)) j = j.filter(x => api.offer.includes(x.status));
  else if (api.rejected.includes(filter)) j = j.filter(x => api.rejected.includes(x.status));
  if (search) {
    const q = search.toLowerCase();
    j = j.filter(x => (x.title + x.company + (x.location||'')).toLowerCase().includes(q));
  }
  j.sort((a, b) => {
    let va, vb;
    if (sortCol === 'score') { va = a.score || -1; vb = b.score || -1; }
    else if (sortCol === 'company') { va = (a.company||'').toLowerCase(); vb = (b.company||'').toLowerCase(); }
    else { va = new Date(b.posted||0); vb = new Date(a.posted||0); }
    if (sortDir === 'desc') return vb > va ? 1 : vb < va ? -1 : 0;
    return va > vb ? 1 : va < vb ? -1 : 0;
  });
  return j;
}

// ─── Render ─────────────────────────────────────────────────
function render() {
  const W = process.stdout.columns || 120;
  const H = process.stdout.rows || 40;
  const filtered = filteredJobs();
  const api = getAPI();

  // Clamp selection
  if (selected >= filtered.length && filtered.length > 0) selected = filtered.length - 1;
  if (selected < 0) selected = 0;

  // Scroll
  const listStart = 7;
  const listH = H - listStart - 4; // 4 for status bar
  if (selected < scroll) scroll = selected;
  if (selected >= scroll + listH) scroll = selected - listH + 1;
  const visible = filtered.slice(scroll, scroll + listH);

  let out = '';
  out += HIDE;

  // ── Header ──
  out += pos(1, 1) + Bg(C.surface) + F(C.text);
  out += ' '.repeat(W);
  out += pos(1, 2) + B + 'Job Pipeline' + R + Bg(C.surface) + DIM + '  Ibrahim Al Wali — AI Systems & Solutions Engineer' + R;
  out += pos(2, 1) + Bg(C.bg);

  // Tabs
  const tabW = 18;
  out += pos(2, 2) + F(C.white);
  out += (tab === 'perm' ? Bg(C.accent) + F(C.white) : Bg(C.surface) + F(C.muted)) + '  Permanent  ' + R;
  out += ' ';
  out += (tab === 'contract' ? Bg(C.accent) + F(C.white) : Bg(C.surface) + F(C.muted)) + '  Contract   ' + R;
  out += ' '.repeat(W - 35);

  // Stats
  const scored = jobs.filter(j => j.score != null).length;
  const applied = jobs.filter(j => api.applied.includes(j.status)).length;
  const interviewing = jobs.filter(j => api.interviewing.includes(j.status)).length;
  const offer = jobs.filter(j => api.offer.includes(j.status)).length;
  const strong = jobs.filter(j => (j.verdict === 'STRONG_MATCH' || j.verdict === 'BID' || j.score >= 80)).length;

  out += pos(3, 2) + DIM;
  out += F(C.green) + B + String(strong).padStart(3) + R + DIM + ' ' + api.strongLabel + 's  ';
  out += F(C.accent) + B + String(scored).padStart(3) + R + DIM + ' Scored  ';
  out += F(C.accent) + B + String(applied).padStart(3) + R + DIM + ' Applied  ';
  out += F(C.green) + B + String(interviewing).padStart(3) + R + DIM + ' Active  ';
  out += F(C.yellow) + B + String(offer).padStart(3) + R + DIM + ' Won  ';
  out += F(C.red) + B + String(jobs.length).padStart(4) + R + DIM + ' Total';

  // ── Filter bar ──
  const filters = ['all', 'scored', 'applied', 'interviewing', 'offer', 'rejected'];
  out += pos(4, 2);
  for (const f of filters) {
    const label = f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1);
    if (filter === f) out += Bg(C.accent) + F(C.white) + ' ' + label + ' ' + R + ' ';
    else out += DIM + ' ' + label + ' ' + R + ' ';
  }
  out += '  ' + DIM + 'Search: ' + R + (search ? F(C.white) + search + F(C.muted) + '█' : DIM + '/ to search' + R);
  out += pos(4, W - 20) + DIM + pad(String(filtered.length), 4) + ' jobs' + R;

  // ── Column headers ──
  out += pos(5, 2) + DIM + 'Score  Role                                                     Company              Location         Status' + R;
  out += pos(6, 2) + DIM + '─'.repeat(W - 4) + R;

  // ── Job rows ──
  for (let i = 0; i < visible.length; i++) {
    const j = visible[i];
    const isSel = (i + scroll) === selected;
    const isExp = (i + scroll) === expanded;
    const row = listStart + i;
    const y = row;

    out += pos(y, 1) + (isSel ? Bg(C.accent) + F(C.white) : isExp ? Bg(C.surface) : Bg(C.bg));
    out += ' ';

    // Score badge
    const s = j.score != null ? String(j.score) : '—';
    const scoreColor = j.score >= 80 ? C.green : j.score >= 60 ? C.yellow : C.red;
    out += (isSel ? F(C.white) + B : F(scoreColor)) + pad(s, 5) + R;
    if (isSel) out += Bg(C.accent) + F(C.white); else if (isExp) out += Bg(C.surface); else out += R;

    // Title
    out += ' ' + trunc(j.title || '', 46).padEnd(47);
    // Company
    out += ' ' + trunc(j.company || '', 22).padEnd(23);
    // Location
    out += ' ' + trunc((j.location || 'Remote'), 16).padEnd(17);
    // Status
    const status = j.status || 'new';
    const statColor = status === 'interviewing' || status === 'client_call' ? C.green
      : status === 'offer' || status === 'won' ? C.yellow
      : status === 'rejected' || status === 'lost' ? C.red
      : status === 'applied' || status === 'bid' ? C.accent
      : C.muted;
    out += F(statColor) + status + R;

    // Rate info for contracts
    if (tab === 'contract' && j.rate) {
      out += DIM + '  ' + (j.rate.currency || '') + ' ' + (j.rate.min || '?') + '–' + (j.rate.max || '?') + R;
    }

    out += ' '.repeat(W - 120 > 0 ? W - 120 : 0);

    // Expanded detail
    if (isExp) {
      const x = row + 1;
      const detailBg = isSel ? Bg(C.surface) : Bg(C.surface);
      out += pos(x, 2) + detailBg + F(C.text) + ' '.repeat(W - 4);
      if (j.scoring?.reasoning) {
        out += pos(x, 4) + detailBg + F(C.accent) + j.scoring.reasoning + R;
      }
      if (j.scoring?.strengths?.length) {
        out += pos(x + 1, 4) + detailBg + F(C.green) + 'Strengths: ' + R + F(C.text) + j.scoring.strengths.slice(0, 3).join('  |  ') + R;
      }
      if (j.scoring?.gaps?.length) {
        out += pos(x + 2, 4) + detailBg + F(C.yellow) + 'Gaps: ' + R + F(C.text) + j.scoring.gaps.slice(0, 3).join('  |  ') + R;
      }
      if (tab === 'contract' && j.scoring?.rate_fit) {
        out += pos(x + 3, 4) + detailBg + F(C.yellow) + 'Rate: ' + R + F(C.text) + j.scoring.rate_fit + (j.scoring.ir35_note ? '  |  IR35: ' + j.scoring.ir35_note : '') + R;
      }
      out += R;
    }
  }

  // ── Status bar ──
  out += pos(H - 3, 1) + Bg(C.accent) + F(C.white) + ' '.repeat(W);
  let cmds = 'j/k: move  enter: expand  tab: switch  /: search  s: score  t: tailor  o: open  r: refresh  q: quit';
  // Truncate if narrow
  if (W < 80) cmds = 'j/k:move  enter:expand  tab:switch  s:score  q:quit';
  out += pos(H - 3, 2) + Bg(C.accent) + F(C.white) + B + cmds + R;

  // Message toast
  if (msg) {
    out += pos(H - 2, 2) + F(C.yellow) + msg + R;
  }

  // Clear to end
  out += pos(H, 1) + R;

  process.stdout.write(out);
}

// ─── Actions ────────────────────────────────────────────────
function showMsg(text, duration = 3000) {
  msg = text;
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { msg = ''; render(); }, duration);
}

async function actionScore() {
  const filtered = filteredJobs();
  if (filtered.length === 0) { showMsg('No jobs to score'); return; }
  const job = filtered[selected];
  if (!job) return;

  const cmd = tab === 'perm' ? 'score.js' : 'contract_score.js';
  const script = resolve(__dirname, cmd);

  showMsg(`Scoring via Claude...`);
  render();

  try {
    // Run claude directly for this single job
    const promptFile = resolve(DATA_DIR, 'tui_prompts', `score_${job.id}.txt`);
    if (!existsSync(resolve(DATA_DIR, 'tui_prompts'))) mkdirSync(resolve(DATA_DIR, 'tui_prompts'), { recursive: true });

    // Build prompt based on tab
    let prompt;
    if (tab === 'perm') {
      prompt = `Score this job against my profile (read profile/master_doc.md). Return a JSON object with NO other text: {"score":<0-100>,"verdict":"<STRONG_MATCH|GOOD_FIT|REACH|SKIP>","strengths":["<3 matches>"],"gaps":["<3 gaps>"],"tailoring_angles":["<3 angles>"],"reasoning":"<2 sentences>"}\n\nJob:\nTitle: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location}\nURL: ${job.url}\nDescription: ${(job.description||'').slice(0,4000)}`;
    } else {
      prompt = `Score this contract role against my profile (read profile/contract_profile.json and profile/master_doc.md). Return a JSON object with NO other text: {"score":<0-100>,"verdict":"<BID|APPLY|REACH|SKIP>","rate_fit":"<UNDER|IN_RANGE|ABOVE|UNKNOWN>","rate_note":"<note>","strengths":["<3 matches>"],"gaps":["<2-3 gaps>"],"pitch_angles":["<3 angles>"],"ir35_note":"<note>","reasoning":"<2 sentences>"}\n\nJob:\nTitle: ${job.title}\nCompany: ${job.company}\nSource: ${job.source}\nLocation: ${job.location}\nURL: ${job.url}\nDescription: ${(job.description||'').slice(0,4000)}`;
    }
    writeFileSync(promptFile, prompt);

    const result = execSync(`claude --print --output-format text --dangerously-skip-permissions`, { cwd: ROOT, timeout: 120000, maxBuffer: 1024 * 1024, encoding: 'utf-8', input: readFileSync(promptFile, 'utf-8') });
    const jsonMatch = result.match(/\{[\s\S]*"score"[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      // Update the job in the file
      const file = tab === 'perm' ? 'jobs.json' : 'contract_jobs.json';
      const path = resolve(DATA_DIR, file);
      const allJobs = JSON.parse(readFileSync(path, 'utf-8'));
      const idx = allJobs.findIndex(j => j.id === job.id);
      if (idx !== -1) {
        allJobs[idx].score = parsed.score;
        allJobs[idx].verdict = parsed.verdict;
        allJobs[idx].scoring = parsed;
        allJobs[idx].status = 'scored';
        allJobs[idx].scoredAt = new Date().toISOString();
        writeFileSync(path, JSON.stringify(allJobs, null, 2));
        jobs = allJobs;
        showMsg(`Scored: ${parsed.score}/100 — ${parsed.verdict}`);
      }
    } else {
      showMsg('Could not parse Claude response', 5000);
    }
  } catch (e) {
    showMsg(`Error: ${e.message}`, 5000);
  }
}

async function actionTailor() {
  const filtered = filteredJobs();
  if (filtered.length === 0) return;
  const job = filtered[selected];
  if (!job) return;

  if (!job.score) { showMsg('Score this job first (press s)'); return; }

  const script = tab === 'perm' ? 'tailor.js' : 'contract_tailor.js';
  showMsg(`Tailoring via Claude...`);
  render();

  try {
    const child = spawn('node', [resolve(__dirname, script), job.id], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    let output = '';
    child.stdout.on('data', d => output += d.toString());
    child.stderr.on('data', d => output += d.toString());

    await new Promise((resolve, reject) => {
      child.on('close', resolve);
      child.on('error', reject);
    });

    if (output.includes('Materials saved') || output.includes('saved to')) {
      const outDir = output.match(/output\/(?:contracts\/)?([^\s]+)/);
      showMsg(`Materials generated: ${outDir ? outDir[0] : 'output/'}`);
    } else {
      showMsg('Tailored. Check output/ directory.');
    }
  } catch (e) {
    showMsg(`Error: ${e.message}`, 5000);
  }
}

function actionOpen() {
  const filtered = filteredJobs();
  if (filtered.length === 0) return;
  const job = filtered[selected];
  if (!job?.url) return;
  try {
    const cmd = process.platform === 'win32'
      ? `start "" "${job.url}"`
      : process.platform === 'darwin'
        ? `open "${job.url}"`
        : `xdg-open "${job.url}"`;
    execSync(cmd, { stdio: 'ignore', timeout: 5000 });
    showMsg(`Opened: ${job.company}`);
  } catch {}
}

// ─── Keyboard ───────────────────────────────────────────────
function setupInput() {
  const rl = createInterface({ input: process.stdin });
  process.stdin.setRawMode(true);
  let searchMode = false;

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;

    // Search mode
    if (searchMode) {
      if (key.name === 'escape' || key.name === 'return') {
        searchMode = false;
        render();
        return;
      }
      if (key.name === 'backspace') {
        search = search.slice(0, -1);
        selected = 0; scroll = 0;
        render();
        return;
      }
      if (str && str.length === 1 && !key.ctrl) {
        search += str;
        selected = 0; scroll = 0;
        render();
        return;
      }
      return;
    }

    const filtered = filteredJobs();

    switch (key.name) {
      case 'q': process.stdout.write(CLEAR + HOME + SHOW + DEALT); process.exit(0);
      case 'tab': tab = tab === 'perm' ? 'contract' : 'perm'; selected = 0; scroll = 0; expanded = null; jobs = loadJobs(); render(); break;
      case 'j': case 'down': if (selected < filtered.length - 1) selected++; render(); break;
      case 'k': case 'up': if (selected > 0) selected--; render(); break;
      case 'g': if (key.shift) { selected = filtered.length - 1; render(); } else { selected = 0; scroll = 0; render(); } break;
      case 'return': expanded = expanded === selected ? null : selected; render(); break;
      case 'escape': expanded = null; render(); break;
      case 's': if (!key.ctrl) actionScore(); break;
      case 't': actionTailor(); break;
      case 'o': actionOpen(); break;
      case 'r': jobs = loadJobs(); expanded = null; selected = 0; scroll = 0; showMsg('Refreshed'); break;
      case '/': searchMode = true; search = ''; selected = 0; scroll = 0; render(); break;
      case '1': filter = 'all'; selected = 0; scroll = 0; expanded = null; render(); break;
      case '2': filter = 'scored'; selected = 0; scroll = 0; expanded = null; render(); break;
      case '3': filter = 'applied'; selected = 0; scroll = 0; expanded = null; render(); break;
      case '4': filter = 'interviewing'; selected = 0; scroll = 0; expanded = null; render(); break;
      case '5': filter = 'offer'; selected = 0; scroll = 0; expanded = null; render(); break;
      case '6': filter = 'rejected'; selected = 0; scroll = 0; expanded = null; render(); break;
    }
  });

  return rl;
}

// ─── Main ───────────────────────────────────────────────────
function main() {
  process.stdout.write(ALT + CLEAR + HOME);
  process.on('exit', () => process.stdout.write(CLEAR + HOME + SHOW + DEALT));
  process.on('SIGINT', () => process.exit(0));

  jobs = loadJobs();
  setupInput();
  render();
}

main();
