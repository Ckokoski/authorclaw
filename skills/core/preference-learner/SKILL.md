---
name: preference-learner
description: Track and learn user preferences for writing style, communication, and workflow
triggers:
  - my preferences
  - remember that I
  - I prefer
  - I like
  - I don't like
  - I always want
  - I never want
  - update preferences
  - show preferences
  - preference
permissions:
  - memory_read
  - memory_write
---

# Preference Learner

Track user preferences across writing habits, communication style, and working patterns.

## How Preferences Are Learned

1. **Explicit statements** (highest priority):
   - "I prefer first person POV"
   - "I never want adverbs"
   - "I always want short chapters"

2. **Observed patterns**:
   - User consistently shortens chapters → learn "short chapters preferred"
   - User always removes dialogue tags → learn "minimal dialogue tags"

3. **Author-specific categories**:
   - Writing: POV, tense, chapter length, dialogue style, profanity level, romance heat, violence level
   - Genre: primary genre, subgenres, target audience, comp titles
   - Publishing: platform (KDP, trad, hybrid), word count targets
   - Workflow: session length, daily word goal, preferred feedback style

## Conflict Resolution

- Explicit beats inferred
- Recent beats old
- Specific beats general
- If conflicting, ask the user

## Commands

- `show my preferences` — Display all tracked preferences
- `update preference <key> <value>` — Set a preference explicitly
- `forget preference <key>` — Remove a preference
- `reset preferences` — Clear all preferences
