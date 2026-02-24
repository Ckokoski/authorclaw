---
name: preference-learner
description: Tracks user preferences, writing habits, and communication style to personalize every interaction
author: Writing Secrets
version: 1.0.0
triggers:
  - "my preferences"
  - "remember that I"
  - "I prefer"
  - "I like"
  - "I don't like"
  - "I always want"
  - "I never want"
  - "update preferences"
  - "show preferences"
  - "preference"
permissions:
  - file:read
  - file:write
---

# Preference Learner — Core Skill

Every author is different. This skill builds a living profile of the user's preferences, habits, and working style — then applies it to every interaction so AuthorClaw feels increasingly personalized.

## What Gets Learned

### Writing Preferences
```yaml
writing:
  # Detected from user revisions and feedback
  dialogue_tags: "simple (said/asked only)"
  description_density: "moderate (1-2 sensory details per scene)"
  paragraph_length: "short (2-4 sentences)"
  chapter_length: "2500-3500 words"
  pov_preference: "third person limited"
  tense: "past"
  profanity_level: "mild"
  romance_heat_level: "closed door"
  violence_level: "moderate"
  humor_style: "dry, situational"

  # Specific dos and don'ts
  always:
    - "Start chapters with action or dialogue, never description"
    - "End chapters on a hook or question"
    - "Use Oxford comma"
  never:
    - "Use adverbs in dialogue tags (said softly, whispered quietly)"
    - "Start sentences with 'Suddenly'"
    - "Use the word 'whilst'"
```

### Communication Preferences
```yaml
communication:
  response_length: "concise (under 200 words unless writing prose)"
  status_update_frequency: "after each major step"
  question_threshold: "only ask if truly ambiguous (err on acting)"
  emoji_usage: "moderate"
  formality: "casual, friendly"
  explanation_depth: "brief unless asked for detail"
  preferred_channel: "telegram"
```

### Working Style
```yaml
workflow:
  active_hours: "6am-10pm"
  most_productive_time: "morning (6am-noon)"
  session_length: "30-60 minutes"
  break_reminders: true
  daily_word_goal: 2000
  preferred_goal_size: "medium (5-8 steps)"
  review_preference: "review after each chapter, not after each scene"
  file_organization: "by project, then by chapter"
  naming_convention: "chapter-01-title.md"
```

### Genre & Market Preferences
```yaml
market:
  primary_genre: "psychological thriller"
  subgenres: ["domestic suspense", "unreliable narrator"]
  target_audience: "women 25-45, fans of Gillian Flynn"
  publishing_path: "traditional (querying agents)"
  comp_titles: ["The Wife Between Us", "The Last Thing He Told Me"]
  word_count_target: 80000
  series_vs_standalone: "standalone with series potential"
```

### Tool & Provider Preferences
```yaml
tools:
  preferred_ai_for_planning: "gemini (free, fast)"
  preferred_ai_for_writing: "claude (best prose)"
  preferred_ai_for_research: "gemini (good enough, free)"
  outline_format: "chapter-by-chapter with beat notes"
  export_format: "docx for submissions, epub for beta readers"
  research_depth: "thorough with citations"
```

## How Preferences Are Learned

### Explicit Statements (Highest Priority)
The user directly tells AuthorClaw their preferences:
- "I prefer short chapters"
- "Never use adverbs"
- "Always use Oxford comma"
- "I like when you explain your reasoning"

These are immediately stored with maximum confidence.

### Behavioral Observation (High Priority)
Patterns detected from user actions:
- User consistently shortens AI-generated paragraphs → prefers concise prose
- User always edits "suddenly" out of text → add to "never" list
- User responds faster to short messages → prefers concise communication
- User creates goals in the morning → morning is productive time

### Revision Analysis (Medium Priority)
When the user edits AI output:
- What did they change? (specific words, structure, tone?)
- What did they keep? (these approaches work)
- How much did they change? (major rewrite = wrong approach, minor tweaks = close)

### Feedback Integration (High Priority)
When the user rates output or gives feedback:
- "This is great!" → reinforce current approach
- "Too wordy" → reduce verbosity for this task type
- "I love this character voice" → save as reference for voice matching

## Preference Profile Storage

Stored as YAML at `workspace/memory/user-preferences.yaml`:
- Human-readable (the user can edit it directly)
- Machine-parseable (AuthorClaw loads it into context)
- Versioned (changes are logged with timestamps)

## Applying Preferences

Before each interaction, AuthorClaw:
1. Loads the preference profile
2. Selects relevant preferences for the current task type
3. Injects them into the system prompt as constraints
4. After the interaction, checks if any new preferences were detected

### Example System Prompt Injection
```
## User Preferences (Follow These)
- Writing: simple dialogue tags only, short paragraphs, no adverbs
- Style: past tense, third person limited, moderate description
- Communication: keep responses under 200 words, casual tone
- Never: use "suddenly", "whilst", adverbs in dialogue tags
- Always: Oxford comma, end chapters on hooks, start with action
```

## Conflict Resolution

When preferences conflict:
1. **Explicit always beats implicit** — "I like short chapters" overrides observed behavior
2. **Recent beats old** — Preferences from this week override preferences from last month
3. **Specific beats general** — "For this project, use present tense" overrides general "past tense" preference
4. **Ask when genuinely ambiguous** — If two explicit preferences conflict, ask the user

## Viewing & Editing Preferences

```
show my preferences
```
Displays the full preference profile in a readable format.

```
update preference: chapter_length = 4000-5000
```
Manually update a specific preference.

```
forget preference: dialogue_tags
```
Remove a learned preference (reset to default behavior).

```
preference history
```
Show when and why each preference was learned.

```
export preferences
```
Save preferences as a portable file (useful if switching projects or reinstalling).

## Project-Specific Preferences

Some preferences are per-project, not global:
- POV might change between a thriller (3rd limited) and a literary novel (1st person)
- Tone might shift between projects
- Word count targets vary by genre

AuthorClaw maintains both:
- **Global preferences** — apply everywhere (communication style, formatting, dos/don'ts)
- **Project preferences** — apply only within a specific project (POV, tense, tone, genre)

## Integration

- **Self-Improvement Loop** — Preference changes are logged as lessons
- **Voice Profile** — Writing preferences feed into the Soul system's voice matching
- **Goal Engine** — Task routing considers provider preferences
- **Heartbeat** — Working hours and session preferences inform autonomous scheduling

## Commands
- `show my preferences` — View full preference profile
- `I prefer [X]` — Explicitly set a preference
- `I never want [X]` — Add to the "never" list
- `I always want [X]` — Add to the "always" list
- `update preference [key] = [value]` — Update a specific preference
- `forget preference [key]` — Remove a learned preference
- `preference history` — Show learning timeline
- `export preferences` — Export as portable file
- `import preferences [file]` — Import from another project
