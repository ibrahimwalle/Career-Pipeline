// auto_apply.js — Fill ATS application forms via Playwright
// Usage: node src/auto_apply.js <jobId>
// Detects Greenhouse, Lever, Ashby; fills profile fields; leaves browser open for manual review.
// Profile data loaded from profile/auto_apply_profile.json (gitignored).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const OUTPUT_DIR = resolve(ROOT, 'output');
const PERM_FILE = resolve(DATA_DIR, 'jobs.json');
const CONTRACT_FILE = resolve(DATA_DIR, 'contract_jobs.json');
const PROFILE_FILE = resolve(ROOT, 'profile', 'auto_apply_profile.json');

// ─── Profile data (loaded from gitignored file) ────────────────────

function loadProfile() {
  const defaults = {
    firstName: '', lastName: '', fullName: '', email: '', phone: '',
    location: '', linkedin: '', github: '', workEligibility: '',
    currentCompany: '', title: '', yearsExperience: '', education: '',
    cvPath: '',
  };
  if (!existsSync(PROFILE_FILE)) {
    console.error('X No profile/auto_apply_profile.json found.');
    console.error('  Create it from profile/auto_apply_profile.example.json');
    console.error('  This file is gitignored — your personal data stays local.');
    process.exit(1);
  }
  return { ...defaults, ...JSON.parse(readFileSync(PROFILE_FILE, 'utf-8')) };
}

const PROFILE = loadProfile();
const CV_PATH = PROFILE.cvPath;

// ─── ATS detection ─────────────────────────────────────────────────

function detectAtsType(url) {
  const u = url.toLowerCase();
  if (u.includes('boards.greenhouse.io') || u.includes('job-boards.greenhouse.io') || u.includes('greenhouse.io')) {
    return 'greenhouse';
  }
  if (u.includes('jobs.lever.co')) {
    return 'lever';
  }
  if (u.includes('jobs.ashbyhq.com')) {
    return 'ashby';
  }
  return 'generic';
}

// ─── Job loading ───────────────────────────────────────────────────

function isPermanentId(jobId) {
  return /^(gh_|lv_|ab_)/.test(jobId);
}

function loadJob(jobId) {
  const isPerm = isPermanentId(jobId);
  const filePath = isPerm ? PERM_FILE : CONTRACT_FILE;
  const label = isPerm ? 'jobs.json' : 'contract_jobs.json';

  if (!existsSync(filePath)) {
    console.error(`No job data found at data/${label}. Run "node src/find.js" first.`);
    process.exit(1);
  }

  const jobs = JSON.parse(readFileSync(filePath, 'utf-8'));
  const job = jobs.find(j => j.id === jobId);
  if (!job) {
    console.error(`Job "${jobId}" not found in data/${label}.`);
    process.exit(1);
  }

  return { job, isPerm, filePath };
}

// ─── Cover letter loading ──────────────────────────────────────────

function loadCoverLetter(jobId) {
  const coverPath = resolve(OUTPUT_DIR, jobId, 'cover_letter.md');
  if (existsSync(coverPath)) {
    return readFileSync(coverPath, 'utf-8');
  }
  return null;
}

// ─── Output helpers ────────────────────────────────────────────────

