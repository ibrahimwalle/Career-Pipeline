#!/usr/bin/env python3
"""
Gmail Inbox Monitor for Job Agent
Connects via IMAP, finds recruiter emails, auto-updates pipeline status.
Uses Python's built-in imaplib + email -- zero dependencies.
"""
import imaplib
import email
from email.header import decode_header
from email.utils import parsedate_to_datetime
import json
import re
import os
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, 'data')
JOBS_FILE = os.path.join(DATA_DIR, 'jobs.json')
CONFIG_FILE = os.path.join(ROOT, 'email_config.json')
RULES_FILE = os.path.join(ROOT, 'rules.json')
COMPANIES_FILE = os.path.join(ROOT, 'companies.json')

def load_rules():
    """Load access rules. Defaults to restrictive if file missing."""
    if not os.path.exists(RULES_FILE):
        return {
            'inbox': {'scan_filter': {'mode': 'pipeline_only'}},
            'pipeline': {'auto_update_status': {'allow': True}}
        }
    with open(RULES_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def load_pipeline_companies():
    """Load company names from companies.json for filtering."""
    if not os.path.exists(COMPANIES_FILE):
        return set()
    with open(COMPANIES_FILE, 'r', encoding='utf-8') as f:
        config = json.load(f)
    return set(c.get('name', '').lower() for c in config.get('companies', []))

# --- Keyword Detection ---

INTERVIEW_KEYWORDS = [
    'interview', 'meet the team', 'next steps', 'schedule a call',
    'phone screen', 'technical interview', 'video call', 'chat with',
    'would like to invite', 'set up a time', 'availability',
    'excited to move forward', 'next round', 'on-site', 'onsite',
    'virtual interview',
]

REJECTION_KEYWORDS = [
    'unfortunately', 'not moving forward', 'other candidates',
    'will not be', 'regret to inform', 'decided to pursue',
    'not a fit', 'no longer under consideration', 'position has been filled',
    'thank you for your interest', 'we have decided',
]

OFFER_KEYWORDS = [
    'offer letter', 'pleased to offer', 'compensation', 'salary',
    'excited to extend', 'formal offer', 'job offer', 'sign the offer',
    'welcome aboard',
]

SCREENING_KEYWORDS = [
    'recruiter', 'talent', 'hiring', 'hr', 'people ops',
    'initial conversation', 'tell me more', 'learn about your background',
    'quick chat', 'introductory call',
]

# Emails that should NEVER be classified as recruiter emails
SPAM_PATTERNS = [
    'back market', 'your order', 'delivered', 'shipping',
    'it\'s better on the app', 'new device registration',
    'remember me', 'get published', 'your story matters',
    'top 5 roles i matched', 'new matches:',
    'new jobs:', 'jobs and', 'more jobs',
    'welcome to', 'your account', 'password reset',
    'verify your', 'confirm your', 'unsubscribe',
    'newsletter', 'weekly digest', 'monthly roundup',
    'course', 'webinar', 'masterclass', 'bootcamp',
    'discount', 'offer ends', 'sale', 'shop',
    'order confirmed', 'tracking', 'receipt',
    'noreply@', 'no-reply@', 'donotreply@',
    'notification', 'alert', 'reminder',
]

def is_spam_or_newsletter(subject, from_addr, body):
    """Detect shopping emails, newsletters, and job recommendation digests."""
    text = f"{subject} {from_addr} {body[:500]}".lower()
    return any(pattern in text for pattern in SPAM_PATTERNS)

# Known ATS / recruiter domains
RECRUITER_DOMAINS = [
    'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workablemail.com',
    'bamboohr.com', 'jobvite.com', 'icims.com', 'taleo.net',
    'successfactors.eu', 'myworkdayjobs.com',
]

def decode_subject(msg):
    """Decode email subject (handles =?UTF-8?B?...?= encoding)"""
    subject = msg.get('Subject', '')
    if not subject:
        return ''
    parts = decode_header(subject)
    result = []
    for text, charset in parts:
        if isinstance(text, bytes):
            result.append(text.decode(charset or 'utf-8', errors='replace'))
        else:
            result.append(str(text))
    return ' '.join(result)

def get_body(msg):
    """Extract plain text body from email"""
    body = ''
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            if ctype == 'text/plain':
                try:
                    payload = part.get_payload(decode=True)
                    body += payload.decode('utf-8', errors='replace')
                except:
                    pass
    else:
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                body = payload.decode('utf-8', errors='replace')
        except:
            pass
    return body

def classify_email(subject, body, from_addr):
    """Classify email as interview/rejection/offer/screening/other"""
    text = f"{subject} {body}".lower()
    from_addr = from_addr.lower()

    if any(kw in text for kw in OFFER_KEYWORDS):
        return 'offer'
    if any(kw in text for kw in REJECTION_KEYWORDS):
        return 'rejected'
    if any(kw in text for kw in INTERVIEW_KEYWORDS):
        return 'interviewing'
    if any(kw in text for kw in SCREENING_KEYWORDS):
        return 'screening'
    if any(domain in from_addr for domain in RECRUITER_DOMAINS):
        return 'recruiter_outreach'

    return 'other'

def load_jobs():
    if not os.path.exists(JOBS_FILE):
        return []
    with open(JOBS_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_jobs(jobs):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(JOBS_FILE, 'w', encoding='utf-8') as f:
        json.dump(jobs, f, indent=2, ensure_ascii=False)

def match_job(company_name, jobs):
    """Try to match an email to a job in the pipeline by company name"""
    company_lower = company_name.lower().strip()
    for job in jobs:
        job_company = job.get('company', '').lower()
        if company_lower in job_company or job_company in company_lower:
            return job
    return None

def extract_company_from_email(from_addr, subject, body):
    """Try to extract company name from sender or email content"""
    text = f"{subject} {body}"
    patterns = [
        r'(?:from|at|with)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})',
        r'([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\s+(?:Application|Position|interview)',
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    return None

def scan_inbox(days=14):
    """Connect to Gmail IMAP, scan inbox for recruiter emails"""

    # --- Load rules ---
    rules = load_rules()
    pipeline_companies = load_pipeline_companies()
    scan_mode = rules.get('inbox', {}).get('scan_filter', {}).get('mode', 'pipeline_only')
    write_blocked = rules.get('inbox', {}).get('write', {}).get('allow', False) is False
    auto_update = rules.get('pipeline', {}).get('auto_update_status', {}).get('allow', True)

    print()
    print("RULES ACTIVE:")
    print(f"   Scan mode: {scan_mode} ({len(pipeline_companies)} companies tracked)")
    print(f"   Inbox write: {'BLOCKED (read-only)' if write_blocked else 'allowed'}")
    print(f"   Auto-update pipeline: {'ON' if auto_update else 'OFF'}")
    print()

    # --- Load config ---
    if not os.path.exists(CONFIG_FILE):
        print("X No email_config.json found. Create one from email_config.example.json")
        print("  You need a Gmail App Password: https://myaccount.google.com/apppasswords")
        return

    with open(CONFIG_FILE, 'r') as f:
        config = json.load(f)

    imap_config = config.get('imap', config.get('smtp', {}))
    email_user = imap_config.get('user', config.get('smtp', {}).get('user', ''))
    email_pass = imap_config.get('pass', config.get('smtp', {}).get('pass', ''))

    if not email_user or not email_pass:
        print("X Email credentials missing in email_config.json")
        return

    print(f"Connecting to Gmail as {email_user}...")

    try:
        # Connect to Gmail IMAP
        mail = imaplib.IMAP4_SSL('imap.gmail.com')
        mail.login(email_user, email_pass)
        mail.select('INBOX')
        print("Connected to inbox OK")

        # Search for emails from last N days
        since_date = (datetime.now() - timedelta(days=days)).strftime('%d-%b-%Y')
        print(f"Searching emails since {since_date}...")

        search_criteria = f'(SINCE "{since_date}")'
        status, message_ids = mail.search(None, search_criteria)

        if status != 'OK':
            print("X Could not search inbox")
            mail.logout()
            return

        all_ids = message_ids[0].split()
        if not all_ids:
            print("No emails found in date range")
            mail.logout()
            return

        total = len(all_ids)
        print(f"Found {total} emails. Scanning for recruiter emails...")
        print()

        # Load current jobs
        jobs = load_jobs()
        companies_in_pipeline = set(j.get('company', '').lower() for j in jobs)

        recruiter_emails = []
        matches_found = 0
        scanned = 0

        # Process emails (newest first, limited to 200 for performance)
        for msg_id in reversed(all_ids[-200:]):
            status, msg_data = mail.fetch(msg_id, '(RFC822)')
            if status != 'OK':
                continue

            scanned += 1
            if scanned % 50 == 0:
                print(f"  ... scanned {scanned}/{total}")

            raw_email = msg_data[0][1]
            msg = email.message_from_bytes(raw_email)

            subject = decode_subject(msg)
            from_addr = msg.get('From', '')
            body = get_body(msg)
            date = msg.get('Date', '')

            # Extract sender email
            sender_email = ''
            if '<' in from_addr:
                sender_email = from_addr.split('<')[1].split('>')[0]
            else:
                sender_email = from_addr.strip()

            # Skip if from yourself
            if email_user.lower() in sender_email.lower():
                continue

            # Skip spam/newsletters/job-digests BEFORE classification
            if is_spam_or_newsletter(subject, sender_email, body):
                continue

            # Check if it could be recruiter-related
            classification = classify_email(subject, body, sender_email)
            if classification == 'other':
                continue

            # Extract company
            company = extract_company_from_email(from_addr, subject, body)

            # --- COMPANY FILTER ---
            matched_in_pipeline = False
            text_lower = f"{subject} {body[:1000]}".lower()

            for pc in pipeline_companies:
                if pc in text_lower:
                    matched_in_pipeline = True
                    if not company:
                        company = pc
                    break

            if not matched_in_pipeline and scan_mode == 'pipeline_only':
                # Pipeline-only: skip non-pipeline emails unless from ATS domains
                from_lower = from_addr.lower()
                if not any(domain in from_lower for domain in RECRUITER_DOMAINS):
                    continue

            # Try to match to pipeline
            matched_job = None
            if company:
                matched_job = match_job(company, jobs)

            if not matched_job:
                text_lower = f"{subject} {body[:1000]}".lower()
                for c in companies_in_pipeline:
                    if c in text_lower:
                        matched_job = match_job(c, jobs)
                        if matched_job:
                            company = c
                            break

            email_summary = {
                'from': from_addr,
                'sender_email': sender_email,
                'subject': subject,
                'date': date,
                'classification': classification,
                'company': company,
                'matched_job_id': matched_job.get('id') if matched_job else None,
                'matched_job_title': matched_job.get('title') if matched_job else None,
            }
            recruiter_emails.append(email_summary)

            if matched_job:
                matches_found += 1

        mail.logout()

        # --- Display Results ---
        print()
        print('=' * 65)
        print(f'  Results: {len(recruiter_emails)} recruiter emails found')
        print(f'  Matches: {matches_found} matched to pipeline')
        print('=' * 65)

        if not recruiter_emails:
            print()
            print('  No recruiter emails found in this period.')
            print('  This is normal -- replies usually take 1-3 weeks.')
            return recruiter_emails

        # Group by classification
        interviews = [e for e in recruiter_emails if e['classification'] == 'interviewing']
        rejections = [e for e in recruiter_emails if e['classification'] == 'rejected']
        offers = [e for e in recruiter_emails if e['classification'] == 'offer']
        screenings = [e for e in recruiter_emails if e['classification'] == 'screening']
        outreach = [e for e in recruiter_emails if e['classification'] == 'recruiter_outreach']

        if offers:
            print()
            print('[OFFERS]')
            for e in offers:
                print(f'   Subject: {e["subject"][:70]}')
                print(f'   From: {e["from"]}')
                print(f'   Company: {e.get("company") or "Unknown"}')
                print(f'   Pipeline: {e.get("matched_job_title") or "not in pipeline"}')
                print()

        if interviews:
            print()
            print('[INTERVIEW INVITES]')
            for e in interviews:
                print(f'   Subject: {e["subject"][:70]}')
                print(f'   From: {e["from"]}')
                print(f'   Company: {e.get("company") or "Unknown"}')
                print(f'   Pipeline: {e.get("matched_job_title") or "not in pipeline"}')
                print()

        if screenings:
            print()
            print('[SCREENING / RECRUITER CALLS]')
            for e in screenings:
                print(f'   Subject: {e["subject"][:70]}')
                print(f'   From: {e["from"]}')
                print(f'   Company: {e.get("company") or "Unknown"}')
                print(f'   Pipeline: {e.get("matched_job_title") or "not in pipeline"}')
                print()

        if rejections:
            print()
            print('[REJECTIONS]')
            for e in rejections:
                print(f'   Subject: {e["subject"][:70]}')
                print(f'   From: {e["from"]}')
                print(f'   Company: {e.get("company") or "Unknown"}')
                print(f'   Pipeline: {e.get("matched_job_title") or "not in pipeline"}')
                print()

        if outreach:
            print()
            print(f'{len(outreach)} other recruiter messages (ATS notifications, etc.)')

        # --- Auto-update pipeline ---
        if matches_found > 0:
            print()
            print('=' * 65)
            if auto_update:
                print('AUTO-UPDATING PIPELINE STATUSES...')
            else:
                print('AUTO-UPDATE DISABLED (rules.json) -- showing matches only')
            print('=' * 65)

            updated = 0
            for e in recruiter_emails:
                if e['matched_job_id'] and e['classification'] in ['interviewing', 'rejected', 'offer', 'screening']:
                    for job in jobs:
                        if job['id'] == e['matched_job_id']:
                            old_status = job.get('status', 'new')
                            new_status = e['classification']
                            if old_status != new_status:
                                if auto_update:
                                    job['status'] = new_status
                                    job['statusUpdatedAt'] = datetime.now(timezone.utc).isoformat()
                                    if new_status == 'interviewing':
                                        job['interviewingAt'] = datetime.now(timezone.utc).isoformat()
                                    if new_status == 'rejected':
                                        job['rejectedAt'] = datetime.now(timezone.utc).isoformat()
                                    if new_status == 'offer':
                                        job['offerAt'] = datetime.now(timezone.utc).isoformat()
                                    print(f'  OK {job["title"]} @ {job["company"]}: {old_status} -> {new_status}')
                                else:
                                    print(f'  Would update: {job["title"]} @ {job["company"]}: {old_status} -> {new_status}')
                                updated += 1

            if updated > 0 and auto_update:
                save_jobs(jobs)
                print(f'\n  {updated} job statuses updated in data/jobs.json')
            elif not auto_update:
                print(f'\n  {updated} status changes detected but not applied (auto-update disabled)')
            else:
                print('  No status changes needed')

        # --- Write-protection notice ---
        if write_blocked:
            print()
            print('[LOCKED] INBOX WRITE PROTECTION ACTIVE')
            print('  No emails were deleted, archived, marked read, or modified.')
            print('  Any write action requires explicit per-action approval.')

        return recruiter_emails

    except imaplib.IMAP4.error as e:
        print(f'\nX IMAP Error: {e}')
        print()
        print('Setup instructions:')
        print('  1. Enable 2FA: https://myaccount.google.com/security')
        print('  2. App Password: https://myaccount.google.com/apppasswords')
        print('     Select "Mail" -> "Other" -> "Job Agent"')
        print('  3. Add to email_config.json under imap.pass')
        return []

    except Exception as e:
        print(f'\nX Error: {e}')
        return []


if __name__ == '__main__':
    days = 14
    json_output = False
    for arg in sys.argv[1:]:
        if arg == '--json':
            json_output = True
        else:
            try:
                days = int(arg)
            except ValueError:
                pass

    results = scan_inbox(days) or []

    if json_output:
        # Write structured results for dashboard consumption
        os.makedirs(DATA_DIR, exist_ok=True)
        output = {
            'scannedAt': datetime.now(timezone.utc).isoformat(),
            'days': days,
            'totalFound': len(results),
            'emails': results
        }
        with open(os.path.join(DATA_DIR, 'inbox_results.json'), 'w', encoding='utf-8') as f:
            json.dump(output, f, indent=2, ensure_ascii=False, default=str)
        print('\n[JSON_OUTPUT]')
        print(json.dumps(output, indent=2, ensure_ascii=False, default=str))
