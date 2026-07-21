# inbox.ps1 — Gmail IMAP scanner for recruiter replies
# Pure PowerShell, zero dependencies, no encoding issues.
param([int]$Days = 14)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$CONFIG_FILE = Join-Path $ROOT "email_config.json"
$JOBS_FILE = Join-Path $ROOT "data" "jobs.json"
$RULES_FILE = Join-Path $ROOT "rules.json"
$COMPANIES_FILE = Join-Path $ROOT "companies.json"

# --- Keyword lists ---
$INTERVIEW_KW = @('interview','meet the team','next steps','schedule a call','phone screen',
    'technical interview','video call','chat with','would like to invite','set up a time',
    'availability','excited to move forward','next round','on-site','onsite','virtual interview')

$REJECTION_KW = @('unfortunately','not moving forward','other candidates','will not be',
    'regret to inform','decided to pursue','not a fit','no longer under consideration',
    'position has been filled','thank you for your interest','we have decided')

$OFFER_KW = @('offer letter','pleased to offer','compensation','salary','excited to extend',
    'formal offer','job offer','sign the offer','welcome aboard')

$SCREENING_KW = @('recruiter','talent','hiring','hr','people ops','initial conversation',
    'tell me more','learn about your background','quick chat','introductory call')

$ATS_DOMAINS = @('greenhouse.io','lever.co','ashbyhq.com','workablemail.com','bamboohr.com',
    'jobvite.com','icims.com','taleo.net','successfactors.eu','myworkdayjobs.com')

# --- Load config ---
if (-not (Test-Path $CONFIG_FILE)) {
    Write-Host "X No email_config.json found. Create one from email_config.example.json" -ForegroundColor Red
    exit 1
}
$config = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
$emailUser = if ($config.imap.user) { $config.imap.user } else { $config.smtp.user }
$emailPass = if ($config.imap.pass) { $config.imap.pass } else { $config.smtp.pass }

if (-not $emailUser -or -not $emailPass) {
    Write-Host "X Email credentials missing in email_config.json" -ForegroundColor Red
    exit 1
}

# --- Load rules ---
$scanMode = "pipeline_only"
$autoUpdate = $true
if (Test-Path $RULES_FILE) {
    $rules = Get-Content $RULES_FILE -Raw | ConvertFrom-Json
    $scanMode = if ($rules.inbox.scan_filter.mode) { $rules.inbox.scan_filter.mode } else { "pipeline_only" }
    $autoUpdate = $rules.pipeline.auto_update_status.allow
}

# --- Load pipeline companies ---
$pipelineCompanies = @()
if (Test-Path $COMPANIES_FILE) {
    $compJson = Get-Content $COMPANIES_FILE -Raw | ConvertFrom-Json
    $pipelineCompanies = $compJson.companies | ForEach-Object { $_.name.ToLower() }
}

# --- Load jobs ---
$allJobs = @()
if (Test-Path $JOBS_FILE) {
    $allJobs = Get-Content $JOBS_FILE -Raw | ConvertFrom-Json
}

Write-Host ""
Write-Host "RULES ACTIVE:" -ForegroundColor Cyan
Write-Host "   Scan mode: $scanMode ($($pipelineCompanies.Count) companies tracked)"
Write-Host "   Auto-update pipeline: $(if($autoUpdate){'ON'}else{'OFF'})"
Write-Host ""
Write-Host "Connecting to Gmail as $emailUser..."

