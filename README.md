# Company in a Folder · free starter

Run a one-person company from Claude Code: a head that plans and keeps records, departments that do the work, and a memory that lasts between sessions. Plain Markdown you can read and change. Works with Claude Code, Anthropic's coding tool, on Windows, macOS and Linux.

This is the starter: the constitution, 3 departments, 2 skills, the memory format and the guard-rail hook. It's complete on its own.

## What's inside
```
company/          → copy to ~/company/
  HEAD.md         the constitution: how the head talks, sizes work, and what needs your yes
  NOW.md  LOG.md  what's on, what happened (newest first, with how to undo)
  memory/         MEMORY.md (the index, loaded every session) + one file per fact
agents/           → copy to ~/.claude/agents/
  athena.md       research with sources: every claim labelled FACT / EST / UNVERIFIED
  hephaestus.md   builds on a branch, tests first, never pushes to main or deploys
  argus.md        read-only review that runs the tests itself
skills/           → copy to ~/.claude/skills/
  wrap/           /wrap: record the session into NOW, LOG and memory, then commit
  decode/         /decode: a long messy message becomes a table, nothing dropped
hooks/            → copy to ~/.claude/hooks/solo-company/
  guard.mjs       STOP-file kill switch, blocks wipe-the-disk commands and force-push to main,
                  asks before risky ones, blocks live secrets from being written, audit log
```

## Install (5 minutes, by hand)
1. Copy the folders as shown above (`company/` to `~/company/`, and so on).
2. Add two lines at the top of `~/.claude/CLAUDE.md` (create it if needed):
   ```
   @~/company/HEAD.md
   @~/company/memory/MEMORY.md
   ```
3. Optional, the guard-rail hook (needs Node.js 18+): add the `hooks` block from `hooks/SETTINGS_SNIPPET.md` to `~/.claude/settings.json`. Back the file up first.
4. Restart Claude Code. Type `/decode` with your to-do list, or tell it three lines about yourself and let it write your first memories.

## The habits that make it work
- **Verdict first.** The head answers in the first line; summaries stay under 10 lines.
- **Size before doing.** Level 0-3; big or risky work gets an independent review.
- **Only four things need your yes:** spending, sending from your accounts, publishing, deleting real data. Everything else: done, then verified.
- **Nothing lives only in a chat.** `/wrap` before you close the terminal.
- **Keep the memory index short.** It loads in every session; under ~150 lines.

## The Full kit
The Full kit adds 5 more departments (sales copy, design, records, rules, money), 4 more skills (/brief, /ship, /request, /weekly), spend requests, the test suite for every guard rule, a secret-scanning pre-commit hook, a one-command installer with dry-run and uninstall, a `doctor` check for after updates, the Operator Guide and a worked example company. $29: see the link in this repo's description.

It's part of a public experiment: Atlas, the AI chief of staff this setup comes from, is trying to earn its first $1,000 in 30 days (16 Nov to 15 Dec 2026), with every number shown.

---
MIT licence (this starter only). Claude and Claude Code are trademarks of Anthropic, PBC. Company in a Folder is an independent project and is not made, endorsed or sponsored by Anthropic.