function ensureOutputDir(jobId) {
  const dir = resolve(OUTPUT_DIR, jobId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function saveLog(jobId, entries) {
  const outDir = ensureOutputDir(jobId);
  const logPath = resolve(outDir, 'application_log.json');
  const log = {
    jobId,
    timestamp: new Date().toISOString(),
    profile: { firstName: PROFILE.firstName, lastName: PROFILE.lastName, email: PROFILE.email },
    cvUploaded: entries.cvUploaded || false,
    coverLetterPasted: entries.coverLetterPasted || false,
    fieldsFilled: entries.fieldsFilled || [],
    fieldsSkipped: entries.fieldsSkipped || [],
    fieldsHighlighted: entries.fieldsHighlighted || [],
    errors: entries.errors || [],
  };
  writeFileSync(logPath, JSON.stringify(log, null, 2));
  console.log(`  Log saved to: output/${jobId}/application_log.json`);
  return log;
}

// ─── URL transformation (career site → direct ATS URL) ─────────────

function resolveApplicationUrl(job) {
  const url = job.url || '';
  const atsType = detectAtsType(url);

  // If already a direct ATS URL, return as-is
  if (atsType !== 'generic') return url;

  // For Greenhouse: try to construct the direct boards.greenhouse.io URL
  if (job.source === 'greenhouse' && job.company) {
    // Extract the numeric job ID from our composite ID (e.g., gh_stripe_7908925 → 7908925)
    const numericMatch = job.id.match(/(\d+)$/);
    if (numericMatch) {
      const ghJobId = numericMatch[1];
      return `https://boards.greenhouse.io/${job.company}/jobs/${ghJobId}`;
    }
  }

  // For Lever: the URL from the API is usually already direct
  if (job.source === 'lever') return url;

  // For Ashby: try to construct direct URL
  if (job.source === 'ashby' && job.company) {
    const numericMatch = job.id.match(/(\d+)$/);
    if (numericMatch) {
      const ashbyId = numericMatch[1];
      return `https://jobs.ashbyhq.com/${job.company}/${ashbyId}`;
    }
  }

  return url;
}

// ─── Field-filling helpers ─────────────────────────────────────────

async function fillInput(page, selector, value, label) {
  try {
    const el = page.locator(selector).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      await el.click();
      await el.fill('');
      await el.fill(value);
      console.log(`  ✓ ${label}: "${value}"`);
      return { filled: true, label, value };
    }
  } catch (e) {
    // Field not found or not interactable — skip
  }
  return { filled: false, label, reason: 'not found or not visible' };
}

async function fillByPlaceholder(page, placeholder, value, label) {
  return fillInput(page, `input[placeholder*="${placeholder}" i]`, value, label);
}

async function fillByName(page, name, value, label) {
  return fillInput(page, `input[name="${name}"], textarea[name="${name}"]`, value, label);
}

async function fillById(page, id, value, label) {
  return fillInput(page, `#${id}`, value, label);
}

async function fillByLabel(page, labelText, value, fieldLabel) {
  try {
    // Try to find an input near a label containing this text
    const el = page.locator(`label:has-text("${labelText}")`).first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      // Find the associated input
      const forAttr = await el.getAttribute('for');
      if (forAttr) {
        return fillById(page, forAttr, value, fieldLabel);
      }
      // Try sibling/child input
      const input = el.locator('..').locator('input, textarea, select').first();
      if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
        await input.click();
        await input.fill('');
        await input.fill(value);
        console.log(`  ✓ ${fieldLabel}: "${value}"`);
        return { filled: true, label: fieldLabel, value };
      }
    }
  } catch (e) {
    // skip
  }
  return { filled: false, label: fieldLabel, reason: 'label not found' };
}

async function uploadFile(page, filePath, label) {
  try {
    // Look for any file input (accepting pdf/doc/docx)
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await fileInput.setInputFiles(filePath);
      console.log(`  ✓ ${label}: uploaded`);
      return { filled: true, label, value: filePath };
    }
  } catch (e) {
    // skip
  }
  return { filled: false, label, reason: 'file input not found or not interactable' };
}

async function fillTextarea(page, selectors, value, label) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click();
        await el.fill('');
        await el.fill(value);
        console.log(`  ✓ ${label}: pasted (${value.length} chars)`);
        return { filled: true, label, value };
      }
    } catch (e) {
      // try next selector
    }
  }
  return { filled: false, label, reason: 'textarea not found' };
}

// ─── ATS-specific filling strategies ───────────────────────────────

