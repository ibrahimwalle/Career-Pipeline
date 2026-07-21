# Profile Files

This directory holds your personal data. **These files are gitignored** — they contain your CV, experience, rates, and contact information.

## Setup

Copy the example files and fill in your details:

```bash
cp profile/master_doc.example.md profile/master_doc.md
cp profile/cv.example.md profile/cv.md
cp profile/contract_profile.example.json profile/contract_profile.json
cp profile/contract_cv.example.md profile/contract_cv.md
```

Then edit each file with your actual experience, rates, and preferences.

## Files

| File | Purpose | Used by |
|---|---|---|
| `master_doc.md` | Full career document with experience + interview stories | `score.js`, `tailor.js`, Claude |
| `cv.md` | Base CV text | `tailor.js` |
| `contract_profile.json` | Rates, availability, IR35, contract preferences | `contract_score.js`, `contract_tailor.js` |
| `contract_cv.md` | Delivery-focused contract CV | `contract_tailor.js` |
