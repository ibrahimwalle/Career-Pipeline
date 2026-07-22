// dashboard.js — Web dashboard + action API
// Serve HTML + wire all pipeline actions through /api/action/* endpoints
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');
const CONTRACT_JOBS_FILE = resolve(DATA_DIR, 'contract_jobs.json');
const LAST_ACTIONS_FILE = resolve(DATA_DIR, 'last_actions.json');
const PORT = 3456;

// ─── Running jobs tracker (for polling status) ──────────────
const running = new Map(); // id → { type, status, started, log }

// ─── Inbox results cache ─────────────────────────────────────
let lastInboxResults = null; // { scannedAt, days, totalFound, emails: [...] }
const INBOX_RESULTS_FILE = resolve(DATA_DIR, 'inbox_results.json');

function loadInboxResultsFromDisk() {
  try {
    if (existsSync(INBOX_RESULTS_FILE)) {
      return JSON.parse(readFileSync(INBOX_RESULTS_FILE, 'utf-8'));
    }
  } catch {}
  return null;
}

function runId() { return 'run_' + Math.random().toString(36).slice(2, 8); }

const MIME = { '.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json' };

function loadJobs(pipeline='perm') {
  const f = pipeline === 'contract' ? CONTRACT_JOBS_FILE : JOBS_FILE;
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : [];
}

