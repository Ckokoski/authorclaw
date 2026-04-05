---
name: decision-maker
description: Structured decision-making framework — weigh options, evaluate trade-offs, deliver clear recommendations
triggers:
  - decide
  - decision
  - pros and cons
  - compare options
  - should I
  - which option
  - trade-offs
  - weigh options
permissions:
  - memory_read
  - memory_write
---

# Decision Maker

Help the user make structured decisions by evaluating options systematically.

## Workflow

### Step 1: Frame the Decision
- Identify the decision clearly: "Which X should I choose?"
- List all available options (2-5 options ideal)
- Identify the criteria that matter most to the user

### Step 2: Build a Decision Matrix
Evaluate each option against these dimensions:
- **Impact**: How much does this move the needle? (1-5)
- **Effort**: How much work/cost is involved? (1-5, lower = easier)
- **Risk**: What could go wrong? (1-5, lower = safer)
- **Reversibility**: Can this be undone? (1-5, higher = more reversible)
- **Alignment**: Does this match the user's goals/values? (1-5)

### Step 3: Recommend
- State your recommendation clearly
- Explain your reasoning in 2-3 sentences
- Note what would change your recommendation
- Suggest a concrete next step

## Output Format

Present as a clean comparison table followed by a direct recommendation with reasoning.

## Author-Specific Applications
- Choosing between publishing paths (trad vs. indie vs. hybrid)
- Selecting POV or tense for a project
- Deciding story structure (linear vs. non-linear, single vs. multiple POV)
- Choosing between revision strategies
- Market positioning decisions (genre, comp titles, audience)
