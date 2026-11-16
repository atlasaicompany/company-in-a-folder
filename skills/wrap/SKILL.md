---
name: wrap
description: End-of-session record ritual. Finds everything this session changed (files, decisions, commits, things the owner still owes), then updates ~/company/NOW.md and LOG.md, saves lasting facts to memory, commits the work, and ends with a short "Recorded" checklist. Use when the owner says wrap, /wrap, wrap up, log everything, save what we did, we're done, that's it for today, or I'm going. Also use it unasked before ending a session that changed something real.
---

# /wrap: record what this session did

Why: the owner works across many sessions and tools. Anything not written down is lost, or redone wrong. The next session must be able to start from the files alone.

**Only the main session wraps.** A subagent lists its changes in its report and lets the head record them.

## 1. Find what changed
- **Main source: this conversation.** List every change: files created or edited, commits, decisions the owner made, drafts written, things that wait on the owner, dates mentioned.
- **Cross-check:** run `git status --short` and `git log --oneline -5` in each repo you touched. Changes you didn't make belong to another session: don't record or commit them.
- Nothing changed? Say "Nothing to record." and stop.

## 2. Record
| What changed | Where it goes |
|---|---|
| Anything done | `~/company/LOG.md`: a new entry at the top |
| Open to-dos, dates, things waiting on the owner | `~/company/NOW.md` |
| A decision, a preference, a lasting fact | a memory file + its line in `memory/MEMORY.md` |
| Code | a commit in that repo (only your files) |

**LOG.md entry** (newest first, right under the header):
```
## YYYY-MM-DD (Day, part of day): short title
- What happened, in plain words.
- **Files:** exact paths.
- Undo: how to reverse it.
```

**NOW.md:**
- Tick finished items: `- [x] ~~old text~~ **what happened (date)**`, and move long-finished ones out to LOG.md.
- Add new to-dos with dates in the right section. Anything waiting on the owner goes under **Your call** with the direct link.
- Refresh the `> Updated YYYY-MM-DD` line at the top.

**Memory:** one file per fact (see `memory/README.md`). Update an existing file before creating a new one. Save only what a future session needs and can't get from the files or git history.

**Commit:** `git add <your files>` (never `git add -A` in a shared folder), a message that says what and why.

## 3. Never
- Put passwords, keys, card, bank or ID numbers into NOW, LOG or memory.
- Delete anything in the company folder: move it to `_archive/` and log the move.

## 4. Finish with the checklist
```
Recorded:
- LOG.md: <title>
- NOW.md: +2 to-dos, 1 ticked, 1 under Your call
- memory: <file> (new|updated)
- commit: <repo> <short hash> <message>
Still open: <one line, or "nothing">
```
