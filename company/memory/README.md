# How the company remembers

Claude forgets everything between sessions. This folder is what it remembers. It is plain Markdown, so you can read, edit and back it up like any other file.

## The two parts
- **`MEMORY.md`**: the index. One line per memory: a link and a short hook. It is loaded into every session (through the `@` line in your `CLAUDE.md`), so keep it short: under about 150 lines. Every line costs context in every session.
- **One file per memory**: the fact itself, with a little frontmatter.

## A memory file
```markdown
---
name: prefers-short-answers
description: Owner wants verdict-first answers, 10 lines max, no jargon
type: feedback
---
Answers start with the verdict; summaries stay under 10 short lines.
**Why:** long answers get skimmed and the key line is missed (owner, 2026-03-02).
**How to apply:** first line = the answer or what was done; details only if asked.
Related: [[ship-small-pieces]]
```

## Four types
| Type | What goes in | Example |
|---|---|---|
| `user` | who the owner is: role, skills, constraints | "Works 10 h a week on the company; day job until 6 pm" |
| `feedback` | how to work: corrections and confirmed approaches, with **Why** | "Never email customers on Sundays" |
| `project` | ongoing work, goals, deadlines not visible in the files | "Launch target: 1 April; price $29" |
| `reference` | pointers to outside things | "Analytics dashboard: <link>" |

## Rules
- **One fact per file.** Update an existing file before creating a new one.
- **Dates are absolute** ("2026-03-02", never "yesterday").
- **Link related memories** with `[[their-name]]`. A link to a memory that doesn't exist yet is fine: it marks something worth writing.
- **Don't save** what the files or git history already say (code structure, past fixes). Save what's non-obvious.
- **Never save** passwords, API keys, card, bank or ID numbers, or recovery codes.
- **Prune** monthly (or ask `mnemosyne`): merge duplicates, fix stale facts, move dead ones to `_archive/`. Never delete.
- When a memory turns out wrong, fix it the same day and say so in LOG.md.
