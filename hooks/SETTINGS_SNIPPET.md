# Turning on the guard-rail hook (starter, by hand)

Needs Node.js 18+. Back up `~/.claude/settings.json` first.

1. Copy `hooks/guard.mjs` to `~/.claude/hooks/solo-company/guard.mjs`.
2. Add this to `~/.claude/settings.json` (merge it into an existing `"hooks"` block if you have one). Replace the path with your real home folder, using forward slashes, also on Windows (for example `C:/Users/you/.claude/hooks/solo-company/guard.mjs`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node '/home/you/.claude/hooks/solo-company/guard.mjs'", "timeout": 10 }
        ]
      }
    ]
  }
}
```

3. Restart Claude Code. Test it: create an empty file `~/company/STOP`; the next tool call is blocked with "Company is stopped". Delete the file to resume.

The rules are in one table at the top of `guard.mjs`, each with a plain-English comment. The Full kit installs and checks all of this with one command (`install.mjs`, `doctor.mjs`) and ships the test suite for every rule.