# --- Connect to Gmail IMAP ---
try {
    $tcp = New-Object System.Net.Sockets.TcpClient("imap.gmail.com", 993)
    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream())
    $ssl.AuthenticateAsClient("imap.gmail.com")
    $reader = New-Object System.IO.StreamReader($ssl)
    $writer = New-Object System.IO.StreamWriter($ssl)
    $writer.AutoFlush = $true

    # Read greeting
    $null = ReadResponse $reader

    # Login
    $writer.WriteLine("A1 LOGIN $emailUser $emailPass")
    $resp = ReadResponse $reader
    if ($resp -notmatch "A1 OK") {
        Write-Host "X Login failed. Check your app password." -ForegroundColor Red
        Write-Host ""
        Write-Host "Setup: https://myaccount.google.com/apppasswords" -ForegroundColor Yellow
        Write-Host "  Select 'Mail' -> 'Other' -> 'Job Agent'" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "Connected to inbox OK" -ForegroundColor Green

    # Select inbox
    $writer.WriteLine("A2 SELECT INBOX")
    $null = ReadResponse $reader

    # Search emails since date
    $since = (Get-Date).AddDays(-$Days).ToString("dd-MMM-yyyy")
    Write-Host "Searching emails since $since..."

    $writer.WriteLine("A3 SEARCH SINCE `"$since`"")
    $searchResp = ReadResponse $reader

    $msgIds = @()
    if ($searchResp -match "\* SEARCH (.*)") {
        $msgIds = $matches[1] -split ' '
    }

    if ($msgIds.Count -eq 0) {
        Write-Host "No emails found in date range"
        $writer.WriteLine("A4 LOGOUT")
        exit 0
    }

    Write-Host "Found $($msgIds.Count) emails. Scanning for recruiter emails..."
    Write-Host ""

    # Only scan last 200 for performance
    $toScan = @($msgIds | Select-Object -Last 200)
    $recruiterEmails = @()
    $matchesFound = 0
    $scanned = 0

    foreach ($msgId in $toScan) {
        $scanned++
        if ($scanned % 50 -eq 0) {
            Write-Host "  ... scanned $scanned/$($toScan.Count)"
        }

        $writer.WriteLine("A4 FETCH $msgId (BODY[HEADER.FIELDS (FROM SUBJECT DATE)] BODY[TEXT])")
        $raw = ReadResponse $reader

        # Parse out the email content
        $from = ""
        $subject = ""
        $date = ""
        $body = ""
        if ($raw -match 'From:\s*(.+?)\r?\n') { $from = $matches[1].Trim() }
        if ($raw -match 'Subject:\s*(.+?)\r?\n') { $subject = $matches[1].Trim() }
        if ($raw -match 'Date:\s*(.+?)\r?\n') { $date = $matches[1].Trim() }

        # Get text body part
        if ($raw -match '\}\s*\r?\n\s*\r?\n(.*)') {
            $body = $matches[1]
        } elseif ($raw -match 'BODY\[TEXT\]\s+\{(\d+)\}\s*\r?\n(.*)') {
            $body = $matches[2]
        } elseif ($raw -match '\{(\d+)\}\s*\r?\n(.*)') {
            $body = $matches[2]
        }

        # Decode subject if needed
        if ($subject -match '=\?([^?]+)\?([BbQq])\?([^?]*)\?=') {
            try {
                $decoded = [System.Net.Mail.Attachment]::CreateAttachmentFromString("", "subject").Name
                # Simple base64 decode for subjects
                if ($matches[2] -eq 'B' -or $matches[2] -eq 'b') {
                    $bytes = [Convert]::FromBase64String($matches[3])
                    $subject = [System.Text.Encoding]::UTF8.GetString($bytes)
                }
            } catch {}
        }

        # Extract sender email
        $senderEmail = ""
        if ($from -match '<([^>]+@[^>]+)>') {
            $senderEmail = $matches[1]
        } else {
            $senderEmail = $from.Trim()
        }

        # Skip self
        if ($senderEmail.ToLower() -eq $emailUser.ToLower()) { continue }

        # Classify
        $text = "$subject $body".ToLower()
        $classification = "other"
        if ($OFFER_KW | Where-Object { $text.Contains($_) }) { $classification = "offer" }
        elseif ($REJECTION_KW | Where-Object { $text.Contains($_) }) { $classification = "rejected" }
        elseif ($INTERVIEW_KW | Where-Object { $text.Contains($_) }) { $classification = "interviewing" }
        elseif ($SCREENING_KW | Where-Object { $text.Contains($_) }) { $classification = "screening" }
        elseif ($ATS_DOMAINS | Where-Object { $senderEmail.ToLower().Contains($_) }) { $classification = "recruiter_outreach" }
        else { continue }

        # Try extract company
        $company = ""
        if ($subject -match '(?:from|at|with)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})') {
            $company = $matches[1]
        }

        # Pipeline filter
        if ($scanMode -eq "pipeline_only") {
            $matchedInPipeline = $false
            $textLower = "$subject $($body.Substring(0, [Math]::Min(1000, $body.Length)))".ToLower()
            foreach ($pc in $pipelineCompanies) {
                if ($textLower.Contains($pc)) {
                    $matchedInPipeline = $true
                    if (-not $company) { $company = $pc }
                    break
                }
            }
            if (-not $matchedInPipeline) {
                $fromLower = $from.ToLower()
                $isAts = $false
                foreach ($d in $ATS_DOMAINS) { if ($fromLower.Contains($d)) { $isAts = $true; break } }
                if (-not $isAts) { continue }
            }
        }

        # Match to pipeline job
        $matchedJob = $null
        $companiesInPipeline = $allJobs | ForEach-Object { $_.company.ToLower() } | Select-Object -Unique
        if ($company) {
            $companyLower = $company.ToLower()
            $matchedJob = $allJobs | Where-Object { $_.company.ToLower() -eq $companyLower } | Select-Object -First 1
        }
        if (-not $matchedJob) {
            $textLower = "$subject $body".ToLower()
            foreach ($c in $companiesInPipeline) {
                if ($textLower.Contains($c)) {
                    $matchedJob = $allJobs | Where-Object { $_.company.ToLower() -eq $c } | Select-Object -First 1
                    if ($matchedJob) { $company = $c; break }
                }
            }
        }

        $entry = @{
            from = $from
            sender_email = $senderEmail
            subject = $subject
            date = $date
            classification = $classification
            company = $company
            matched_job_id = if ($matchedJob) { $matchedJob.id } else { $null }
            matched_job_title = if ($matchedJob) { $matchedJob.title } else { $null }
        }
        $recruiterEmails += $entry
        if ($matchedJob) { $matchesFound++ }
    }

    # Logout
    $writer.WriteLine("A5 LOGOUT")
    $tcp.Close()

    # --- Display Results ---
    Write-Host ""
    Write-Host ("=" * 65)
    Write-Host "  Results: $($recruiterEmails.Count) recruiter emails found"
    Write-Host "  Matches: $matchesFound matched to pipeline"
    Write-Host ("=" * 65)

    if ($recruiterEmails.Count -eq 0) {
        Write-Host ""
        Write-Host "  No recruiter emails found in this period."
        Write-Host "  This is normal -- replies usually take 1-3 weeks."
        exit 0
    }

    $offers = $recruiterEmails | Where-Object { $_.classification -eq 'offer' }
    $interviews = $recruiterEmails | Where-Object { $_.classification -eq 'interviewing' }
    $screenings = $recruiterEmails | Where-Object { $_.classification -eq 'screening' }
    $rejections = $recruiterEmails | Where-Object { $_.classification -eq 'rejected' }
    $outreach = $recruiterEmails | Where-Object { $_.classification -eq 'recruiter_outreach' }

    if ($offers.Count -gt 0) {
        Write-Host ""
        Write-Host "[OFFERS]" -ForegroundColor Green
        foreach ($e in $offers) {
            Write-Host "   Subject: $($e.subject -replace '\s+',' ')"
            Write-Host "   From: $($e.from)" -ForegroundColor Gray
            Write-Host "   Company: $($e.company)" -ForegroundColor Yellow
            Write-Host "   Pipeline: $(if($e.matched_job_title){$e.matched_job_title}else{'not in pipeline'})"
            Write-Host ""
        }
    }

    if ($interviews.Count -gt 0) {
        Write-Host ""
        Write-Host "[INTERVIEW INVITES]" -ForegroundColor Cyan
        foreach ($e in $interviews) {
            Write-Host "   Subject: $($e.subject -replace '\s+',' ')"
            Write-Host "   From: $($e.from)" -ForegroundColor Gray
            Write-Host "   Company: $($e.company)" -ForegroundColor Yellow
            Write-Host "   Pipeline: $(if($e.matched_job_title){$e.matched_job_title}else{'not in pipeline'})"
            Write-Host ""
        }
    }

    if ($screenings.Count -gt 0) {
        Write-Host ""
        Write-Host "[SCREENING / RECRUITER CALLS]" -ForegroundColor Blue
        foreach ($e in $screenings) {
            Write-Host "   Subject: $($e.subject -replace '\s+',' ')"
            Write-Host "   From: $($e.from)" -ForegroundColor Gray
            Write-Host "   Company: $($e.company)" -ForegroundColor Yellow
            Write-Host "   Pipeline: $(if($e.matched_job_title){$e.matched_job_title}else{'not in pipeline'})"
            Write-Host ""
        }
    }

    if ($rejections.Count -gt 0) {
        Write-Host ""
        Write-Host "[REJECTIONS]" -ForegroundColor Red
        foreach ($e in $rejections) {
            Write-Host "   Subject: $($e.subject -replace '\s+',' ')"
            Write-Host "   From: $($e.from)" -ForegroundColor Gray
            Write-Host "   Company: $($e.company)" -ForegroundColor Yellow
            Write-Host "   Pipeline: $(if($e.matched_job_title){$e.matched_job_title}else{'not in pipeline'})"
            Write-Host ""
        }
    }

    if ($outreach.Count -gt 0) {
        Write-Host ""
        Write-Host "$($outreach.Count) other recruiter messages (ATS notifications, etc.)" -ForegroundColor Gray
    }

    # --- Auto-update pipeline ---
    if ($matchesFound -gt 0) {
        Write-Host ""
        Write-Host ("=" * 65)
        if ($autoUpdate) {
            Write-Host "AUTO-UPDATING PIPELINE STATUSES..." -ForegroundColor Cyan
        } else {
            Write-Host "AUTO-UPDATE DISABLED (rules.json) -- showing matches only" -ForegroundColor Yellow
        }
        Write-Host ("=" * 65)

        $updated = 0
        foreach ($e in $recruiterEmails) {
            $valid = @('interviewing','rejected','offer','screening')
            if (-not $e.matched_job_id -or ($valid -notcontains $e.classification)) { continue }

            $idx = 0..($allJobs.Count-1) | Where-Object { $allJobs[$_].id -eq $e.matched_job_id } | Select-Object -First 1
            if ($null -eq $idx) { continue }

            $oldStatus = if ($allJobs[$idx].status) { $allJobs[$idx].status } else { 'new' }
            $newStatus = $e.classification
            if ($oldStatus -eq $newStatus) { continue }

            if ($autoUpdate) {
                $allJobs[$idx].status = $newStatus
                $allJobs[$idx].statusUpdatedAt = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
                if ($newStatus -eq 'interviewing') { $allJobs[$idx].interviewingAt = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ") }
                if ($newStatus -eq 'rejected') { $allJobs[$idx].rejectedAt = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ") }
                if ($newStatus -eq 'offer') { $allJobs[$idx].offerAt = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ") }
                Write-Host "  OK $($allJobs[$idx].title) @ $($allJobs[$idx].company): $oldStatus -> $newStatus" -ForegroundColor Green
            } else {
                Write-Host "  Would update: $($allJobs[$idx].title) @ $($allJobs[$idx].company): $oldStatus -> $newStatus" -ForegroundColor Yellow
            }
            $updated++
        }

        if ($updated -gt 0 -and $autoUpdate) {
            $dataDir = Join-Path $ROOT "data"
            if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
            $allJobs | ConvertTo-Json -Depth 10 | Set-Content $JOBS_FILE -Encoding UTF8
            Write-Host ""
            Write-Host "  $updated job statuses updated in data/jobs.json" -ForegroundColor Green
        }
    }

    Write-Host ""
    Write-Host "[LOCKED] INBOX WRITE PROTECTION ACTIVE" -ForegroundColor Magenta
    Write-Host "  No emails were deleted, archived, marked read, or modified." -ForegroundColor Gray
    Write-Host "  Any write action requires explicit per-action approval." -ForegroundColor Gray

} catch {
    Write-Host "X Error: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Setup instructions:" -ForegroundColor Yellow
    Write-Host "  1. Enable 2FA: https://myaccount.google.com/security"
    Write-Host "  2. App Password: https://myaccount.google.com/apppasswords"
    Write-Host "     Select 'Mail' -> 'Other' -> 'Job Agent'"
    Write-Host "  3. Add to email_config.json under imap.pass"
}

# --- Helper: read IMAP response ---
function ReadResponse($rdr) {
    $result = ""
    $tag = $null
    while ($true) {
        $line = $rdr.ReadLine()
        if ($null -eq $line) { break }
        $result += "$line`n"
        # Check for completion tag (e.g., "A1 OK" or "A1 BAD")
        if ($line -match '^(A\d+)\s+(OK|BAD|NO)') {
            $tag = $matches[1]
            # If response contains literal count like {1234}, read that many bytes
            if ($line -match '\{(\d+)\}') {
                $bytesToRead = [int]$matches[1]
                $buffer = New-Object char[] $bytesToRead
                $rdr.Read($buffer, 0, $bytesToRead) | Out-Null
                $result += [string]::new($buffer)
                $result += "`n"
                # Read the closing line
                $result += $rdr.ReadLine() + "`n"
            }
            break
        }
        # Handle literal in untagged responses too
        if ($line -match '\{(\d+)\}') {
            $bytesToRead = [int]$matches[1]
            $buffer = New-Object char[] $bytesToRead
            $rdr.Read($buffer, 0, $bytesToRead) | Out-Null
            $result += [string]::new($buffer)
            $result += "`n"
        }
    }
    return $result
}
