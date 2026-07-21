// dashboard.js — Web dashboard + action API
// Serve HTML + wire all pipeline actions through /api/action/* endpoints
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');
const CONTRACT_JOBS_FILE = resolve(DATA_DIR, 'contract_jobs.json');
const PORT = 3456;

// ─── Running jobs tracker (for polling status) ──────────────
const running = new Map(); // id → { type, status, started, log }

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
    let script, type;
    if (source === 'linkedin') {
      script = 'linkedin_find.js'; type = 'scrape_linkedin';
    } else {
      script = pipeline === 'contract' ? 'contract_find.js' : 'find.js';
      type = 'scrape_ats';
    }
    const entry = runScript(script, [], type, pipeline);
    return json(res, { id: entry.id, status: 'started', message: `Scraping ${source} ${pipeline} jobs...` });
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

        const result = execSync(`claude --print --output-format text --dangerously-skip-permissions -p "$(cat '${promptFile.replace(/'/g, "'\\''")}')"`, {
          cwd: ROOT, timeout: 90000, maxBuffer: 1024*1024, encoding:'utf-8'
        });
        const jsonMatch = result.match(/\{[\s\S]*"score"[\s\S]*\}/);
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
      const result = execSync('node src/actions.js', { cwd: ROOT, timeout: 30000, maxBuffer: 1024*1024, encoding:'utf-8', env: { ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1' } });
      res.writeHead(200, { 'Content-Type':'text/plain' });
      res.end(result);
    } catch(e) {
      res.writeHead(200, { 'Content-Type':'text/plain' });
      res.end(e.stdout || e.message || 'Actions unavailable');
    }
    return;
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

    const child = spawn('python', [resolve(__dirname, 'inbox.py'), String(days)], {
      cwd: ROOT, stdio: ['ignore','pipe','pipe'], timeout: 60000,
      env: { ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1' }
    });
    child.stdout.on('data', d => { entry.log += d.toString(); });
    child.stderr.on('data', d => { entry.log += d.toString(); });
    child.on('close', code => { entry.status = code===0?'done':'error'; entry.ended = Date.now(); });
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

  // ── Static files ──────────────────────────────────────────
  if (p === '/' || p === '') return serveFile(res, resolve(__dirname, 'dashboard.html'));
  if (p.startsWith('/src/')) return serveFile(res, resolve(ROOT, p.slice(1)));

  json(res, {error:'Not found'}, 404);
});

server.listen(PORT, () => {
  console.log(`\n  Dashboard: http://localhost:${PORT}\n`);
});