async function fillGreenhouse(page, job) {
  const results = { fieldsFilled: [], fieldsSkipped: [], fieldsHighlighted: [], errors: [], cvUploaded: false, coverLetterPasted: false };

  console.log('\n  ── Greenhouse form detected ──\n');

  // Wait for the form to appear — click Apply if needed
  await waitForGreenhouseForm(page);

  // Standard fields
  const r1 = await fillById(page, 'first_name', PROFILE.firstName, 'First Name');
  if (r1.filled) results.fieldsFilled.push(r1); else results.fieldsSkipped.push(r1);

  const r2 = await fillById(page, 'last_name', PROFILE.lastName, 'Last Name');
  if (r2.filled) results.fieldsFilled.push(r2); else results.fieldsSkipped.push(r2);

  const r3 = await fillById(page, 'email', PROFILE.email, 'Email');
  if (r3.filled) results.fieldsFilled.push(r3); else results.fieldsSkipped.push(r3);

  const r4 = await fillById(page, 'phone', PROFILE.phone, 'Phone');
  if (r4.filled) results.fieldsFilled.push(r4); else {
    // Try alternative phone field names
    const alt = await fillByPlaceholder(page, 'phone', PROFILE.phone, 'Phone (placeholder)');
    if (alt.filled) results.fieldsFilled.push(alt); else results.fieldsSkipped.push(r4);
  }

  // Location fields
  const r5 = await fillById(page, 'location', PROFILE.location, 'Location');
  if (r5.filled) results.fieldsFilled.push(r5); else results.fieldsSkipped.push(r5);

  const r5b = await fillByLabel(page, 'city', PROFILE.location, 'City');
  if (r5b.filled) results.fieldsFilled.push(r5b); else results.fieldsSkipped.push(r5b);

  // CV / Resume upload
  if (existsSync(CV_PATH)) {
    const cv = await uploadFile(page, CV_PATH, 'CV / Resume');
    if (cv.filled) { results.fieldsFilled.push(cv); results.cvUploaded = true; }
    else results.fieldsSkipped.push(cv);
  } else {
    results.errors.push(`CV file not found: ${CV_PATH}`);
    console.error(`  ✗ CV not found: ${CV_PATH}`);
  }

  // Cover letter
  const coverLetter = loadCoverLetter(job.id);
  if (coverLetter) {
    const cl = await fillTextarea(
      page,
      ['textarea#cover_letter', 'textarea[id*="cover_letter"]', 'textarea[name*="cover_letter"]', 'textarea[aria-label*="cover" i]'],
      coverLetter,
      'Cover Letter'
    );
    if (cl.filled) { results.fieldsFilled.push(cl); results.coverLetterPasted = true; }
    else results.fieldsSkipped.push(cl);
  } else {
    console.log('  ⓘ No cover letter found — skipping. Run "node src/tailor.js <jobId>" first.');
  }

  // LinkedIn
  if (PROFILE.linkedin) {
    const li = await fillByPlaceholder(page, 'linkedin', PROFILE.linkedin, 'LinkedIn');
    if (li.filled) results.fieldsFilled.push(li); else results.fieldsSkipped.push(li);
  }

  // GitHub
  if (PROFILE.github) {
    const gh = await fillByPlaceholder(page, 'github', PROFILE.github, 'GitHub');
    if (gh.filled) results.fieldsFilled.push(gh); else results.fieldsSkipped.push(gh);
  }

  // Handle Greenhouse custom questions
  await handleGreenhouseCustomQuestions(page, results);

  return results;
}

