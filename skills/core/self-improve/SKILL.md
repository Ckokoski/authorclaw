---
name: self-improve
description: Continuous self-improvement loop — AuthorClaw learns from mistakes, successes, and user feedback to get better over time
author: Writing Secrets
version: 1.0.0
triggers:
  - "self improve"
  - "improve yourself"
  - "learn from"
  - "what did you learn"
  - "improvement log"
  - "get better"
  - "lessons learned"
  - "self reflection"
  - "review performance"
permissions:
  - file:read
  - file:write
---

# Self-Improvement Loop — Core Skill

AuthorClaw gets better every time it works. This skill creates a persistent learning loop where the agent tracks what works, what fails, and what the user prefers — then applies those lessons to future tasks.

## How It Works

### The Loop

```
  ┌─────────────────────────────┐
  │                             │
  │    1. DO THE WORK           │
  │    (goal step, writing,     │
  │     research, etc.)         │
  │                             │
  └──────────┬──────────────────┘
             │
             ▼
  ┌─────────────────────────────┐
  │                             │
  │    2. OBSERVE RESULT        │
  │    Did the user accept it?  │
  │    Did they revise it?      │
  │    Did it trigger an error? │
  │    How long did it take?    │
  │                             │
  └──────────┬──────────────────┘
             │
             ▼
  ┌─────────────────────────────┐
  │                             │
  │    3. EXTRACT LESSON        │
  │    What specifically        │
  │    went right or wrong?     │
  │    What pattern emerges?    │
  │                             │
  └──────────┬──────────────────┘
             │
             ▼
  ┌─────────────────────────────┐
  │                             │
  │    4. STORE LESSON          │
  │    Write to learning log    │
  │    (workspace/memory/       │
  │     improvement-log.jsonl)  │
  │                             │
  └──────────┬──────────────────┘
             │
             ▼
  ┌─────────────────────────────┐
  │                             │
  │    5. APPLY LESSONS         │
  │    Before each new task,    │
  │    check the log for        │
  │    relevant lessons and     │
  │    adjust behavior          │
  │                             │
  └──────────┬──────────────────┘
             │
             └──────── back to step 1
```

### What Gets Tracked

Every lesson entry in `improvement-log.jsonl` contains:

```json
{
  "id": "lesson-042",
  "timestamp": "2026-02-24T14:30:00Z",
  "category": "writing",
  "trigger": "user_revision",
  "context": "Chapter 3 of thriller project",
  "observation": "User rewrote all dialogue tags from creative tags to simple said/asked",
  "lesson": "This user strongly prefers invisible dialogue tags (said/asked). Do not use creative tags like 'exclaimed', 'muttered', 'hissed' unless the user specifically asks.",
  "confidence": 0.9,
  "applied_count": 0,
  "source": "user_feedback"
}
```

### Categories of Learning

#### Writing Quality
- Which prose styles the user accepts vs. revises
- Preferred sentence length, paragraph structure
- Dialogue conventions (tags, beats, subtext level)
- Description density (sparse vs. lush)
- Pacing preferences per genre/chapter type

#### Task Execution
- Which AI providers give best results for which task types
- Optimal temperature settings per task
- How many steps different goal types actually need
- Which skills produce the best outputs
- Time estimates that were accurate vs. wildly off

#### Research Quality
- Which sources the user found most useful
- Research depth preferences (quick overview vs. deep dive)
- Citation style preferences
- How much context to include in research summaries

#### User Communication
- Preferred response length (concise vs. detailed)
- How the user likes to receive status updates
- When to ask for clarification vs. make a decision
- Vocabulary and terminology preferences

#### Error Patterns
- Common failure modes and their fixes
- API errors and successful workarounds
- Prompt formulations that reliably fail
- Context length issues and mitigation strategies

### Lesson Sources

1. **User Revision** (highest signal) — User edited or rewrote AI output
   - Compare original vs. user version
   - Extract the specific changes as preferences
   - Confidence: HIGH

2. **User Feedback** — User explicitly says "I liked X" or "Don't do Y"
   - Direct instruction → immediate high-confidence lesson
   - Confidence: VERY HIGH

3. **Acceptance Pattern** — User accepted output without changes
   - Reinforces that the approach worked
   - Confidence: MEDIUM (absence of feedback isn't always approval)

4. **Error Recovery** — Something failed and was fixed
   - The fix becomes a lesson for next time
   - Confidence: HIGH

5. **Self-Critique** — Agent reviews its own output and spots issues
   - Lower confidence but still valuable
   - Confidence: LOW-MEDIUM

6. **After-Action Review** — Post-goal structured reflection
   - Comprehensive lessons from completed goals
   - Confidence: MEDIUM-HIGH

## Applying Lessons

Before each task, AuthorClaw should:

1. **Load relevant lessons** from the improvement log
2. **Filter by category** matching the current task type
3. **Sort by confidence** and recency
4. **Inject top lessons** into the system prompt as behavioral rules

Example injection:
```
## Lessons Learned (Apply These)
- This user prefers invisible dialogue tags (said/asked). Confidence: 0.9
- For thriller pacing, keep chapters under 3000 words. Confidence: 0.85
- When researching, include at least 3 specific sources. Confidence: 0.7
- Use Gemini for planning tasks (faster, good enough). Confidence: 0.8
```

## Lesson Decay

Lessons aren't permanent:
- **Confidence increases** each time a lesson is applied and the output is accepted
- **Confidence decreases** if a lesson is applied and the user revises the output
- **Lessons below 0.3 confidence** are archived (moved to `improvement-archive.jsonl`)
- **User can explicitly override** any lesson ("Actually, I DO want creative dialogue tags now")

## Viewing the Improvement Log

```
show improvement log
```
Displays a human-readable summary of all active lessons, grouped by category.

```
what did you learn from [project/goal]
```
Shows lessons extracted from a specific project or goal.

```
clear lesson [id]
```
Remove a specific lesson that's no longer relevant.

```
improvement stats
```
Shows: total lessons, lessons applied today, confidence distribution, top categories.

## Commands
- `self improve` — Run a self-reflection on recent interactions
- `show improvement log` — View all active lessons
- `what did you learn` — Summary of recent learnings
- `clear lesson [id]` — Remove a specific lesson
- `improvement stats` — Metrics on the learning system
- `apply lessons to [task]` — Manually trigger lesson lookup for a task
