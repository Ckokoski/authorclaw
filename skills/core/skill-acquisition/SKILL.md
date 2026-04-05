---
name: skill-acquisition
description: Research topics and create new skills for AuthorClaw to learn
triggers:
  - learn how to
  - add a skill for
  - find a tool for
  - go learn
  - research and create a skill
  - teach yourself
  - acquire skill
  - learn about
permissions:
  - memory_read
  - memory_write
  - research_access
---

# Skill Acquisition

AuthorClaw's self-learning module. Research topics, draft new SKILL.md files,
and present them for user review before saving.

## Workflow

### Step 1: Understand the Request
- Parse: What topic? What category (core/author/marketing/ops)?
- Assess: Is this genuinely new or does an existing skill cover it?

### Step 2: Research
- Use the Research Gate to gather information from allowlisted domains
- Maximum 5 web fetches per skill acquisition session
- Focus on: best practices, common patterns, expert techniques

### Step 3: Draft the SKILL.md
Create a properly formatted skill file with:
- Valid YAML frontmatter (name, description, triggers, permissions)
- Clear instructions and workflow steps
- Author-specific applications where relevant
- At least 3 unique trigger phrases

### Step 4: Present for Review
- Show the full draft to the user
- NEVER auto-save — always wait for user approval
- Accept feedback and revise if needed

### Step 5: Save
- Write file to `skills/{category}/{skill-name}/SKILL.md`
- Verify YAML parsing succeeds
- Confirm trigger uniqueness (no collisions with existing skills)

## Guardrails
- Research only from allowlisted domains
- No verbatim copying of source material
- No skills that bypass security controls
- Always present draft before saving
- Log all skill acquisitions in the audit trail
