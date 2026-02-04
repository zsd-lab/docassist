# Doc Assist Server

## Quality gap improvements – testing

### Quick smoke test
1. Sync a Doc/Tab from the sidebar.
2. Open the chat sidebar and ask a doc-specific question.
3. Verify:
   - Answer is grounded in the document.
   - The sidebar shows a **Sources** block with filename/section/snippet.

### Regression harness (local)
1. Set a known `docId` in [test/quality/questions.json](test/quality/questions.json).
2. Run:
   - `DOCASSIST_BASE_URL=http://localhost:3000 node test/quality/run_quality_check.js`
3. Inspect output in [test/quality/last_run.json](test/quality/last_run.json).

### Config flags (optional)
- `DOCASSIST_SUMMARY_ENABLED` (default: true)
- `DOCASSIST_CHUNKING_ENABLED` (default: true)
- `DOCASSIST_CHUNK_MAX_TOKENS` (default: 700)
- `DOCASSIST_CHUNK_OVERLAP_TOKENS` (default: 150)
- `DOCASSIST_FORCE_FILE_SEARCH` (default: true)
- `DOCASSIST_TWO_STEP_ENABLED` (default: false)
- `DOCASSIST_CHAT_LOG_ENABLED` (default: true)
