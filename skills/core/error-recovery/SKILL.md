---
name: error-recovery
description: Intelligent error diagnosis, automatic recovery strategies, and prevention of recurring failures
author: Writing Secrets
version: 1.0.0
triggers:
  - "error"
  - "fix error"
  - "something broke"
  - "failed"
  - "not working"
  - "debug"
  - "troubleshoot"
  - "diagnose"
  - "recovery"
permissions:
  - file:read
  - file:write
---

# Error Recovery — Core Skill

When things go wrong, AuthorClaw doesn't just report the error — it diagnoses the root cause, attempts automatic recovery, and remembers the fix for next time.

## Error Categories

### 1. AI Provider Errors

**Symptoms**: API timeouts, rate limits, auth failures, model unavailability
```
Error Detected: Gemini API returned 429 (rate limited)

Diagnosis: Too many requests in short period (>60/min)
Recovery Strategy:
  1. ✅ Wait 30 seconds and retry (attempt 1 of 3)
  2. ⏳ Switch to DeepSeek as fallback provider
  3. ⏳ If all providers fail, queue the task for later

Lesson Stored: "Gemini rate limits at ~60 req/min.
Add 500ms delay between batch requests."
```

**Recovery Playbook**:
- 429 Rate Limited → Wait + retry → Switch provider → Queue
- 401 Unauthorized → Check API key in vault → Alert user if missing
- 503 Service Unavailable → Retry with backoff → Switch provider
- Timeout → Reduce prompt length → Retry → Switch provider
- Content filtered → Rephrase prompt → Retry without triggering content filter
- Context too long → Truncate prior results → Summarize context → Retry

### 2. Goal Execution Errors

**Symptoms**: Step failures, invalid AI output, parsing failures

```
Error Detected: Goal step "Create character profiles" failed
AI returned unstructured text instead of character profiles

Diagnosis: Prompt was too open-ended for structured output
Recovery Strategy:
  1. ✅ Reformulate prompt with explicit structure requirements
  2. ✅ Add output format example to prompt
  3. ✅ Retry with reformulated prompt

New prompt: "Create character profiles in this exact format:
NAME: [name]
AGE: [age]
ROLE: [protagonist/antagonist/supporting]
..."

Result: ✅ Step succeeded on retry
```

**Recovery Playbook**:
- Unstructured output → Add format constraints → Retry
- JSON parse error → Strip markdown fences → Extract JSON → Retry with stricter prompt
- Output too short → Request longer output → Increase max tokens → Retry
- Repeated failure → Skip step → Flag for user review → Continue goal
- Nonsensical output → Switch provider → Reduce temperature → Retry

### 3. File System Errors

**Symptoms**: Write failures, permission denied, path not found

```
Error Detected: Cannot write to workspace/projects/my-novel/chapter-1.md
Permission denied

Diagnosis: Directory doesn't exist or wrong permissions
Recovery Strategy:
  1. ✅ Create directory with mkdir -p
  2. ✅ Retry write
  3. If still failing → Check sandbox permissions → Alert user

Result: ✅ Created directory and wrote file successfully
```

**Recovery Playbook**:
- ENOENT (file not found) → Create parent directories → Retry
- EACCES (permission denied) → Check sandbox rules → Alert user
- ENOSPC (disk full) → Alert user with disk usage info
- EISDIR (is a directory) → Correct the path → Retry

### 4. Network/Research Errors

**Symptoms**: Fetch timeouts, blocked domains, invalid responses

**Recovery Playbook**:
- Timeout → Retry with shorter timeout → Try different URL → Skip
- Blocked domain → Inform user → Suggest alternative source
- Empty response → Retry → Try cached version → Use AI knowledge instead
- SSL error → Alert user (don't bypass)

### 5. Memory/Context Errors

**Symptoms**: Context too long, corrupted memory files, missing context

**Recovery Playbook**:
- Context overflow → Summarize old context → Trim to fit → Retry
- Corrupted JSONL → Skip bad lines → Rebuild from valid entries → Alert user
- Missing memory file → Create empty file → Continue with fresh context

## Automatic Recovery System

### The Recovery Loop

```
1. Error detected
2. Classify error (provider/goal/file/network/memory)
3. Look up recovery playbook
4. Check improvement log for past fixes for this error type
5. Execute recovery strategy (up to 3 attempts)
6. If recovered:
   → Log the successful fix
   → Continue with the task
   → Store lesson for future prevention
7. If not recovered:
   → Pause the goal (don't fail silently)
   → Send clear error report to user
   → Suggest manual intervention steps
   → Store the failure for analysis
```

### Error Prevention

The real power is preventing errors before they happen:

1. **Pre-flight checks** — Before each step, verify:
   - AI provider is responsive (quick ping)
   - Required files exist and are readable
   - Sufficient disk space for output
   - API key is still valid (not expired)

2. **Pattern recognition** — If an error occurred 3+ times:
   - Add automatic mitigation before the risky step
   - Example: Always add 500ms delay before Gemini calls (learned from rate limits)

3. **Graceful degradation** — If the best approach fails:
   - Fall back to simpler approach
   - Use a different provider
   - Reduce scope rather than fail completely

## Error Log

All errors and recoveries are logged to `workspace/.audit/error-log.jsonl`:

```json
{
  "timestamp": "2026-02-24T15:30:00Z",
  "category": "provider",
  "error": "Gemini API 429 rate limited",
  "goalId": "goal-5",
  "stepId": "goal-5-step-3",
  "recoveryAttempts": [
    { "strategy": "wait_retry", "success": false },
    { "strategy": "switch_provider", "provider": "deepseek", "success": true }
  ],
  "resolved": true,
  "lesson": "Rate limit hit during batch execution. Added 500ms delay.",
  "preventionRule": "delay_between_gemini_calls_500ms"
}
```

## User-Facing Error Reports

When errors can't be auto-resolved, the user gets a clear report:

```
⚠️ I hit a problem and couldn't fix it automatically.

What happened: Gemini and DeepSeek both returned errors
while trying to write Chapter 5.

What I tried:
  1. Retry with Gemini (3x) — failed (rate limited)
  2. Switch to DeepSeek — failed (API key expired)
  3. Switch to Ollama — not configured

What you can do:
  • Check your DeepSeek API key (may need renewal)
  • Wait 5 minutes and say "continue" to retry
  • Add an Ollama endpoint as a backup provider

Your goal is paused at step 5/12. No work was lost.
```

## Commands
- `diagnose [error]` — Analyze a specific error
- `show error log` — View recent errors and recoveries
- `error stats` — Error frequency and recovery success rates
- `test recovery` — Simulate an error to test recovery
- `prevention rules` — Show active error prevention rules