async function waitForGreenhouseForm(page) {
  // Try clicking "Apply Now" / "Apply" button first
  try {
    const applyBtn = page.locator('a:has-text("Apply"), button:has-text("Apply"), #submit_app, [data-qa="apply-button"]').first();
    if (await applyBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await applyBtn.click();
      console.log('  Clicked "Apply" button...');
      await page.waitForTimeout(1500);
    }
  } catch (e) {
    // Button not found — form may already be visible
  }

  // Wait for form fields to appear
  try {
    await page.waitForSelector('#first_name, #last_name, #email, input[name*="first"], input[name*="last"]', { timeout: 5000 });
  } catch (e) {
    console.log('  ⚠ Standard Greenhouse fields not immediately visible; proceeding anyway...');
  }

  // If we see a redirect or the page is still the listing, try navigating to #app
  const currentUrl = page.url();
  if (!currentUrl.includes('#') && currentUrl.includes('boards.greenhouse.io')) {
    try {
      await page.goto(currentUrl.replace(/\?.*$/, '') + '#app', { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(2000);
      console.log('  Navigated to application form (#app)...');
    } catch (e) {
      // Keep going
    }
  }
}

async function handleGreenhouseCustomQuestions(page, results) {
  console.log('\n  ── Custom questions ──');
  try {
    // Find all select/input/textarea elements in the form that are custom questions
    // Greenhouse wraps each question in a div with specific structure

    // Handle dropdowns first
    const selects = page.locator('select:not([name*="phone"]):not([id*="phone"])');
    const selectCount = await selects.count();
    for (let i = 0; i < selectCount; i++) {
      const sel = selects.nth(i);
      if (!(await sel.isVisible().catch(() => false))) continue;

      // Get the label/legend text near this select
      const selectId = await sel.getAttribute('id');
      let questionText = selectId || '';

      // Try to find label
      try {
        const label = page.locator(`label[for="${selectId}"]`).first();
        if (await label.isVisible({ timeout: 500 }).catch(() => false)) {
          questionText = (await label.innerText()).trim();
        }
      } catch (e) {
        // no label
      }

      // Try parent text
      if (!questionText || questionText === selectId) {
        try {
          const parentText = await sel.locator('..').innerText();
          questionText = parentText.split('\n')[0].trim();
        } catch (e) {
          // keep selectId
        }
      }

      const qLower = questionText.toLowerCase();

      // Try to pick a sensible default based on question text
      const options = await sel.locator('option').all();
      let picked = false;

      // Common patterns
      const patterns = [
        { match: /eligib|authori[sz]|right to work|work auth|sponsor|visa/, values: ['yes', 'i am eligible', 'fully eligible', 'eligible to work', 'authorized', 'uk citizen'] },
        { match: /gender/, values: ['male', 'man', 'prefer not'] },
        { match: /ethnic|race|origin/, values: ['prefer not', 'white', 'middle eastern', 'asian'] },
        { match: /veteran/, values: ['not a veteran', 'i am not', 'no'] },
        { match: /disability/, values: ['no', 'i do not', 'prefer not'] },
        { match: /country|location|region/, values: ['united kingdom', 'uk', 'london'] },
        { match: /how did you hear|source|referred/, values: ['linkedin', 'company website', 'job board', 'other'] },
        { match: /degree|education/, values: ['bachelor', 'bsc', 'yes'] },
      ];

      for (const pattern of patterns) {
        if (pattern.match.test(qLower)) {
          for (const val of pattern.values) {
            try {
              await sel.selectOption({ label: new RegExp(val, 'i') });
              picked = true;
              console.log(`  ✓ Dropdown "${questionText.slice(0, 60)}" → "${val}"`);
              results.fieldsFilled.push({ label: questionText.slice(0, 80), value: val, type: 'dropdown' });
              break;
            } catch (e) {
              // try next value
            }
          }
          if (picked) break;
        }
      }

      if (!picked) {
        // Pick the second option (first is usually placeholder like "--Select--")
        try {
          const optCount = await sel.locator('option').count();
          if (optCount > 1) {
            // Try to find a sensible default (not the placeholder)
            for (let oi = 1; oi < Math.min(optCount, 5); oi++) {
              const optVal = await sel.locator('option').nth(oi).getAttribute('value');
              if (optVal && optVal.trim() !== '') {
                await sel.selectOption({ index: oi });
                const optText = await sel.locator('option').nth(oi).innerText();
                console.log(`  ✓ Dropdown "${questionText.slice(0, 60)}" → first option: "${optText}"`);
                results.fieldsFilled.push({ label: questionText.slice(0, 80), value: optText, type: 'dropdown' });
                picked = true;
                break;
              }
            }
          }
        } catch (e) {
          // skip
        }
      }

      if (!picked) {
        results.fieldsSkipped.push({ label: questionText.slice(0, 80), reason: 'dropdown — no sensible default found', type: 'dropdown' });
        // Highlight with red border
        await highlightElement(page, sel);
        results.fieldsHighlighted.push({ label: questionText.slice(0, 80), type: 'dropdown' });
      }
    }

    // Highlight remaining text inputs that weren't filled (custom text fields)
    try {
      // Find inputs in the form that are empty and not our standard fields
      const textInputs = page.locator('input[type="text"]:not([value]):not([id="first_name"]):not([id="last_name"]):not([id="email"]):not([id="phone"]):not([id="location"]):not([placeholder*="linkedin" i]):not([placeholder*="github" i]), textarea:not([id*="cover_letter"])');
      const textCount = await textInputs.count();
      for (let i = 0; i < textCount; i++) {
        const inp = textInputs.nth(i);
        if (!(await inp.isVisible().catch(() => false))) continue;
        const val = await inp.inputValue().catch(() => '');
        if (val.trim() !== '') continue; // already has a value

        // Get associated question text
        const inpId = await inp.getAttribute('id').catch(() => '');
        let qText = inpId || '';
        try {
          qText = await page.locator(`label[for="${inpId}"]`).first().innerText().catch(() => inpId || `input ${i}`);
        } catch (e) {
          // keep id
        }

        await highlightElement(page, inp);
        results.fieldsHighlighted.push({ label: qText.slice(0, 80), type: 'text' });
      }
    } catch (e) {
      // skip
    }

  } catch (e) {
    results.errors.push(`Custom questions error: ${e.message}`);
    console.error(`  ⚠ Custom questions error: ${e.message}`);
  }

  const highlighted = results.fieldsHighlighted.length;
  if (highlighted > 0) {
    console.log(`  ⚠ ${highlighted} field(s) highlighted (red border) — please review and fill manually.`);
  }
}

async function fillLever(page, job) {
  const results = { fieldsFilled: [], fieldsSkipped: [], fieldsHighlighted: [], errors: [], cvUploaded: false, coverLetterPasted: false };

  console.log('\n  ── Lever form detected ──\n');

  // Wait for form
  try {
    await page.waitForSelector('input[name="name"], input[name="email"], form', { timeout: 5000 });
  } catch (e) {
    console.log('  ⚠ Lever form fields not immediately visible; proceeding anyway...');
  }

  // Click apply if needed
  try {
    const applyBtn = page.locator('a:has-text("Apply"), button:has-text("Apply"), .posting-apply, [data-qa="apply-button"]').first();
    if (await applyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await applyBtn.click();
      await page.waitForTimeout(1500);
    }
  } catch (e) {
    // no button needed
  }

  // Name
  const r1 = await fillByName(page, 'name', PROFILE.fullName, 'Full Name');
  if (r1.filled) results.fieldsFilled.push(r1); else results.fieldsSkipped.push(r1);

  // Email
  const r2 = await fillByName(page, 'email', PROFILE.email, 'Email');
  if (r2.filled) results.fieldsFilled.push(r2); else {
    const alt = await fillByPlaceholder(page, 'email', PROFILE.email, 'Email');
    if (alt.filled) results.fieldsFilled.push(alt); else results.fieldsSkipped.push(r2);
  }

  // Phone
  const r3 = await fillByName(page, 'phone', PROFILE.phone, 'Phone');
  if (r3.filled) results.fieldsFilled.push(r3); else results.fieldsSkipped.push(r3);

  // Current company
  const r4 = await fillByName(page, 'org', PROFILE.currentCompany, 'Current Company');
  if (r4.filled) results.fieldsFilled.push(r4); else results.fieldsSkipped.push(r4);

  // LinkedIn
  if (PROFILE.linkedin) {
    const li = await fillByName(page, 'urls[LinkedIn]', PROFILE.linkedin, 'LinkedIn URL');
    if (li.filled) results.fieldsFilled.push(li); else results.fieldsSkipped.push(li);
  }

  // GitHub
  if (PROFILE.github) {
    const gh = await fillByName(page, 'urls[GitHub]', PROFILE.github, 'GitHub URL');
    if (gh.filled) results.fieldsFilled.push(gh); else {
      const gh2 = await fillByName(page, 'urls[Github]', PROFILE.github, 'GitHub URL (alt)');
      if (gh2.filled) results.fieldsFilled.push(gh2); else results.fieldsSkipped.push(gh);
    }
  }

  // CV upload
  if (existsSync(CV_PATH)) {
    const cv = await uploadFile(page, CV_PATH, 'CV / Resume');
    if (cv.filled) { results.fieldsFilled.push(cv); results.cvUploaded = true; }
    else results.fieldsSkipped.push(cv);
  } else {
    results.errors.push(`CV file not found: ${CV_PATH}`);
    console.error(`  ✗ CV not found: ${CV_PATH}`);
  }

  // Cover letter
  const coverLetter = loadCoverLetter(job.id);
  if (coverLetter) {
    const cl = await fillTextarea(
      page,
      ['textarea[name*="cover" i]', 'textarea[placeholder*="cover" i]', 'textarea[name*="comments" i]', 'textarea'],
      coverLetter,
      'Cover Letter'
    );
    if (cl.filled) { results.fieldsFilled.push(cl); results.coverLetterPasted = true; }
    else results.fieldsSkipped.push(cl);
  }

  // Work eligibility — Lever often has this as a custom question
  await handleLeverCustomQuestions(page, results);

  return results;
}

async function handleLeverCustomQuestions(page, results) {
  try {
    // Look for dropdowns with work eligibility
    const selects = page.locator('select');
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      const sel = selects.nth(i);
      if (!(await sel.isVisible().catch(() => false))) continue;
      const selId = await sel.getAttribute('id').catch(() => '') || await sel.getAttribute('name').catch(() => '') || '';
      let qText = selId;

      try {
        qText = await page.locator(`label[for="${selId}"]`).first().innerText().catch(() => selId);
      } catch (e) {
        // keep id
      }

      const qLower = qText.toLowerCase();

      // Work eligibility
      if (/eligib|authori[sz]|right to work|work auth|sponsor|visa/.test(qLower)) {
        try {
          await sel.selectOption({ label: /yes|eligible|authorized|uk citizen|full right/i });
          console.log(`  ✓ "${qText.slice(0, 60)}" → work eligibility selected`);
          results.fieldsFilled.push({ label: qText.slice(0, 80), value: 'Eligibility confirmed', type: 'dropdown' });
          continue;
        } catch (e) {
          // try different values
          try {
            await sel.selectOption({ index: 1 }); // first non-placeholder
            results.fieldsFilled.push({ label: qText.slice(0, 80), value: 'first option', type: 'dropdown' });
            continue;
          } catch (e2) { /* skip */ }
        }
      }

      // Other dropdowns — highlight
      await highlightElement(page, sel);
      results.fieldsHighlighted.push({ label: qText.slice(0, 80), type: 'dropdown' });
    }
  } catch (e) {
    results.errors.push(`Lever custom questions: ${e.message}`);
  }
}

async function fillAshby(page, job) {
  const results = { fieldsFilled: [], fieldsSkipped: [], fieldsHighlighted: [], errors: [], cvUploaded: false, coverLetterPasted: false };

  console.log('\n  ── Ashby form detected ──\n');

  // Wait for form
  try {
    await page.waitForSelector('input[name="name"], input[name="email"], input[type="file"], form', { timeout: 5000 });
  } catch (e) {
    console.log('  ⚠ Ashby form fields not immediately visible; proceeding anyway...');
  }

  // Click apply if needed
  try {
    const applyBtn = page.locator('button:has-text("Apply"), a:has-text("Apply"), [data-testid="apply-button"]').first();
    if (await applyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await applyBtn.click();
      await page.waitForTimeout(1500);
    }
  } catch (e) {
    // no button needed
  }

  // Ashby uses various field patterns — try multiple approaches

  // Name
  let r1 = await fillByName(page, 'name', PROFILE.fullName, 'Full Name');
  if (!r1.filled) r1 = await fillByLabel(page, 'name', PROFILE.fullName, 'Full Name');
  if (!r1.filled) r1 = await fillByLabel(page, 'full name', PROFILE.fullName, 'Full Name');
  if (r1.filled) results.fieldsFilled.push(r1); else {
    // Try first name / last name split
    const fn = await fillByLabel(page, 'first name', PROFILE.firstName, 'First Name');
    if (fn.filled) results.fieldsFilled.push(fn); else results.fieldsSkipped.push(fn);
    const ln = await fillByLabel(page, 'last name', PROFILE.lastName, 'Last Name');
    if (ln.filled) results.fieldsFilled.push(ln); else results.fieldsSkipped.push(ln);
  }

  // Email
  const r2 = await fillByName(page, 'email', PROFILE.email, 'Email');
  if (r2.filled) results.fieldsFilled.push(r2); else {
    const alt = await fillByPlaceholder(page, 'email', PROFILE.email, 'Email');
    if (alt.filled) results.fieldsFilled.push(alt); else results.fieldsSkipped.push(r2);
  }

  // Phone
  const r3 = await fillByName(page, 'phone', PROFILE.phone, 'Phone');
  if (r3.filled) results.fieldsFilled.push(r3); else results.fieldsSkipped.push(r3);

  // Location
  const r4 = await fillByLabel(page, 'location', PROFILE.location, 'Location');
  if (r4.filled) results.fieldsFilled.push(r4); else {
    const r4b = await fillByLabel(page, 'city', PROFILE.location, 'City');
    if (r4b.filled) results.fieldsFilled.push(r4b); else results.fieldsSkipped.push(r4);
  }

  // LinkedIn
  if (PROFILE.linkedin) {
    const li = await fillByPlaceholder(page, 'linkedin', PROFILE.linkedin, 'LinkedIn');
    if (li.filled) results.fieldsFilled.push(li); else results.fieldsSkipped.push(li);
  }

  // CV upload
  if (existsSync(CV_PATH)) {
    const cv = await uploadFile(page, CV_PATH, 'CV / Resume');
    if (cv.filled) { results.fieldsFilled.push(cv); results.cvUploaded = true; }
    else results.fieldsSkipped.push(cv);
  } else {
    results.errors.push(`CV file not found: ${CV_PATH}`);
    console.error(`  ✗ CV not found: ${CV_PATH}`);
  }

  // Cover letter
  const coverLetter = loadCoverLetter(job.id);
  if (coverLetter) {
    const cl = await fillTextarea(
      page,
      ['textarea[name*="cover" i]', 'textarea[placeholder*="cover" i]', 'textarea[name*="additional" i]', 'textarea'],
      coverLetter,
      'Cover Letter'
    );
    if (cl.filled) { results.fieldsFilled.push(cl); results.coverLetterPasted = true; }
    else results.fieldsSkipped.push(cl);
  }

  // Highlight unfilled fields
  await highlightRemainingFields(page, results, 'ashby');

  return results;
}

async function fillGeneric(page, job) {
  const results = { fieldsFilled: [], fieldsSkipped: [], fieldsHighlighted: [], errors: [], cvUploaded: false, coverLetterPasted: false };

  console.log('\n  ── Generic form detected ──\n');

  // Wait for form fields
  try {
    await page.waitForSelector('input, form', { timeout: 5000 });
  } catch (e) {
    console.log('  ⚠ No form fields detected; proceeding anyway...');
  }

  // Try common field patterns
  const strategies = [
    { fn: () => fillByName(page, 'name', PROFILE.fullName, 'Full Name'), label: 'Full Name' },
    { fn: () => fillByName(page, 'full_name', PROFILE.fullName, 'Full Name'), label: 'Full Name (full_name)' },
    { fn: () => fillByName(page, 'first_name', PROFILE.firstName, 'First Name'), label: 'First Name' },
    { fn: () => fillByName(page, 'last_name', PROFILE.lastName, 'Last Name'), label: 'Last Name' },
    { fn: () => fillByName(page, 'email', PROFILE.email, 'Email'), label: 'Email' },
    { fn: () => fillByPlaceholder(page, 'email', PROFILE.email, 'Email'), label: 'Email (placeholder)' },
    { fn: () => fillByName(page, 'phone', PROFILE.phone, 'Phone'), label: 'Phone' },
    { fn: () => fillByPlaceholder(page, 'phone', PROFILE.phone, 'Phone'), label: 'Phone (placeholder)' },
    { fn: () => fillByPlaceholder(page, 'location', PROFILE.location, 'Location'), label: 'Location' },
    { fn: () => fillByPlaceholder(page, 'city', PROFILE.location, 'City'), label: 'City' },
    { fn: () => fillByPlaceholder(page, 'linkedin', PROFILE.linkedin, 'LinkedIn'), label: 'LinkedIn' },
    { fn: () => fillByPlaceholder(page, 'github', PROFILE.github, 'GitHub'), label: 'GitHub' },
  ];

  for (const s of strategies) {
    const r = await s.fn();
    if (r.filled) results.fieldsFilled.push(r); else results.fieldsSkipped.push({ label: s.label, reason: 'not found' });
  }

  // CV upload
  if (existsSync(CV_PATH)) {
    const cv = await uploadFile(page, CV_PATH, 'CV / Resume');
    if (cv.filled) { results.fieldsFilled.push(cv); results.cvUploaded = true; }
    else results.fieldsSkipped.push(cv);
  } else {
    results.errors.push(`CV file not found: ${CV_PATH}`);
    console.error(`  ✗ CV not found: ${CV_PATH}`);
  }

  // Cover letter
  const coverLetter = loadCoverLetter(job.id);
  if (coverLetter) {
    const cl = await fillTextarea(
      page,
      ['textarea[name*="cover" i]', 'textarea[placeholder*="cover" i]', 'textarea[name*="message" i]', 'textarea'],
      coverLetter,
      'Cover Letter'
    );
    if (cl.filled) { results.fieldsFilled.push(cl); results.coverLetterPasted = true; }
    else results.fieldsSkipped.push(cl);
  }

  // Highlight remaining
  await highlightRemainingFields(page, results, 'generic');

  return results;
}

// ─── Highlighting ──────────────────────────────────────────────────

async function highlightElement(page, locator) {
  try {
    await locator.evaluate(el => {
      el.style.border = '2px solid red';
      el.style.backgroundColor = '#fff0f0';
    }).catch(() => {});
  } catch (e) {
    // element might not support evaluate
  }
}

async function highlightRemainingFields(page, results, atsType) {
  try {
    // Find empty text inputs
    const inputs = page.locator('input[type="text"]:not([value]), input:not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea');
    const count = await inputs.count();
    let highlighted = 0;
    for (let i = 0; i < count; i++) {
      const inp = inputs.nth(i);
      if (!(await inp.isVisible().catch(() => false))) continue;
      const val = await inp.inputValue().catch(() => '');
      if (val.trim() !== '') continue;

      // Try to get field name
      const name = await inp.getAttribute('name').catch(() => '') || await inp.getAttribute('id').catch(() => '') || '';
      const placeholder = await inp.getAttribute('placeholder').catch(() => '') || '';

      // Skip if it looks like it was already handled
      if (/first|last|name|email|phone|location|city|linkedin|github|cover|resume|cv/i.test(name + placeholder)) continue;

      await highlightElement(page, inp);
      highlighted++;
      results.fieldsHighlighted.push({ label: name || placeholder || `input_${i}`, type: 'text' });
    }

    // Find empty selects (dropdowns)
    const selects = page.locator('select');
    const selCount = await selects.count();
    for (let i = 0; i < selCount; i++) {
      const sel = selects.nth(i);
      if (!(await sel.isVisible().catch(() => false))) continue;
      await highlightElement(page, sel);
      const sName = await sel.getAttribute('name').catch(() => '') || await sel.getAttribute('id').catch(() => '') || '';
      highlighted++;
      results.fieldsHighlighted.push({ label: sName || `select_${i}`, type: 'dropdown' });
    }

    if (highlighted > 0) {
      console.log(`  ⚠ ${highlighted} field(s) highlighted (red border) — please review and fill manually.`);
    }
  } catch (e) {
    results.errors.push(`Highlighting error: ${e.message}`);
  }
}

// ─── Screenshot ────────────────────────────────────────────────────

async function takeScreenshot(page, jobId) {
  const outDir = ensureOutputDir(jobId);
  const screenshotPath = resolve(outDir, 'application_preview.png');
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`  📸 Screenshot saved to: output/${jobId}/application_preview.png`);
  } catch (e) {
    console.error(`  ⚠ Screenshot failed: ${e.message}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('Usage: node src/auto_apply.js <jobId>');
    console.error('Example: node src/auto_apply.js gh_stripe_8044460');
    process.exit(1);
  }

  // Load job data
  const { job, isPerm } = loadJob(jobId);
  const jobType = isPerm ? 'permanent' : 'contract';
  console.log(`\n  Auto-Apply: ${job.title} @ ${job.company}`);
  console.log(`  Type: ${jobType} | Source: ${job.source}`);
  console.log(`  Original URL: ${job.url}`);

  // Resolve the actual application URL
  const applyUrl = resolveApplicationUrl(job);
  const atsType = detectAtsType(applyUrl);
  console.log(`  Application URL: ${applyUrl}`);
  console.log(`  ATS detected: ${atsType}`);

  // Check for cover letter
  const coverLetter = loadCoverLetter(jobId);
  if (coverLetter) {
    console.log(`  Cover letter: found (${coverLetter.length} chars)`);
  } else {
    console.log(`  Cover letter: not found — run "node src/tailor.js ${jobId}" first to generate one`);
  }

  // Check CV
  if (!existsSync(CV_PATH)) {
    console.error(`\n  ✗ CV file not found: ${CV_PATH}`);
    console.error('    Please verify the path and try again.');
    process.exit(1);
  }

  // Launch browser
  console.log('\n  Launching browser...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  // Listen for new pages (popups/tabs from Apply buttons)
  const pages = [];
  context.on('page', (p) => pages.push(p));

  const page = await context.newPage();

  let results;
  try {
    // Navigate to application URL
    console.log(`  Navigating to: ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Check if a popup/tab opened (Greenhouse embedded apply often does this)
    if (pages.length > 0) {
      console.log(`  ${pages.length} popup(s) detected — switching to application form...`);
      const formPage = pages[pages.length - 1];
      await formPage.waitForLoadState('networkidle');
      await formPage.bringToFront();

      // Fill on the popup page
      if (atsType === 'greenhouse') {
        results = await fillGreenhouse(formPage, job);
      } else if (atsType === 'lever') {
        results = await fillLever(formPage, job);
      } else if (atsType === 'ashby') {
        results = await fillAshby(formPage, job);
      } else {
        results = await fillGeneric(formPage, job);
      }

      // Screenshot the application form
      await takeScreenshot(formPage, jobId);
    } else {
      // Fill on the main page
      if (atsType === 'greenhouse') {
        results = await fillGreenhouse(page, job);
      } else if (atsType === 'lever') {
        results = await fillLever(page, job);
      } else if (atsType === 'ashby') {
        results = await fillAshby(page, job);
      } else {
        results = await fillGeneric(page, job);
      }

      // Screenshot
      await takeScreenshot(page, jobId);
    }

    // Save log
    saveLog(jobId, results);

    // Summary
    console.log('\n  ──────────────────────────────────────────');
    console.log(`  ✅ Form filled`);
    console.log(`     ${results.fieldsFilled.length} field(s) filled`);
    console.log(`     ${results.fieldsSkipped.length} field(s) skipped`);
    console.log(`     ${results.fieldsHighlighted.length} field(s) highlighted for review`);
    if (results.errors.length > 0) {
      console.log(`     ${results.errors.length} error(s) encountered`);
    }
    console.log('  ──────────────────────────────────────────');
    console.log('\n  Form filled. Review and submit manually in the browser window.');
    console.log('  The browser will stay open — close it when done.\n');

    // Keep browser open — wait indefinitely
    await new Promise(() => {});

  } catch (e) {
    console.error(`\n  ✗ Fatal error: ${e.message}`);
    if (results) {
      results.errors.push(`Fatal: ${e.message}`);
      saveLog(jobId, results);
    }
    await browser.close();
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
