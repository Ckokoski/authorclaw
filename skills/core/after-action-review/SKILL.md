---
name: after-action-review
description: Structured post-goal reflection that extracts lessons, evaluates quality, and feeds the self-improvement loop
author: Writing Secrets
version: 1.0.0
triggers:
  - "after action review"
  - "review goal"
  - "post mortem"
  - "what went well"
  - "what went wrong"
  - "retrospective"
  - "goal review"
  - "debrief"
permissions:
  - file:read
  - file:write
---

# After-Action Review — Core Skill

A structured reflection process that runs after every completed goal. Extracts concrete lessons, evaluates output quality, identifies what worked and what didn't, and feeds everything into the self-improvement loop.

## When It Runs

- **Automatically** after any goal completes (all steps done)
- **On request** when the user says "review goal" or "what went well"
- **Periodically** as part of a weekly self-assessment (if autonomous mode is enabled)

## The Review Process

### Step 1: Gather Context

Collect all relevant data about the completed goal:
- Goal title, type, description
- Number of steps planned vs. actually executed
- Time taken per step and total
- AI providers used and their costs
- Which skills were triggered
- Any errors or retries that occurred
- User feedback received during execution

### Step 2: Quality Assessment

Rate the overall output on 5 dimensions:

```
After-Action Review: "Plan my time travel novel"
═══════════════════════════════════════════════════

Quality Assessment:
┌─────────────────────────────────┬───────┐
│ Completeness                    │ 9/10  │
│ Did we accomplish the goal?     │       │
├─────────────────────────────────┼───────┤
│ Quality                         │ 7/10  │
│ How good was the output?        │       │
├─────────────────────────────────┼───────┤
│ Efficiency                      │ 6/10  │
│ Did we use resources well?      │       │
├─────────────────────────────────┼───────┤
│ User Satisfaction               │ ?/10  │
│ (Awaiting user rating)          │       │
├─────────────────────────────────┼───────┤
│ Reusability                     │ 8/10  │
│ Can this approach work again?   │       │
└─────────────────────────────────┴───────┘

Overall Score: 7.5/10
```

### Step 3: What Went Well

Identify and document successes:
```
✅ WHAT WENT WELL
─────────────────
1. Dynamic AI planning produced a coherent 7-step plan
   → The AI planner correctly identified this as a "planning" goal
   → Steps were logically ordered (premise → characters → world → outline)

2. Gemini handled planning steps efficiently at zero cost
   → All 4 planning steps used free-tier Gemini
   → Quality was sufficient for brainstorming/outlining

3. Character profiles were detailed and interconnected
   → AI naturally created relationships between characters
   → Motivations tied directly to the central conflict

4. User accepted the outline without major revisions
   → Strong signal that the structure was sound
```

### Step 4: What Needs Improvement

Identify failures, inefficiencies, and areas for growth:
```
⚠️ WHAT NEEDS IMPROVEMENT
──────────────────────────
1. World-building step was too generic
   → Setting description lacked sensory specificity
   → Lesson: Add "include 3+ sensory details per location" to world-building prompts

2. Step 5 (review) was redundant with step 4 (outline)
   → Could have been combined into a single step
   → Lesson: For planning goals, combine review into the outline step

3. Total execution time: 8 minutes for 7 steps
   → Steps 2 and 3 could have run in parallel
   → Lesson: Character and world-building don't depend on each other — parallelize

4. Cost: $0.00 (all Gemini free tier)
   → Good for planning, but creative writing would need a better model
   → Lesson: Use Gemini for planning, switch to Claude/DeepSeek for prose
```

### Step 5: Extract Lessons

Convert observations into structured lessons for the improvement log:

```json
[
  {
    "category": "worldbuild",
    "lesson": "Always include 3+ sensory details (sight, sound, smell, touch, taste) per location description",
    "confidence": 0.75,
    "source": "after_action_review"
  },
  {
    "category": "task_execution",
    "lesson": "For planning goals, character profiles and world-building can run in parallel (no dependency)",
    "confidence": 0.8,
    "source": "after_action_review"
  },
  {
    "category": "task_execution",
    "lesson": "Combine 'review and refine' into the preceding step for planning goals to reduce redundancy",
    "confidence": 0.7,
    "source": "after_action_review"
  },
  {
    "category": "task_execution",
    "lesson": "Use Gemini free tier for planning/outlining tasks. Reserve Claude/DeepSeek for creative prose.",
    "confidence": 0.85,
    "source": "after_action_review"
  }
]
```

### Step 6: User Feedback Request

Ask the user for their assessment:
```
📋 Goal Complete: "Plan my time travel novel"

I've completed my self-review. Quick questions:

1. Overall, how would you rate the output? (1-10)
2. What specifically did you like most?
3. What would you change for next time?

(Or just say "looks good" and I'll note that as positive feedback!)
```

## Review Storage

Reviews are saved to `workspace/memory/reviews/`:
```
workspace/memory/reviews/
├── 2026-02-24-plan-time-travel-novel.md
├── 2026-02-24-research-medieval-weapons.md
└── 2026-02-25-write-chapter-1.md
```

Each review file contains the full structured assessment in Markdown format, readable by both humans and the AI.

## Aggregate Reviews

Over time, reviews accumulate into patterns:

```
review performance this week
```

Shows:
- Goals completed: 5
- Average quality score: 7.8/10
- Most common improvement area: "Prose specificity"
- Lessons extracted: 12 (8 high confidence)
- User satisfaction trend: Improving ↑

## Integration with Self-Improvement

The After-Action Review feeds directly into the self-improvement loop:
1. Lessons extracted here are written to `improvement-log.jsonl`
2. Next time a similar goal runs, those lessons are injected into context
3. The review itself checks whether previous lessons were applied
4. Creates a measurable improvement trajectory over time

## Commands
- `after action review` — Run a review on the most recently completed goal
- `review goal [id]` — Review a specific goal
- `review performance` — Aggregate performance metrics
- `what went well` — Quick summary of recent successes
- `what went wrong` — Quick summary of recent failures
- `rate last goal [1-10]` — Provide a user rating for the last goal