function serveFile(res, path) {
  try {
    if (!existsSync(path)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(readFileSync(path));
  } catch { res.writeHead(500); res.end(); }
}

function json(res, data, code=200) {
  res.writeHead(code, { 'Content-Type':'application/json' });
  res.end(JSON.stringify(data));
}

function runScript(script, args=[], type, pipeline) {
  const id = runId();
  const entry = { id, type, pipeline, started: Date.now(), status:'running', log:'' };
  running.set(id, entry);

  const child = spawn('node', [resolve(__dirname, script), ...args], {
    cwd: ROOT, stdio: ['ignore','pipe','pipe'], timeout: 300000,
    env: { ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1' }
  });
  entry.child = child;
  child.stdout.on('data', d => { entry.log += d.toString(); if (entry.log.length > 10000) entry.log = entry.log.slice(-8000); });
  child.stderr.on('data', d => { entry.log += d.toString(); });
  child.on('close', code => {
    entry.status = code === 0 ? 'done' : 'error';
    entry.ended = Date.now();
  });
  child.on('error', e => { entry.status = 'error'; entry.log += e.message; entry.ended = Date.now(); });
  return entry;
}

// ─── Server ─────────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // ── Data APIs (read-only) ──────────────────────────────
  if (p === '/api/jobs' || p === '/api/contract-jobs') {
    const pipeline = p.includes('contract') ? 'contract' : 'perm';
    let jobs = loadJobs(pipeline);
    const filter = url.searchParams.get('status') || 'all';
    const sort = url.searchParams.get('sort') || 'score';
    if (filter !== 'all') jobs = jobs.filter(j => j.status === filter);
    if (sort === 'score') jobs.sort((a,b) => (b.score||0)-(a.score||0));
    else if (sort === 'date') jobs.sort((a,b) => new Date(b.posted||0)-new Date(a.posted||0));
    else if (sort === 'company') jobs.sort((a,b) => (a.company||'').localeCompare(b.company||''));
    return json(res, jobs);
  }

  if (p === '/api/stats' || p === '/api/contract-stats') {
    const isC = p.includes('contract');
    const jobs = loadJobs(isC ? 'contract' : 'perm');
    const stats = {
      total: jobs.length,
      scored: jobs.filter(j => j.score != null).length,
      applied: jobs.filter(j => isC ? ['applied','bid'].includes(j.status) : j.status==='applied').length,
      interviewing: jobs.filter(j => isC ? ['interviewing','client_call'].includes(j.status) : ['interviewing','screening'].includes(j.status)).length,
      offer: jobs.filter(j => isC ? ['offer','won'].includes(j.status) : j.status==='offer').length,
      rejected: jobs.filter(j => isC ? ['rejected','lost'].includes(j.status) : j.status==='rejected').length,
      strong: jobs.filter(j => (j.score||0) >= 80).length,
    };
    jobs.forEach(j => { stats[`src_${j.source}`] = (stats[`src_${j.source}`]||0)+1; });
    return json(res, stats);
  }

  if (p === '/api/config') {
    const cfgPath = resolve(ROOT, 'scrape_config.json');
    if (!existsSync(cfgPath)) return json(res, { strict_filter: { strict_mode: false } });
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    return json(res, { strict_filter: cfg.strict_filter || { strict_mode: false } });
  }

  if (p.startsWith('/api/job/')) {
    const jobId = p.replace('/api/job/', '');
    const jobs = [...loadJobs('perm'), ...loadJobs('contract')];
    const job = jobs.find(j => j.id === jobId);
    return job ? json(res, job) : json(res, {error:'Not found'}, 404);
  }

  // ── Running jobs status (includes live log tail) ────────
  if (p === '/api/running') {
    const list = [...running.values()].map(r => ({
      id:r.id, type:r.type, pipeline:r.pipeline, status:r.status,
      started:r.started, ended:r.ended,
      step: r.step, stepLabel: r.stepLabel, totalSteps: r.totalSteps,
      log: r.log ? r.log.slice(-2000).split('\n').slice(-15).join('\n') : ''
    }));
    return json(res, list);
  }

  if (p === '/api/running/log') {
    const rid = url.searchParams.get('id');
    const r = running.get(rid);
    if (!r) return json(res, {error:'not found'}, 404);
    return json(res, { log: r.log.slice(-5000), status: r.status });
  }

  // ── ACTION APIs (POST triggers) ─────────────────────────
  if (p === '/api/action/scrape') {
    const pipeline = url.searchParams.get('pipeline') || 'perm';
    const source = url.searchParams.get('source') || 'ats';

    // Standalone sources — single script, no chaining
    if (source === 'linkedin') {
      const entry = runScript('linkedin_find.js', [], 'scrape_linkedin', pipeline);
      return json(res, { id: entry.id, status: 'started', message: `Scraping LinkedIn ${pipeline} jobs...` });
    }
    if (source === 'linkedin-contract') {
      const entry = runScript('linkedin_contract_find.js', [], 'scrape_linkedin_contract', pipeline);
      return json(res, { id: entry.id, status: 'started', message: `Scraping LinkedIn contract jobs...` });
    }
    if (source === 'hackernews') {
      const entry = runScript('hn_contract_find.js', [], 'scrape_hackernews', pipeline);
      return json(res, { id: entry.id, status: 'started', message: `Scraping Hacker News contract jobs...` });
    }
    if (source === 'bayt') {
      const entry = runScript('bayt_find.js', [], 'scrape_bayt', 'mena');
      return json(res, { id: entry.id, status: 'started', message: `Scraping Bayt.com (MENA)...` });
    }
    if (source === 'himalayas') {
      const entry = runScript('himalayas_find.js', [], 'scrape_himalayas', 'perm');
      return json(res, { id: entry.id, status: 'started', message: `Scraping Himalayas.app...` });
    }

    // source=ats (default) — chain ATS + LinkedIn + Himalayas (3-step pipeline)
    if (pipeline === 'perm') {
      const totalSteps = 3;
      const entry = {
        id: runId(), type: 'scrape', pipeline: 'perm', started: Date.now(), status: 'running',
        step: 1, totalSteps, stepLabel: 'Finding jobs (ATS)...',
        log: 'Step 1/3: ATS (Greenhouse, Lever, Ashby, SmartRecruiters, Remote)...\n'
      };
      running.set(entry.id, entry);

      // Step 1: ATS scrapers (find.js + smartrecruiters_find.js + remotive_find.js)
      const step1 = spawn('node', [resolve(__dirname, 'find.js')], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });
      entry.child = step1;
      step1.stdout.on('data', d => { entry.log += d.toString(); if (entry.log.length > 10000) entry.log = entry.log.slice(-8000); });
      step1.stderr.on('data', d => { entry.log += d.toString(); });
      step1.on('close', code => {
        entry.step = 2; entry.stepLabel = 'Finding jobs (LinkedIn)...';
        entry.log += 'Step 1 complete. Step 2/3: LinkedIn...\n';

        // Step 2: LinkedIn scraper (non-fatal)
        const step2 = spawn('node', [resolve(__dirname, 'linkedin_find.js')], {
          cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        });
        entry.child = step2;
        step2.stdout.on('data', d => { entry.log += d.toString(); if (entry.log.length > 10000) entry.log = entry.log.slice(-8000); });
        step2.stderr.on('data', d => { entry.log += d.toString(); });
        step2.on('close', linkedinCode => {
          if (linkedinCode !== 0) { entry.log += 'Step 2 warning — LinkedIn had issues. Continuing...\n'; }
          entry.step = 3; entry.stepLabel = 'Finding jobs (Himalayas)...';
          entry.log += 'Step 2 done. Step 3/3: Himalayas (API)...\n';

          // Step 3: Himalayas (free API, fast, non-fatal)
          const step3 = spawn('node', [resolve(__dirname, 'himalayas_find.js')], {
            cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
          });
          entry.child = step3;
          step3.stdout.on('data', d => { entry.log += d.toString(); if (entry.log.length > 10000) entry.log = entry.log.slice(-8000); });
          step3.stderr.on('data', d => { entry.log += d.toString(); });
          step3.on('close', himCode => {
            if (himCode !== 0) { entry.log += 'Step 3 warning — Himalayas had issues.\n'; }
            else { entry.log += 'Step 3 complete. All sources saved.\n'; }
            entry.status = 'done'; entry.ended = Date.now();
          });
          step3.on('error', e => {
            entry.log += 'Step 3 error (non-fatal): ' + e.message + '\n';
            entry.status = 'done'; entry.ended = Date.now();
          });
        });
        step2.on('error', e => {
          entry.log += 'Step 2 error (non-fatal): ' + e.message + ' — continuing to Step 3...\n';
          entry.step = 3; entry.stepLabel = 'Finding jobs (Himalayas)...';
          const step3 = spawn('node', [resolve(__dirname, 'himalayas_find.js')], {
            cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
          });
          entry.child = step3;
          step3.stdout.on('data', d => { entry.log += d.toString(); });
          step3.stderr.on('data', d => { entry.log += d.toString(); });
          step3.on('close', () => { entry.status = 'done'; entry.ended = Date.now(); });
          step3.on('error', () => { entry.status = 'done'; entry.ended = Date.now(); });
        });
      });
      step1.on('error', e => {
        entry.status = 'error'; entry.log += 'Step 1 error: ' + e.message + '\n'; entry.ended = Date.now();
      });

      return json(res, { id: entry.id, status: 'started', message: 'Finding jobs: ATS → LinkedIn → Himalayas (3 steps)...' });
    }

    // Contract pipeline or unrecognized source — single script, no chaining
    {
      const script = pipeline === 'contract' ? 'contract_find.js' : 'find.js';
      const entry = runScript(script, [], 'scrape', pipeline);
      return json(res, { id: entry.id, status: 'started', message: `Scraping ${pipeline} jobs...` });
    }
  }

  if (p === '/api/action/score') {
    const pipeline = url.searchParams.get('pipeline') || 'perm';
    const count = parseInt(url.searchParams.get('count') || '10');
    const script = pipeline === 'contract' ? 'contract_score.js' : 'score.js';
    const entry = runScript(script, [String(count)], 'score', pipeline);
    return json(res, { id: entry.id, status: 'started', message: `Scoring ${count} ${pipeline} jobs...` });
  }

  if (p === '/api/action/score-one') {
    const jobId = url.searchParams.get('id');
    if (!jobId) return json(res, {error:'id required'}, 400);
    // Run tailored scoring for one job inline via Claude
    const jobs = [...loadJobs('perm'), ...loadJobs('contract')];
    const job = jobs.find(j => j.id === jobId);
    if (!job) return json(res, {error:'job not found'}, 404);
    const pipeline = jobId.startsWith('gh_') || jobId.startsWith('lv_') || jobId.startsWith('ab_') ? 'perm' : 'contract';

    const entry = { id: runId(), type:'score-one', pipeline, started: Date.now(), status:'running', log:'' };
    running.set(entry.id, entry);

    // Score inline so we can return the result directly
    (async () => {
      try {
        const promptDir = resolve(DATA_DIR, 'dash_prompts');
        if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });
        const promptFile = resolve(promptDir, `score_${jobId}.txt`);

        let prompt;
        if (pipeline === 'perm') {
          prompt = `Score this job against my profile (read profile/master_doc.md). Return a JSON object with NO other text: {"score":<0-100>,"verdict":"<STRONG_MATCH|GOOD_FIT|REACH|SKIP>","strengths":["<3 matches>"],"gaps":["<3 gaps>"],"tailoring_angles":["<3 angles>"],"reasoning":"<2 sentences>"}\n\nJob:\nTitle: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location}\nURL: ${job.url}\nDescription: ${(job.description||'').slice(0,4000)}`;
        } else {
          prompt = `Score this contract role against my profile (read profile/contract_profile.json and profile/master_doc.md). Return a JSON object with NO other text: {"score":<0-100>,"verdict":"<BID|APPLY|REACH|SKIP>","rate_fit":"<UNDER|IN_RANGE|ABOVE|UNKNOWN>","rate_note":"<note>","strengths":["<3 matches>"],"gaps":["<2-3 gaps>"],"pitch_angles":["<3 angles>"],"ir35_note":"<note>","reasoning":"<2 sentences>"}\n\nJob:\nTitle: ${job.title}\nCompany: ${job.company}\nSource: ${job.source}\nLocation: ${job.location}\nURL: ${job.url}\nDescription: ${(job.description||'').slice(0,4000)}`;
        }
        writeFileSync(promptFile, prompt);

        const result = spawnSync('claude', [
          '--print', '--output-format', 'text', '--dangerously-skip-permissions'
        ], {
          cwd: ROOT, timeout: 120000, maxBuffer: 4*1024*1024, encoding:'utf-8',
          input: readFileSync(promptFile, 'utf-8'),
        });
        if (result.error) { entry.status = 'error'; entry.log += result.error.message; return; }
        if (result.status !== 0) { entry.status = 'error'; entry.log += `Claude exited ${result.status}: ${String(result.stderr||'').slice(0,200)}`; return; }
        const jsonMatch = (result.stdout||'').match(/\{[\s\S]*"score"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const file = pipeline === 'contract' ? CONTRACT_JOBS_FILE : JOBS_FILE;
          const allJobs = JSON.parse(readFileSync(file, 'utf-8'));
          const idx = allJobs.findIndex(j => j.id === jobId);
          if (idx !== -1) {
            allJobs[idx].score = parsed.score;
            allJobs[idx].verdict = parsed.verdict;
            allJobs[idx].scoring = parsed;
            allJobs[idx].status = 'scored';
            allJobs[idx].scoredAt = new Date().toISOString();
            writeFileSync(file, JSON.stringify(allJobs, null, 2));
          }
          entry.result = parsed;
        }
        entry.status = 'done';
      } catch (e) {
        entry.status = 'error'; entry.log = e.message;
      }
      entry.ended = Date.now();
    })();

    return json(res, { id: entry.id, status:'started', message:'Scoring job...' });
  }

  if (p === '/api/action/tailor') {
    const jobId = url.searchParams.get('id');
    if (!jobId) return json(res, {error:'id required'}, 400);
    const pipeline = url.searchParams.get('pipeline') || 'perm';
    const script = pipeline === 'contract' ? 'contract_tailor.js' : 'tailor.js';
    const entry = runScript(script, [jobId], 'tailor', pipeline);
    return json(res, { id: entry.id, status:'started', message:'Generating materials...' });
  }

  if (p === '/api/action/apply') {
    const jobId = url.searchParams.get('id');
    const to = url.searchParams.get('to') || '';
    if (!jobId) return json(res, {error:'id required'}, 400);
    const args = ['send', jobId];
    if (to) { args.push('--to', to); } else { args.push('--dry-run'); }
    const entry = runScript('email.js', args, 'apply', 'perm');
    return json(res, { id: entry.id, status:'started', message: to ? 'Sending application...' : 'Preview mode (no --to email)' });
  }

  // ── Daily Actions API ──────────────────────────────────
  if (p === '/api/actions') {
    try {
      const result = execSync('node src/actions.js --no-inbox --json', {
        cwd: ROOT, timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf-8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });
      const parsed = JSON.parse(result);
      // Write timestamp for morning prompt check
      try { writeFileSync(LAST_ACTIONS_FILE, JSON.stringify({ lastRun: new Date().toISOString(), lastResult: { summary: parsed.summary, totalActions: parsed.totalActions } })); } catch {}
      return json(res, parsed);
    } catch (e) {
      return json(res, {
        error: 'Actions unavailable',
        date: new Date().toISOString(),
        summary: 'Could not generate action list.',
        actions: [],
        health: {}
      }, 200);
    }
  }

  // ── Inbox results API (read last scan) ─────────────────
  if (p === '/api/inbox-results') {
    // Try memory first, then disk
    if (!lastInboxResults) lastInboxResults = loadInboxResultsFromDisk();
    if (lastInboxResults) {
      return json(res, lastInboxResults);
    }
    return json(res, { scannedAt: null, days: 0, totalFound: 0, emails: [], message: 'No inbox scan has been run yet. Click "Check Inbox" to scan.' });
  }

  // ── Last actions timestamp (for morning prompt) ─────────
  if (p === '/api/actions/last-run') {
    try {
      if (existsSync(LAST_ACTIONS_FILE)) {
        const data = JSON.parse(readFileSync(LAST_ACTIONS_FILE, 'utf-8'));
        return json(res, data);
      }
    } catch {}
    return json(res, { lastRun: null });
  }

  if (p === '/api/action/auto-apply') {
    const jobId = url.searchParams.get('id');
    if (!jobId) return json(res, {error:'id required'}, 400);
    if (jobId.startsWith('li_')) return json(res, {error:'LinkedIn jobs use /job-apply:job-apply in Claude Code chat'}, 400);
    const entry = runScript('auto_apply.js', [jobId], 'auto_apply', 'perm');
    return json(res, { id: entry.id, status:'started', message:'Opening browser for auto-apply...' });
  }

  if (p === '/api/action/inbox') {
    const days = parseInt(url.searchParams.get('days') || '7');
    const entry = { id: runId(), type:'inbox', pipeline:'perm', started: Date.now(), status:'running', log:'' };
    running.set(entry.id, entry);

    const child = spawn('python', [resolve(__dirname, 'inbox.py'), '--json', String(days)], {
      cwd: ROOT, stdio: ['ignore','pipe','pipe'], timeout: 60000,
      env: { ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1' }
    });
    entry.child = child;
    child.stdout.on('data', d => { entry.log += d.toString(); });
    child.stderr.on('data', d => { entry.log += d.toString(); });
    child.on('close', code => {
      entry.status = code === 0 ? 'done' : 'error';
      entry.ended = Date.now();
      // Reload inbox results from disk after scan completes
      if (code === 0) {
        lastInboxResults = loadInboxResultsFromDisk();
      }
    });
    child.on('error', e => { entry.status='error'; entry.log+=e.message; entry.ended=Date.now(); });

    return json(res, { id: entry.id, status:'started', message:'Scanning inbox...' });
  }

  if (p === '/api/action/workflow') {
    // Full pipeline: find → score → tailor top-matches → apply (dry-run)
    const pipeline = url.searchParams.get('pipeline') || 'perm';

    // Kick off find first
    const script = pipeline === 'contract' ? 'contract_find.js' : 'find.js';
    const entry1 = runScript(script, [], 'workflow:find', pipeline);

    // After find completes, trigger score for top 10. We do this with a quick polling approach.
    // For now, queue it: return the workflow ID and the client will chain.
    const wid = runId();
    const wf = { id: wid, type:'workflow', pipeline, started: Date.now(), status:'running', log:'Starting workflow...\n', steps: [entry1.id] };
    running.set(wid, wf);

    // Check every 5s if find is done, then start score
    const checkAndChain = setInterval(() => {
      if (entry1.status === 'error') { wf.status = 'error'; wf.log += 'Find failed.\n'; clearInterval(checkAndChain); return; }
      if (entry1.status === 'done') {
        wf.log += 'Find complete. Starting score...\n';
        const sScript = pipeline === 'contract' ? 'contract_score.js' : 'score.js';
        const entry2 = runScript(sScript, ['10'], 'workflow:score', pipeline);
        wf.steps.push(entry2.id);

        // After score, tailor top 3
        const checkScore = setInterval(() => {
          if (entry2.status === 'error' || entry2.status === 'done') {
            wf.log += `Score ${entry2.status}. Tailoring top 3 strong matches...\n`;
            const jobs = loadJobs(pipeline).filter(j => j.score && j.score >= 80).slice(0, 3);
            if (jobs.length > 0) {
              const tScript = pipeline === 'contract' ? 'contract_tailor.js' : 'tailor.js';
              for (const j of jobs) {
                const e = runScript(tScript, [j.id], 'workflow:tailor', pipeline);
                wf.steps.push(e.id);
              }
            }
            wf.status = (entry2.status === 'error' || !jobs.length) ? 'done' : 'done';
            wf.log += `Workflow complete. ${jobs.length} strong matches tailored.\n`;
            wf.ended = Date.now();
            clearInterval(checkScore);
          }
        }, 5000);
        setTimeout(() => clearInterval(checkScore), 600000); // safety: 10min max

        clearInterval(checkAndChain);
      }
    }, 5000);
    setTimeout(() => { clearInterval(checkAndChain); wf.status = 'timeout'; }, 600000);

    return json(res, { id: wid, status:'started', message:'Workflow: find → score → tailor (5-15 min)' });
  }

  // ── Morning Routine (end-to-end one-click) ────────────────
  if (p === '/api/action/morning') {
    const totalSteps = 5;
    const entry = { id: runId(), type:'morning', pipeline:'perm', started: Date.now(), status:'running', step:1, totalSteps, stepLabel:'Finding jobs (ATS)...', log:'Step 1/5: Finding jobs (ATS permanent)...\n' };
    running.set(entry.id, entry);

    // Step 1: Find permanent jobs (ATS)
    const step1 = spawn('node', [resolve(__dirname, 'find.js')], {
      cwd: ROOT, stdio: ['ignore','pipe','pipe'], timeout: 300000,
      env: { ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1' }
    });
    entry.child = step1;
    step1.stdout.on('data', d => { entry.log += d.toString(); if (entry.log.length > 10000) entry.log = entry.log.slice(-8000); });
    step1.stderr.on('data', d => { entry.log += d.toString(); });
    step1.on('close', code => {
      entry.step = 2; entry.stepLabel = 'Finding jobs (LinkedIn)...';
      entry.log += 'Step 1 complete. Step 2/5: Finding LinkedIn jobs...\n';

      // Step 2: Find LinkedIn jobs
      const step2 = spawn('node', [resolve(__dirname, 'linkedin_find.js')], {
        cwd: ROOT, stdio: ['ignore','pipe','pipe'], timeout: 300000,
        env: { ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1' }
      });
      entry.child = step2;
      step2.stdout.on('data', d => { entry.log += d.toString(); if (entry.log.length > 10000) entry.log = entry.log.slice(-8000); });
      step2.stderr.on('data', d => { entry.log += d.toString(); });
      step2.on('close', code => {
        if (code !== 0) { entry.log += 'Step 2 warning — LinkedIn had issues. Continuing...\n'; }
        entry.stepLabel = 'Finding jobs (Himalayas)...';
        entry.log += 'Step 2 complete. Bonus: Finding Himalayas jobs (public API)...\n';

        // Helper: kick off scoring + inbox + actions (used by both paths below)
        const startRemainingSteps = () => {
          entry.step = 3; entry.stepLabel = 'Scoring jobs...';
          entry.log += 'Bonus complete. Step 3/5: Scoring 20 jobs...\n';

          // Step 3: Score 20 new jobs
          const step3 = spawn('node', [resolve(__dirname, 'score.js'), '20'], {
            cwd: ROOT, stdio: ['ignore','pipe','pipe'], timeout: 600000,
            env: { ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1' }
          });
          entry.child = step3;
          step3.stdout.on('data', d => { entry.log += d.toString(); if (entry.log.length > 10000) entry.log = entry.log.slice(-8000); });
          step3.stderr.on('data', d => { entry.log += d.toString(); });
          step3.on('close', code => {
            if (code !== 0) { entry.log += 'Step 3 warning — scoring had issues. Continuing...\n'; }
            entry.step = 4; entry.stepLabel = 'Scanning inbox...';
            entry.log += 'Step 3 complete. Step 4/5: Scanning inbox (7 days)...\n';

            // Step 4: Scan inbox for recruiter replies
            const step4 = spawn('python', [resolve(__dirname, 'inbox.py'), '--json', '7'], {
              cwd: ROOT, stdio: ['ignore','pipe','pipe'], timeout: 120000,
              env: { ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1' }
            });
            entry.child = step4;
            step4.stdout.on('data', d => { entry.log += d.toString(); });
            step4.stderr.on('data', d => { entry.log += d.toString(); });
            step4.on('close', code => {
              if (code !== 0) { entry.log += 'Step 4 warning — inbox may not be configured. Continuing...\n'; }
              else { lastInboxResults = loadInboxResultsFromDisk(); }
              entry.step = 5; entry.stepLabel = 'Generating actions...';
              entry.log += 'Step 4 complete. Step 5/5: Generating daily action list...\n';

              // Step 5: Generate daily actions (synchronous)
              try {
                const result = execSync('node src/actions.js --no-inbox --json', {
                  cwd: ROOT, timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf-8',
                  env: { ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1' }
                });
                const parsed = JSON.parse(result);
                entry.result = parsed;
                writeFileSync(LAST_ACTIONS_FILE, JSON.stringify({ lastRun: new Date().toISOString(), lastResult: { summary: parsed.summary, totalActions: parsed.totalActions } }));
                entry.status = 'done';
                entry.log += 'Step 5 complete. Morning routine finished!\n';
              } catch (e) {
                entry.status = 'error';
                entry.log += 'Step 5 failed: ' + e.message + '\n';
              }
              entry.ended = Date.now();
            });
            step4.on('error', e => {
              entry.step = 5; entry.stepLabel = 'Generating actions...';
              entry.log += 'Step 4 error: ' + e.message + '. Continuing...\n';
              try {
                const result = execSync('node src/actions.js --no-inbox --json', {
                  cwd: ROOT, timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf-8',
                  env: { ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1' }
                });
                entry.status = 'done'; entry.log += 'Step 5 complete.\n';
              } catch (e2) { entry.status = 'error'; entry.log += 'Step 5 failed.\n'; }
              entry.ended = Date.now();
            });
          });
          step3.on('error', e => {
            entry.status = 'error'; entry.log += 'Step 3 error: ' + e.message + '\n'; entry.ended = Date.now();
          });
        };

        // Step 2b: Himalayas (bonus source, free public API — runs fast)
        const step2b = spawn('node', [resolve(__dirname, 'himalayas_find.js')], {
          cwd: ROOT, stdio: ['ignore','pipe','pipe'], timeout: 300000,
          env: { ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1' }
        });
        entry.child = step2b;
        step2b.stdout.on('data', d => { entry.log += d.toString(); if (entry.log.length > 10000) entry.log = entry.log.slice(-8000); });
        step2b.stderr.on('data', d => { entry.log += d.toString(); });
        step2b.on('close', code => {
          if (code !== 0) { entry.log += 'Himalayas warning — had issues. Continuing...\n'; }
          startRemainingSteps();
        });
        step2b.on('error', e => {
          entry.log += 'Himalayas could not start: ' + e.message + '. Skipping bonus source...\n';
          startRemainingSteps();
        });
      });
    });
    step1.on('error', e => {
      entry.status = 'error'; entry.log += 'Step 1 error: ' + e.message + '\n'; entry.ended = Date.now();
    });

    return json(res, { id: entry.id, status:'started', message:`Morning routine: ATS → LinkedIn → Himalayas → score 20 → inbox → actions` });
  }

  // ── Quick Score (no Claude, instant keyword-based) ─────
  if (p === '/api/action/quick-score') {
    const pipeline = url.searchParams.get('pipeline') || 'perm';
    const count = Math.min(parseInt(url.searchParams.get('count') || '0') || 100, 500);
    const entry = runScript('quick_score.js', [String(count), pipeline], 'quick_score', pipeline);
    return json(res, { id: entry.id, status: 'started', message: `Quick-scoring ${pipeline} jobs...` });
  }
  // ── Manual status update ─────────────────────────────────
  if (p === '/api/action/status') {
    const jobId = url.searchParams.get('id');
    const newStatus = url.searchParams.get('status');
    if (!jobId || !newStatus) return json(res, {error:'id and status required'}, 400);
    const valid = ['new','scored','applied','screening','interviewing','offer','rejected','bid','client_call','won','lost','archived'];
    if (!valid.includes(newStatus)) return json(res, {error:'invalid status'}, 400);
    // Try both files
    for (const f of [JOBS_FILE, CONTRACT_JOBS_FILE]) {
      if (!existsSync(f)) continue;
      const jobs = JSON.parse(readFileSync(f, 'utf-8'));
      const idx = jobs.findIndex(j => j.id === jobId);
      if (idx !== -1) {
        jobs[idx].status = newStatus;
        jobs[idx].statusUpdatedAt = new Date().toISOString();
        if (newStatus === 'applied') jobs[idx].appliedAt = new Date().toISOString();
        if (newStatus === 'interviewing') jobs[idx].interviewingAt = new Date().toISOString();
        if (newStatus === 'offer') jobs[idx].offerAt = new Date().toISOString();
        if (newStatus === 'rejected') jobs[idx].rejectedAt = new Date().toISOString();
        writeFileSync(f, JSON.stringify(jobs, null, 2));
        return json(res, {id: jobId, status: newStatus, updated: true});
      }
    }
    return json(res, {error:'job not found'}, 404);
  }

  // ── Cancel running job ──────────────────────────────────
  if (p === '/api/action/cancel') {
    const rid = url.searchParams.get('id');
    if (!rid) return json(res, {error:'id required'}, 400);
    const entry = running.get(rid);
    if (!entry) return json(res, {error:'not found'}, 404);
    if (entry.child) {
      entry.child.kill('SIGTERM');
      entry.status = 'cancelled';
      entry.ended = Date.now();
      entry.log += '\n[CANCELLED BY USER]';
    }
    return json(res, {id: rid, status:'cancelled'});
  }

  // ── Static files ──────────────────────────────────────────
  if (p === '/' || p === '') return serveFile(res, resolve(__dirname, 'dashboard.html'));
  if (p.startsWith('/src/')) return serveFile(res, resolve(ROOT, p.slice(1)));

  json(res, {error:'Not found'}, 404);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && !server._retried) {
    server._retried = true;
    console.log('\n  Port 3456 in use — killing old process...');
    try {
      if (process.platform === 'win32') {
        execSync('powershell -NoProfile -Command "$p=Get-NetTCPConnection -LocalPort 3456 -ErrorAction SilentlyContinue|Select -ExpandProperty OwningProcess -Unique|Where {$_ -gt 4};foreach($i in $p){Stop-Process -Id $i -Force -ErrorAction SilentlyContinue}"', {timeout:8000, stdio:'ignore'});
      } else {
        execSync("lsof -ti:3456 | xargs kill -9 2>/dev/null; sleep 1", {timeout:5000, stdio:'ignore'});
      }
    } catch {}
    console.log('  Retrying in 2s...');
    setTimeout(() => { server.listen(PORT); }, 2000);
    return;
  }
  if (e.code === 'EADDRINUSE') {
    console.log('\n  Port 3456 still busy. Run: netstat -ano | findstr 3456');
    console.log('  Kill the process manually and restart.');
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, () => {
  console.log(`\n  Dashboard: http://localhost:${PORT}\n`);
});
