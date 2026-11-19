# Company in a Folder · free starter

Run a one-person company from Claude Code: a head that plans and keeps records, departments that do the work, and a memory that lasts between sessions. Plain Markdown you can read and change. Works with Claude Code, Anthropic's coding tool, on Windows, macOS and Linux.

**Website:** https://companyinafolder.com

This is the starter: the constitution, 3 departments, 3 skills, the memory format and the guard-rail hook. It's complete on its own.

**Already installed [Agency Agents](https://github.com/msitarzewski/agency-agents) or your own agents?** Keep them: give them a company to work in. `/roster` counts every agent in `~/.claude/agents` and your project, says when they look like the Agency Agents pack, and finds the best few for a task without loading hundreds of files into the session. Agency Agents is a separate MIT-licensed project; nothing from it is in this repo.

## What's inside
```
company/          → goes to ~/company/
  HEAD.md         the constitution: how the head talks, sizes work, and what needs your yes
  NOW.md  LOG.md  what's on, what happened (newest first, with how to undo)
  memory/         MEMORY.md (the index, loaded every session) + one file per fact
agents/           → goes to ~/.claude/agents/
  athena.md       research with sources: every claim labelled FACT / EST / UNVERIFIED
  hephaestus.md   builds on a branch, tests first, never pushes to main or deploys
  argus.md        read-only review that runs the tests itself
skills/           → goes to ~/.claude/skills/
  wrap/           /wrap: record the session into NOW, LOG and memory, then commit
  decode/         /decode: a long messy message becomes a table, nothing dropped
  roster/         /roster: every agent you have installed, counted, and the best few for a task
hooks/            → goes to ~/.claude/hooks/solo-company/
  guard.mjs       STOP-file kill switch, blocks wipe-the-disk commands and force-push to main,
                  asks before risky ones, blocks live secrets from being written, audit log
```

## Install (5 minutes)
Download this repo (green **Code** button → **Download ZIP**, or `git clone`), open a terminal inside the folder, and paste the block for your system. The last line adds the two lines that load the company into every session.

**macOS, Linux, Git Bash:**
```bash
mkdir -p ~/company ~/.claude/agents ~/.claude/skills ~/.claude/hooks/solo-company
cp -R company/. ~/company/
cp agents/*.md ~/.claude/agents/
cp -R skills/. ~/.claude/skills/
cp hooks/guard.mjs ~/.claude/hooks/solo-company/
printf '@~/company/HEAD.md\n@~/company/memory/MEMORY.md\n' >> ~/.claude/CLAUDE.md
```

**Windows PowerShell:**
```powershell
New-Item -ItemType Directory -Force "$HOME\company", "$HOME\.claude\agents", "$HOME\.claude\skills", "$HOME\.claude\hooks\solo-company" | Out-Null
Copy-Item company\* "$HOME\company" -Recurse
Copy-Item agents\*.md "$HOME\.claude\agents"
Copy-Item skills\* "$HOME\.claude\skills" -Recurse
Copy-Item hooks\guard.mjs "$HOME\.claude\hooks\solo-company"
Add-Content "$HOME\.claude\CLAUDE.md" '@~/company/HEAD.md', '@~/company/memory/MEMORY.md'
```

These are for a first install: files with the same name are replaced. Already have a `~/company`, or agents called athena, hephaestus or argus? Copy by hand and keep yours.

Then:
1. **Restart Claude Code** (agents and skills load at start).
2. **Try it.** Type `/decode` and paste your whole messy to-do list. Or tell it three lines about yourself and let it write your first memories.
3. **Turn on the guard-rail hook** (optional, needs Node.js 18+): follow `hooks/SETTINGS_SNIPPET.md`. It's one block in `~/.claude/settings.json` and a 10-second test.

**It worked if:** `/decode` answers with a table of your asks, and Claude's answers start with the verdict.

**To remove it:** delete the two lines from `~/.claude/CLAUDE.md`, the three agent files, the three skill folders and `~/.claude/hooks/solo-company/` (plus the hook block in `settings.json` if you added it). Your `~/company` folder is yours to keep.

## The habits that make it work
- **Verdict first.** The head answers in the first line; summaries stay under 10 lines.
- **Size before doing.** Level 0-3; big or risky work gets an independent review.
- **Only four things need your yes:** spending, sending from your accounts, publishing, deleting real data. Everything else: done, then verified.
- **Nothing lives only in a chat.** `/wrap` before you close the terminal.
- **Keep the memory index short.** It loads in every session; under ~150 lines.

## The Full kit
The Full kit sets all of this up with one command, and adds:
- **5 more departments:** sales copy, design, records, rules, money.
- **5 more skills:** `/brief` (today on one screen), `/ship` (one-hour pieces), `/request` (spend requests you answer with one word), `/weekly` (the weekly review), and `/dispatch`: the head hands each piece of work to the best agent you have (a department or any of your installed specialists), puts the house rules in the brief, and checks the result against `HEAD.md` before moving on.
- **An installer** with dry-run, backups and a clean uninstall, and a **`doctor`** that checks everything still works after a Claude Code update.
- **250+ tests** for the guard, the installer and the doctor, and a **secret-scanning pre-commit hook**.
- **The Operator Guide** and a **worked example company** after its first week.

$29 at https://companyinafolder.com

Only need part of it? [Stack Starters](https://companyinafolder.gumroad.com/l/stack-starters) ($9) writes a ready `CLAUDE.md` for your stack in one command, and [Workflow Hooks](https://companyinafolder.gumroad.com/l/workflow-hooks) ($9) adds seven tested hooks that keep your coding agent on track.

It's part of a public experiment: Atlas, the AI chief of staff this setup comes from, is trying to earn its first $1,000 in 30 days (16 Nov to 15 Dec 2026), with every number shown.

---
MIT licence (this starter only). Claude and Claude Code are trademarks of Anthropic, PBC. Company in a Folder is an independent project and is not made, endorsed or sponsored by Anthropic.
