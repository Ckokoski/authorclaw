---
name: prompt-optimizer
description: Automatically improves prompts based on output quality, user feedback, and A/B testing results
author: Writing Secrets
version: 1.0.0
triggers:
  - "optimize prompt"
  - "improve prompt"
  - "better prompt"
  - "prompt quality"
  - "test prompts"
  - "prompt a/b test"
  - "prompt lab"
permissions:
  - file:read
  - file:write
---

# Prompt Optimizer — Core Skill

AuthorClaw's prompts are its most important tool. This skill continuously optimizes them based on what actually produces good results — not guesswork, but measured outcomes.

## The Problem

Every skill, goal step, and system prompt contains prompts. Some work great. Some produce mediocre results. Without measurement, you're flying blind. The Prompt Optimizer tracks which prompt formulations produce the best outputs and evolves them over time.

## How It Works

### Prompt Tracking

Every prompt sent to an AI provider is logged with its outcome:

```json
{
  "promptId": "p-347",
  "timestamp": "2026-02-24T15:00:00Z",
  "template": "Write a compelling book blurb for: {{description}}...",
  "skill": "blurb-writer",
  "taskType": "marketing",
  "provider": "gemini",
  "inputTokens": 450,
  "outputTokens": 890,
  "outcome": "accepted",
  "userEdited": false,
  "qualitySignals": {
    "wordCount": 147,
    "completeness": true,
    "followedInstructions": true,
    "userAccepted": true
  }
}
```

### Quality Signals

The optimizer watches for these signals:

**Positive signals** (prompt is working):
- User accepted output without edits
- Output matched requested format/length
- No follow-up "try again" or "that's not what I meant"
- User explicitly praised the result
- Output was saved to a file (user valued it enough to keep)

**Negative signals** (prompt needs improvement):
- User heavily edited the output
- User said "try again" or "not quite"
- Output was too long/short for the task
- AI produced an error or refusal
- Output missed key requirements from the prompt
- User abandoned the result

### Prompt Evolution

When a prompt consistently underperforms, the optimizer creates variations:

```
Prompt Lab: "blurb-writer" skill
════════════════════════════════

Original (Score: 6.2/10 across 14 uses):
"Write a compelling book blurb for: {{description}}.
Create 3 versions: (1) short tagline, (2) back-cover
blurb (150 words), (3) Amazon description with HTML."

Variation A (Score: 7.8/10 across 6 uses):
"You are a bestselling book marketer. Write a blurb
for: {{description}}.
Rules: Hook in first sentence. No spoilers past Act 1.
End with a question or cliffhanger.
Format: tagline (10 words max), back cover (150 words),
Amazon listing (with <b> tags for emphasis)."

Variation B (Score: 8.1/10 across 4 uses):
"Study these bestselling blurbs for pacing and hooks:
[example 1], [example 2].
Now write a blurb for: {{description}} using the same
techniques. Output: tagline, 150-word back cover,
Amazon description."

→ RECOMMENDATION: Promote Variation B to primary.
```

### Optimization Strategies

1. **Add Specificity** — Vague prompts ("write well") → Specific ("write in present tense, under 3000 words, with a cliffhanger ending")

2. **Add Examples** — Show the AI what "good" looks like for this task

3. **Add Constraints** — Boundaries improve output ("exactly 3 paragraphs", "no adverbs", "start with dialogue")

4. **Role Framing** — "You are a [expert role]" can dramatically change quality

5. **Chain of Thought** — For complex tasks, add "First analyze X, then plan Y, then write Z"

6. **Negative Examples** — "Do NOT do X" can be as powerful as "Do Y"

7. **Output Format** — Specifying exact output format reduces parsing errors

### Automatic Optimization

When the optimizer detects a consistently weak prompt:

1. Analyzes the failure pattern (too vague? wrong format? missing context?)
2. Generates 2-3 variations using different strategies
3. Rotates variations across future uses (A/B testing)
4. Tracks outcomes per variation
5. Promotes the best performer after sufficient data (minimum 5 uses)
6. Logs the change to the improvement log

### Storage

Prompt data lives in `workspace/memory/prompts/`:
```
workspace/memory/prompts/
├── prompt-log.jsonl          # All prompt executions and outcomes
├── prompt-variants.json      # Active A/B test variants
├── prompt-winners.json       # Promoted prompt improvements
└── prompt-archive.jsonl      # Retired prompt versions
```

## Manual Optimization

### Optimize a Specific Skill's Prompts
```
optimize prompt for blurb-writer
```
Analyzes all historical uses of the blurb-writer skill and suggests improvements.

### Test a Prompt Variation
```
test prompt: "Write a blurb for {{description}} using the hook-mystery-stakes formula"
```
Runs the variation alongside the current prompt and compares results.

### View Prompt Performance
```
prompt stats
```
Shows prompt win rates, A/B test status, and optimization suggestions.

### Force a Prompt Update
```
update prompt for [skill]: [new prompt text]
```
Manually override a skill's prompt template.

## Integration

- **Self-Improvement Loop** — Prompt changes are logged as lessons
- **After-Action Review** — Reviews identify which prompts contributed to good/bad outcomes
- **Goal Engine** — Dynamic planning prompts are optimized too (not just skill prompts)
- **All AI Providers** — Different providers may need different prompt styles (tracked separately)

## Commands
- `optimize prompt for [skill]` — Analyze and suggest improvements for a skill's prompts
- `prompt stats` — View performance metrics across all prompts
- `prompt lab` — Enter interactive prompt testing mode
- `test prompt [text]` — A/B test a prompt variation
- `show prompt winners` — See which optimizations have been promoted
- `prompt history [skill]` — View prompt evolution for a specific skill
