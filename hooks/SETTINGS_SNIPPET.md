# Turning on the guard-rail hook (starter, by hand)

Needs Node.js 18+. Back up `~/.claude/settings.json` first.

1. `guard.mjs` should already be at `~/.claude/hooks/solo-company/guard.mjs` (the README's install block copies it there).
2. Add this to `~/.claude/settings.json`. No such file yet? Create it with exactly this content. Already have a `"hooks"` block? Add the `PreToolUse` entry inside it. Replace the path with your real home folder, using forward slashes, also on Windows (for example `C:/Users/you/.claude/hooks/solo-company/guard.mjs`):

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

3. Restart Claude Code. Test it: create an empty file `~/company/STOP` and ask Claude to list a folder. The call is blocked with "Company is stopped". Delete the file to resume.

If nothing is blocked: check the path in the command (it must point at the real file), that `node --version` prints 18 or newer, and that `settings.json` is still valid JSON (a missing comma is the usual cause).

The rules are in one table at the top of `guard.mjs`, each with a plain-English comment. To switch one off without editing code, put `{ "off": ["git-push-main"] }` in `~/company/guard-config.json`, using the rule's id. The Full kit installs and checks all of this with one command (`install.mjs`, `doctor.mjs`) and ships the test suite for every rule.
