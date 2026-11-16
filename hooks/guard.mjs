#!/usr/bin/env node
// Company in a Folder: guard-rail hook for Claude Code (PreToolUse).
//
// Claude Code runs this script before every tool call. It reads one JSON
// object on stdin ({ tool_name, tool_input, cwd, ... }) and answers with:
//   - nothing at all            -> "no opinion": the normal permission flow runs
//   - {"hookSpecificOutput": {"hookEventName": "PreToolUse",
//      "permissionDecision": "ask" | "deny", "permissionDecisionReason": "..."}}
// It always exits with code 0 and never prints anything else to stdout.
//
// The rules live in the tables right below (SECRET_PATTERNS, RULES).
// Read them, edit them, or switch one off without editing code by listing
// its id in <company>/guard-config.json:   { "off": ["git-push-main"] }
// or soften a "deny" into an "ask":        { "ask": ["drop-database"] }
// The kill switch (the STOP file) cannot be switched off from the config.
//
// Node 18+, built-in modules only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Limits. The guard must always answer fast and never hang a session.
// ---------------------------------------------------------------------------
export const LIMITS = {
  watchdogMs: 2000,            // answer within 2 s no matter what
  scanWindow: 8 * 1024,        // each regex sees at most 8 KB of text at a time
  maxCommandScan: 8 * 1024,    // shell commands: only the first 8 KB is checked
  maxContentScan: 512 * 1024,  // file content: checked in 8 KB windows, up to 512 KB
  maxStdinBytes: 32 * 1024 * 1024,
  summaryChars: 160,           // length of the summary in the audit log
  gitTimeoutMs: 700,           // a git lookup (current branch, ignored file) gives up after this
};

// ---------------------------------------------------------------------------
// Secret patterns. Content matching one of these looks like a live key.
// Writing it into a file is denied (or asked, for decision: 'ask'), unless
// the file is a .env file that git ignores. The guard names the pattern; it
// never repeats the secret.
//   decision  'deny' (default) or 'ask'
//   allow     exact strings that match the pattern but are known to be safe
// Switch one pattern off in guard-config.json: { "offPatterns": ["google-api-key"] }
// ---------------------------------------------------------------------------
export const SECRET_PATTERNS = [
  // Anthropic API key
  { id: 'anthropic-key', name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  // OpenAI project key
  { id: 'openai-key', name: 'OpenAI API key', re: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  // Stripe live secret or restricted key (sk_live_..., rk_live_..., sk-live-...)
  { id: 'stripe-live-key', name: 'Stripe live key', re: /\b[sr]k[-_]live[-_][0-9A-Za-z]{10,}/ },
  // AWS access key id. The allow entry is the example key from AWS's own docs.
  { id: 'aws-access-key', name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/, allow: ['AKIA' + 'IOSFODNN7EXAMPLE'] },
  // GitHub classic tokens (personal, OAuth, user, server, refresh)
  { id: 'github-token', name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  // GitHub fine-grained personal access token
  { id: 'github-pat', name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  // Slack bot, user, app, refresh or legacy tokens
  { id: 'slack-token', name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  // PEM private key block (RSA, EC, OpenSSH, DSA, encrypted, or plain)
  { id: 'private-key', name: 'Private key', re: /-{5}BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-{5}/ },
  // Google API key. Only "ask": Firebase web keys look the same and are public by design.
  { id: 'google-api-key', name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/, decision: 'ask' },
];

// Folders where deleting is always fine (temp folders). Paths, not globs.
export const SAFE_DELETE_ROOTS = [os.tmpdir(), '/tmp', '/var/tmp'];

// ---------------------------------------------------------------------------
// Shell rules (Bash and PowerShell tools). Checked in this order; the
// strongest decision wins (deny > ask). Each rule has one or both of
//   pattern: a regex (or a list) tested against the command text with the
//            insides of quoted strings and heredocs blanked out, so text in
//            a commit message or grep pattern never counts as a command
//   match:   a function of the parsed command `c` (see parseCommand below):
//            c.raw        the command text (first 8 KB)
//            c.skeletons  the command text with quoted text blanked out
//            c.segments   every simple command found: { cmd, args }
//            c.deletes    every delete found: { target, danger }
//                         danger = 'root' | 'home' | 'project' | 'outside' | 'unknown'
//            c.git        every git call: { sub, args, cwd }
//            c.pushes     every git push: { main, force, del, mirror }
//            c.redirects  every file a `>` / `>>` writes to
//            c.pipeToShell, c.dbDrop, c.touchesGuardRails, c.secret: findings
// To add a rule, copy one and change it. To remove one, delete it or list its
// id under "off" in guard-config.json.
// ---------------------------------------------------------------------------
export const RULES = [
  // --- DENY: things that are almost never what you meant -------------------

  // rm -rf / Remove-Item -Recurse / rd /s on a drive root (/, C:\), your home
  // folder (~, $HOME, %USERPROFILE%) or a folder that contains your home.
  {
    id: 'delete-root-or-home', decision: 'deny',
    reason: 'Recursive delete of a drive root or your home folder.',
    match: (c) => c.deletes.some((d) => d.danger === 'root' || d.danger === 'home'),
  },
  // Formatting or wiping a disk: format C:, mkfs, diskpart, Format-Volume,
  // Clear-Disk, dd onto a raw disk device.
  {
    id: 'format-disk', decision: 'deny',
    reason: 'Formats or wipes a disk.',
    match: (c) => c.segments.some((s) =>
      s.cmd === 'mkfs' || s.cmd.startsWith('mkfs.') || s.cmd === 'diskpart' ||
      s.cmd === 'format-volume' || s.cmd === 'clear-disk' || s.cmd === 'initialize-disk' ||
      (s.cmd === 'format' && s.args.some((a) => /^[a-z]:\\?$/i.test(a) || a.startsWith('/dev/'))) ||
      (s.cmd === 'dd' && s.args.some((a) => /^of=\/dev\/(?:sd|hd|vd|xvd|nvme|disk|rdisk|mmcblk)/i.test(a)))),
  },
  // git push --force / -f / --force-with-lease / +refspec / --delete / --mirror
  // when it lands on main or master. Rewrites or deletes the shared history.
  {
    id: 'git-force-push-main', decision: 'deny',
    reason: 'Force-push (or delete) on main/master rewrites shared history.',
    match: (c) => c.pushes.some((p) => p.mirror || (p.main && (p.force || p.del))),
  },
  // Downloading a script and running it straight away: a real pipe from
  // curl/wget/iwr into sh/bash/zsh/iex, iex (irm ...), bash <(curl ...),
  // sh -c "$(curl ...)". Text inside quotes (a commit message, a grep
  // pattern) is never read as a command.
  {
    id: 'pipe-to-shell', decision: 'deny',
    reason: 'Downloads a script and runs it unseen. Download it to a file and read it first.',
    match: (c) => c.pipeToShell,
    pattern: [
      /\b(?:iex|invoke-expression)\b[\s(&]*(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget|new-object\s+(?:system\.)?net\.webclient)\b/i,
      /\b(?:ba|z|da|k)?sh\s+<\(\s*(?:curl|wget)\b/i,
    ],
  },
  // SQL that drops a whole database or schema, sent to a database client
  // (psql, mysql, sqlite3, sqlcmd, mongosh, supabase, prisma ...) as an
  // argument, through a pipe or through a heredoc. grep "DROP DATABASE" is fine.
  {
    id: 'drop-database', decision: 'deny',
    reason: 'Drops a whole database or schema.',
    match: (c) => c.dbDrop,
  },
  // Writing a .env file from the shell (echo KEY=... > .env, tee .env,
  // Set-Content .env). Edit .env files with the editor tools instead, so the
  // secret check can see them. .env.example / .sample / .template are fine.
  {
    id: 'env-file-shell-write', decision: 'deny',
    reason: 'Writes a .env file through the shell. Use the Write/Edit tool so the secret check can see it.',
    match: (c) => c.redirects.some(isEnvFile),
  },
  // A heredoc or redirect that writes something that looks like a live key.
  {
    id: 'secret-in-shell-write', decision: 'deny',
    reason: 'The command writes something that looks like a live secret into a file.',
    match: (c) => c.writesFile && c.secret !== null && secretDecision(c.secret) === 'deny',
  },

  // --- ASK: normal work, but worth a second look ---------------------------

  // Changing the guard-rails themselves: guard-config.json, the installed
  // hooks/solo-company/ files, or a Claude Code settings*.json file (where
  // hooks and permissions live). Applies to Write/Edit/MultiEdit and to shell
  // commands that name those files (reading them with cat/grep is fine).
  {
    id: 'guard-rails-change', decision: 'ask',
    reason: "This changes the company's guard-rails.",
    match: (c) => c.touchesGuardRails,
  },

  // git reset --hard throws away uncommitted work.
  {
    id: 'git-reset-hard', decision: 'ask',
    reason: 'git reset --hard throws away uncommitted changes.',
    match: (c) => c.git.some((g) => g.sub === 'reset' && g.args.includes('--hard')),
  },
  // git clean -f / -fd / -fdx deletes untracked files for good.
  {
    id: 'git-clean', decision: 'ask',
    reason: 'git clean deletes untracked files for good.',
    match: (c) => c.git.some((g) => g.sub === 'clean' &&
      g.args.some((a) => a === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))),
  },
  // A normal (non-force) git push to main or master.
  {
    id: 'git-push-main', decision: 'ask',
    reason: 'Pushes to main/master.',
    match: (c) => c.pushes.some((p) => p.main),
  },
  // Deleting a branch: git branch -d/-D, git push --delete, git push origin :name.
  {
    id: 'git-delete-branch', decision: 'ask',
    reason: 'Deletes a git branch.',
    match: (c) => c.pushes.some((p) => p.del) ||
      c.git.some((g) => g.sub === 'branch' &&
        g.args.some((a) => a === '--delete' || /^-[a-zA-Z]*[dD][a-zA-Z]*$/.test(a))),
  },
  // Recursive delete outside the current project (or of the whole project,
  // or of a path the guard cannot work out, like $SOME_VAR/build).
  {
    id: 'delete-outside-project', decision: 'ask',
    reason: 'Recursive delete outside the current project folder (or of the whole project).',
    match: (c) => c.deletes.some((d) => d.danger === 'outside' || d.danger === 'unknown' || d.danger === 'project'),
  },
  // Publishing a package to the npm registry.
  {
    id: 'npm-publish', decision: 'ask',
    reason: 'Publishes a package to the registry.',
    match: (c) => c.segments.some((s) => ['npm', 'pnpm', 'yarn', 'bun'].includes(s.cmd) && s.args.includes('publish')),
  },
  // Deploying to production on Vercel.
  {
    id: 'vercel-prod', decision: 'ask',
    reason: 'Deploys to production.',
    match: (c) => c.segments.some((s) => s.cmd === 'vercel' && s.args.some((a) => a === '--prod' || a === '--production' || a === '--prod=true')),
  },
];

// Database clients: SQL in their arguments, piped into them or fed to them by
// a heredoc is checked for DROP DATABASE / DROP SCHEMA.
export const DB_CLIENTS = ['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlite', 'sqlcmd', 'invoke-sqlcmd', 'osql', 'isql',
  'mongosh', 'mongo', 'supabase', 'prisma', 'clickhouse-client', 'clickhouse', 'cockroach', 'duckdb', 'snowsql', 'bq', 'turso', 'wrangler'];
export const DROP_SQL = /\bdrop\s+(?:database|schema)\b|\.dropDatabase\s*\(/i;

// Files that make up the guard-rails (checked by the guard-rails-change rule).
export const GUARD_RAIL_FILES = [
  /(?:^|\/)guard-config\.json$/i,
  /(?:^|\/)hooks\/solo-company(?:\/|$)/i,
  /(?:^|\/)\.claude\/(?:.*\/)?(?:managed-)?settings(?:\.[\w-]+)?\.json$/i,
];
// Shell commands that only read files: naming a guard-rail file with them is fine.
export const READ_ONLY_COMMANDS = ['cat', 'type', 'get-content', 'gc', 'less', 'more', 'head', 'tail', 'grep', 'egrep',
  'fgrep', 'rg', 'findstr', 'select-string', 'sls', 'ls', 'dir', 'gci', 'get-childitem', 'stat', 'file', 'wc', 'diff',
  'cmp', 'jq', 'test', '[', 'echo', 'printf', 'write-output', 'write-host', 'test-path', 'get-item', 'gi', 'bat'];

// Tools whose input is a shell command.
export const SHELL_TOOLS = ['Bash', 'PowerShell'];
// Tools that write file content, and where that content is.
export const WRITE_TOOLS = {
  Write: (ti) => [ti.content],
  Edit: (ti) => [ti.new_string],
  MultiEdit: (ti) => (Array.isArray(ti.edits) ? ti.edits.map((e) => e && e.new_string) : []),
  NotebookEdit: (ti) => [ti.new_source],
};

// ===========================================================================
// Everything below is the engine. You should not need to change it.
// ===========================================================================

const ORDER = { allow: 0, ask: 1, deny: 2 };

// ---- secrets ---------------------------------------------------------------

function patternHits(p, chunk) {
  if (!p.allow || !p.allow.length) return p.re.test(chunk);
  const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
  for (const m of chunk.matchAll(re)) if (!p.allow.includes(m[0])) return true;
  return false;
}

// Returns the matching secret pattern (a 'deny' one if any matches, else an
// 'ask' one), or null. Scans in windows so a single regex never sees more
// than LIMITS.scanWindow characters.
//   opts: a number (max characters) or { maxChars, off: [pattern ids] }
export function findSecret(text, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const o = typeof opts === 'number' ? { maxChars: opts } : (opts || {});
  const off = new Set(Array.isArray(o.off) ? o.off : []);
  const patterns = SECRET_PATTERNS.filter((p) => !off.has(p.id));
  const end = Math.min(text.length, o.maxChars || LIMITS.maxContentScan);
  const win = LIMITS.scanWindow;
  const overlap = 512;
  let askHit = null;
  for (let start = 0; start < end; start += win - overlap) {
    const chunk = text.slice(start, Math.min(end, start + win));
    for (const p of patterns) {
      if (!patternHits(p, chunk)) continue;
      if ((p.decision || 'deny') === 'deny') return p;
      askHit = askHit || p;
    }
    if (start + win >= end) break;
  }
  return askHit;
}

export function secretDecision(p) {
  return (p && p.decision) || 'deny';
}

// Replaces anything secret-looking in a short text with [redacted:<id>].
export function redact(text) {
  let s = String(text);
  for (const p of SECRET_PATTERNS) {
    s = s.replace(new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g'), `[redacted:${p.id}]`);
  }
  s = s.replace(/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@');
  s = s.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
  s = s.replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth)[A-Za-z0-9_]*\s*[:=]\s*["']?)[^\s"'&;]+/gi, '$1[redacted]');
  return s;
}

export function isEnvFile(p) {
  if (typeof p !== 'string' || !p) return false;
  const base = p.replace(/["']/g, '').split(/[\\/]/).pop();
  if (!/^\.env(?:\.[\w.-]+)?$/i.test(base)) return false;
  return !/\.(?:example|sample|template|dist|defaults)$/i.test(base);
}

// Asks git whether a path is ignored. true / false / null (no git or no repo).
export function gitIgnores(file) {
  try {
    let dir = path.dirname(file);
    for (let i = 0; i < 64 && !fs.existsSync(dir); i++) {
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    const r = spawnSync('git', ['-C', dir, 'check-ignore', '-q', '--', file], {
      timeout: LIMITS.gitTimeoutMs, windowsHide: true, stdio: 'ignore',
    });
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    return null;
  } catch {
    return null;
  }
}

export function currentGitBranch(cwd) {
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, timeout: LIMITS.gitTimeoutMs, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status !== 0) return null;
    return String(r.stdout || '').trim() || null;
  } catch {
    return null;
  }
}

// ---- paths -----------------------------------------------------------------

// Canonical form for comparing paths: forward slashes, no . or .., drive
// letters as "c:/", Git Bash "/c/..." as "c:/..." on Windows, lower case on
// Windows and macOS (their file systems ignore case).
export function canon(p, platform = process.platform) {
  let s = String(p).replace(/\\/g, '/');
  if (platform === 'win32') {
    const m = s.match(/^\/(?:cygdrive\/)?([a-zA-Z])(\/.*)?$/);
    if (m) s = m[1] + ':' + (m[2] || '/');
  }
  let prefix = '/';
  let rest = s;
  const drive = s.match(/^([a-zA-Z]):(.*)$/);
  if (drive) { prefix = drive[1].toLowerCase() + ':/'; rest = drive[2]; }
  else if (s.startsWith('//')) { prefix = '//'; rest = s.slice(2); }
  const parts = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  let out = prefix + parts.join('/');
  if (platform === 'win32' || platform === 'darwin' || drive) out = out.toLowerCase();
  return out;
}

function isAbsLike(p) {
  return /^[\\/]/.test(p) || /^[a-zA-Z]:/.test(p);
}

function isUnder(child, parent) {
  if (child === parent) return false;
  const base = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(base);
}

function isRootPath(c) {
  return c === '/' || /^[a-z]:\/$/.test(c) || /^\/mnt\/[a-z]$/.test(c) || /^\/\/[^/]+(?:\/[^/]+)?$/.test(c) || c === '//';
}

// Expands ~, $HOME, %USERPROFILE%, $env:USERPROFILE and friends. Returns null
// when the path still holds a variable the guard cannot know.
function expandVars(t, ctx) {
  let s = t;
  const home = ctx.homeRaw;
  const notWord = '(?![A-Za-z0-9_])';
  s = s.replace(/^~(?=$|[\\/])/, home);
  s = s.replace(/%HOMEDRIVE%%HOMEPATH%/gi, home);
  s = s.replace(new RegExp('\\$\\{?(?:env:)?(?:HOME|USERPROFILE)\\}?' + notWord, 'gi'), home);
  s = s.replace(/%(?:USERPROFILE|HOME)%/gi, home);
  s = s.replace(new RegExp('\\$\\{?(?:env:)?(?:SystemDrive|HOMEDRIVE)\\}?' + notWord, 'gi'), ctx.systemDrive);
  s = s.replace(/%(?:SystemDrive|HOMEDRIVE)%/gi, ctx.systemDrive);
  s = s.replace(new RegExp('\\$\\{?(?:PWD)\\}?' + notWord, 'g'), ctx.cwdRaw);
  if (/\$|%[A-Za-z_][A-Za-z0-9_]*%/.test(s)) return null;
  return s;
}

// Decides how dangerous deleting `target` is.
export function classifyDelete(target, ctx) {
  let t = String(target).trim();
  if (!t) return null;
  const expanded = expandVars(t, ctx);
  if (expanded === null) return 'unknown';
  t = expanded;
  // "dir/*", "dir/.*", "dir/**" mean "everything in dir": judge it like dir.
  const contents = t.match(/^(.*?)[\\/]+(?:\.?\*+)$/);
  if (contents) t = contents[1] === '' ? '/' : contents[1];
  else if (t === '*' || t === '.*' || t === '**') t = '.';
  if (/^[a-zA-Z]:$/.test(t)) t += '/';
  const full = isAbsLike(t) ? canon(t, ctx.platform) : canon(ctx.cwdRaw + '/' + t, ctx.platform);
  if (isRootPath(full)) return 'root';
  if (full === ctx.home || isUnder(ctx.home, full)) return 'home';
  for (const safe of ctx.safeRoots) if (isUnder(full, safe)) return 'inside';
  const project = ctx.project;
  const projectIsReal = project && !isRootPath(project) && project !== ctx.home && !isUnder(ctx.home, project);
  if (projectIsReal) {
    if (full === project) return 'project';
    if (isUnder(full, project)) return 'inside';
  }
  return 'outside';
}

// ---- shell parsing ---------------------------------------------------------

// Splits a command line into simple commands (segments) of words. Understands
// quotes, ; && || | & newlines ( ) { } and backticks as boundaries, and
// remembers every file a > or >> redirect writes to.
// `posix` = Bash rules (a backslash escapes the next space or quote). In
// PowerShell a backslash is just a path separator, so C:\ stays C:\.
// Each segment is { words, pipeIn }: pipeIn is true when a single | feeds it.
export function tokenize(cmd, { posix = true } = {}) {
  const segments = [];
  const redirects = [];
  let words = [];
  let cur = '';
  let has = false;
  let redirectNext = false;
  let pipeIn = false;
  const pushWord = () => {
    if (!has) return;
    if (redirectNext) { redirects.push(cur); redirectNext = false; } else words.push(cur);
    cur = ''; has = false;
  };
  const endSeg = (nextPipeIn = false) => {
    pushWord();
    redirectNext = false;
    if (words.length) segments.push({ words, pipeIn });
    words = [];
    pipeIn = nextPipeIn;
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'") {
      // single quotes: literal text, nothing inside runs, so $( and ` are made inert
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? cmd.length : j;
      cur += cmd.slice(i + 1, end).replace(/\$\(/g, '$\u0001(').replace(/`/g, '\u0001'); has = true; i = end; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') {
        if ((cmd[j] === '\\' || cmd[j] === '`') && cmd[j + 1] === '"') { cur += '"'; j += 2; continue; }
        cur += cmd[j]; j++;
      }
      has = true; i = j; continue;
    }
    if (posix && ch === '\\' && i + 1 < cmd.length && /[\s'"]/.test(cmd[i + 1])) {
      cur += cmd[i + 1]; has = true; i++; continue;
    }
    if (!posix && ch === '`' && i + 1 < cmd.length && /[ \t'"]/.test(cmd[i + 1])) {
      cur += cmd[i + 1]; has = true; i++; continue; // PowerShell escape
    }
    if (ch === '$' && cmd[i + 1] === '{') {
      // ${HOME}, ${env:USERPROFILE}: a variable, not a block
      const j = cmd.indexOf('}', i + 2);
      if (j > 0 && j - i < 128) { cur += cmd.slice(i, j + 1); has = true; i = j; continue; }
    }
    if (/\s/.test(ch) && ch !== '\n' && ch !== '\r') { pushWord(); continue; }
    if (ch === '>') {
      pushWord();
      if (/^\d+$/.test(words[words.length - 1] || '') && cmd[i - 1] !== ' ') words.pop();
      if (cmd[i + 1] === '>') i++;
      if (cmd[i + 1] === '&') { i++; continue; } // >&2 duplicates a stream, no file
      redirectNext = true; continue;
    }
    if (ch === '<') { pushWord(); continue; }
    if (!posix && ch === '`') {
      if (cmd[i + 1] === '\r') i++;
      if (cmd[i + 1] === '\n') { i++; pushWord(); continue; } // line continuation
      continue;
    }
    if (ch === '|') {
      if (cmd[i + 1] === '|') { i++; endSeg(false); continue; } // || is "or else", not a pipe
      endSeg(true); continue;
    }
    if (';&\n\r(){}`'.includes(ch)) {
      // keep a pipeline going across a bare line break after | (cmd |\n sh)
      endSeg(pipeIn && words.length === 0 && !has && (ch === '\n' || ch === '\r'));
      continue;
    }
    cur += ch; has = true;
  }
  endSeg();
  return { segments, redirects };
}

// The command text with the insides of quoted strings blanked out, so a
// regex can't mistake text in a commit message or grep pattern for a command.
export function skeleton(text, posix = true) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      const j = text.indexOf("'", i + 1);
      out += "''"; i = j < 0 ? text.length : j; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if ((text[j] === '\\' || text[j] === '`') && text[j + 1] === '"') j++;
        j++;
      }
      out += '""'; i = j; continue;
    }
    if (posix && ch === '\\' && i + 1 < text.length) { out += ch + text[i + 1]; i++; continue; }
    out += ch;
  }
  return out;
}

// Pulls heredoc bodies (cat <<'EOF' ... EOF) out of a command. The body is
// data, not commands: it is replaced by a placeholder word, and kept so the
// command that reads it can be checked (a shell runs it, a database client
// may get DROP DATABASE from it).
const HEREDOC_MARK = '__SOLO_HEREDOC_';
function extractHeredocs(text, store) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const pending = [];
    const line = lines[i].replace(/(?<!<)<<(-?)[ \t]*(['"]?)(?!__SOLO_HEREDOC_)([A-Za-z_][A-Za-z0-9_]*)\2/g, (m, dash, q, delim) => {
      const id = store.length;
      store.push({ body: '' });
      pending.push({ id, dash, delim });
      return `<< ${HEREDOC_MARK}${id}__ `;
    });
    out.push(line);
    for (const p of pending) {
      const body = [];
      let found = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const l = (p.dash ? lines[j].replace(/^\t+/, '') : lines[j]).replace(/\r$/, '');
        if (l.trimEnd() === p.delim) { found = j; break; }
        body.push(lines[j]);
      }
      if (found >= 0) { store[p.id].body = body.join('\n'); i = found; }
    }
  }
  return out.join('\n');
}

// Finds the commands inside $( ... ) and `...` in one word (for words that
// came from double quotes, where bash still runs them).
function substitutions(word, posix) {
  const found = [];
  for (let i = 0; i < word.length; i++) {
    if (word[i] === '$' && word[i + 1] === '(' && word[i + 2] !== '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < word.length; j++) {
        const ch = word[j];
        if (ch === "'") { const k = word.indexOf("'", j + 1); j = k < 0 ? word.length : k; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) break; }
      }
      found.push(word.slice(i + 2, j));
      i = j;
    } else if (posix && word[i] === '`') {
      const k = word.indexOf('`', i + 1);
      if (k < 0) break;
      found.push(word.slice(i + 1, k));
      i = k;
    }
  }
  return found;
}

function normCmd(w) {
  return String(w).split(/[\\/]/).pop().toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|com)$/, '');
}

const PREFIX_WORDS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'env',
  'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '.', 'call', 'xargs', 'npx', 'bunx',
  'unbuffer', 'stdbuf', 'timeout', 'ionice', 'caffeinate']);

// Strips sudo, env VAR=x, npx, xargs and similar prefixes; returns { cmd, args }.
export function parseSegment(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const lw = normCmd(w);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    if (PREFIX_WORDS.has(lw)) {
      i++;
      while (i < words.length && words[i].startsWith('-')) {
        const flag = words[i];
        i++;
        if ((lw === 'sudo' || lw === 'doas') && /^-[ugCh]$/.test(flag)) i++;
      }
      if ((lw === 'timeout' || lw === 'nice') && i < words.length && /^\d/.test(words[i])) i++;
      continue;
    }
    if ((lw === 'pnpm' || lw === 'yarn') && (words[i + 1] === 'dlx' || words[i + 1] === 'exec')) { i += 2; continue; }
    break;
  }
  return { cmd: normCmd(words[i] || ''), args: words.slice(i + 1) };
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'wsl']);
const EVALS = new Set(['eval', 'iex', 'invoke-expression']);

// If a segment runs another shell (bash -c "...", pwsh -Command "...",
// cmd /c ..., eval ..., iex ...), returns the inner command text.
function innerCommand(seg) {
  const { cmd, args } = seg;
  if (EVALS.has(cmd)) return args.join(' ');
  if (!SHELLS.has(cmd)) return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const la = a.toLowerCase();
    if (cmd === 'pwsh' || cmd === 'powershell') {
      if (/^-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/.test(la)) {
        try { return Buffer.from(args[i + 1] || '', 'base64').toString('utf16le'); } catch { return null; }
      }
      if (/^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/.test(la)) return args.slice(i + 1).join(' ');
      if (!a.startsWith('-')) return args.slice(i).join(' ');
      if (/^-(?:file|f)$/.test(la)) return null;
      if (PWSH_VALUE_PARAMS.test(a)) i++;
      continue;
    }
    if (cmd === 'cmd') {
      if (la === '/c' || la === '/k') return args.slice(i + 1).join(' ');
      continue;
    }
    if (cmd === 'wsl') {
      if (la === '-e' || la === '--exec' || la === '--') return args.slice(i + 1).join(' ');
      if (!a.startsWith('-')) return args.slice(i).join(' ');
      if (/^-(?:d|u|-distribution|-user|-cd)$/.test(la)) i++;
      continue;
    }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) return args.slice(i + 1).join(' ');
    if (!a.startsWith('-')) return null; // bash script.sh
  }
  return null;
}

const DELETE_CMDS = new Set(['rm', 'rmdir', 'rd', 'remove-item', 'ri', 'del', 'erase', 'rimraf', 'find', 'trash', 'unlink']);
const PS_VALUE_PARAMS = /^-(?:filter|include|exclude|credential|stream|erroraction|ea|warningaction|wa|informationaction|infa|errorvariable|ev|warningvariable|wv|outvariable|ov|outbuffer|ob|pipelinevariable|pv)$/i;
const PWSH_VALUE_PARAMS = /^-(?:executionpolicy|ep|ex|exec|windowstyle|w|win|workingdirectory|wd|inputformat|outputformat|if|of|settingsfile|configurationname|version|psconsolefile)$/i;
const PS_PATH_PARAMS = /^-(?:path|literalpath|lp|pspath)$/i;

// Finds the targets of a recursive (or wildcard) delete in one segment.
function deleteTargets(seg) {
  const { cmd, args } = seg;
  if (!DELETE_CMDS.has(cmd)) return [];
  if (args.some((a) => /^-whatif(?::\$?true)?$/i.test(a))) return []; // dry run
  if (cmd === 'find') {
    if (!args.includes('-delete') && !(args.includes('-exec') && args.some((a) => a === 'rm'))) return [];
    const targets = [];
    for (const a of args) { if (/^[-(!]/.test(a)) break; targets.push(a); }
    return targets.length ? targets : ['.'];
  }
  let recursive = cmd === 'rimraf';
  const targets = [];
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!endOfFlags && a === '--') { endOfFlags = true; continue; }
    if (!endOfFlags && a.startsWith('-')) {
      const la = a.toLowerCase();
      // --recursive, PowerShell -Recurse (or any prefix of it: -r, -re, -rec ...),
      // or a POSIX flag cluster with r/R in it: -r, -R, -rf, -fr, -Rfv ...
      if (la === '--recursive' || /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\$?true)?$/.test(la)) recursive = true;
      else if (/^-[fiIrRdv]+$/.test(a) && /[rR]/.test(a)) recursive = true;
      if (PS_PATH_PARAMS.test(a)) { if (args[i + 1] !== undefined) targets.push(...args[++i].split(',')); continue; }
      if (PS_VALUE_PARAMS.test(a)) { i++; continue; }
      continue;
    }
    if (['rd', 'rmdir', 'del', 'erase'].includes(cmd) && /^\/[a-z]$/i.test(a)) {
      if (a.toLowerCase() === '/s') recursive = true;
      continue;
    }
    if (['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir'].includes(cmd) && a.includes(',') && !a.includes('/')) {
      targets.push(...a.split(',').filter(Boolean));
    } else {
      targets.push(a);
    }
  }
  if (recursive) return targets;
  // Not recursive: still count wildcard deletes like rm ~/* or Remove-Item C:\*
  return targets.filter((t) => /\*/.test(t));
}

// Parses a full command (recursing into bash -c, eval, $(...)), up to a depth.
const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const STDIN_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'iex', 'invoke-expression', 'pwsh', 'powershell']);
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const REMOTE_WRAPPERS = new Set(['docker', 'podman', 'kubectl', 'ssh', 'heroku', 'flyctl', 'fly']);

function isDbClient(seg) {
  if (DB_CLIENTS.includes(seg.cmd)) return true;
  return REMOTE_WRAPPERS.has(seg.cmd) && seg.args.some((a) => DB_CLIENTS.includes(normCmd(a)));
}

export function touchesGuardRail(p, ctx) {
  if (typeof p !== 'string' || !p) return false;
  const s = p.replace(/["']/g, '').replace(/\\/g, '/');
  if (GUARD_RAIL_FILES.some((re) => re.test(s))) return true;
  const full = isAbsLike(s) || s.startsWith('~') ? s : canon(ctx.cwdRaw + '/' + s, ctx.platform);
  return GUARD_RAIL_FILES.some((re) => re.test(full));
}

export function parseCommand(command, ctx) {
  const raw = String(command || '').slice(0, LIMITS.maxCommandScan);
  const c = {
    raw, skeletons: [], segments: [], deletes: [], git: [], pushes: [], redirects: [], writesFile: false,
    pipeToShell: false, dbDrop: false, touchesGuardRails: false, secret: null,
  };
  const heredocs = [];
  const walk = (input, depth, posix) => {
    if (depth > 4 || !input) return;
    const text = posix ? extractHeredocs(input, heredocs) : input;
    c.skeletons.push(skeleton(text, posix));
    const { segments, redirects } = tokenize(text, { posix });
    c.redirects.push(...redirects);
    let pipeline = [];
    for (const { words: allWords, pipeIn } of segments) {
      // heredoc placeholders: remember which bodies this command reads
      const bodies = [];
      const words = allWords.filter((w) => {
        const m = w.match(/^__SOLO_HEREDOC_(\d+)__$/);
        if (m) { bodies.push(heredocs[Number(m[1])].body); return false; }
        return true;
      });
      const seg = parseSegment(words);
      if (!pipeIn) pipeline = [];
      if (!seg.cmd) continue;
      c.segments.push(seg);
      // curl ... | sh  (a real pipe, after quotes are taken apart)
      if (pipeIn && STDIN_RUNNERS.has(seg.cmd) && pipeline.some((p) => DOWNLOADERS.has(p.seg.cmd))) c.pipeToShell = true;
      // SQL that drops a database, given to a database client
      if (isDbClient(seg)) {
        if (DROP_SQL.test(seg.args.join(' '))) c.dbDrop = true;
        if (pipeIn && pipeline.some((p) => DROP_SQL.test(p.words.join(' ')))) c.dbDrop = true;
        if (bodies.some((b) => DROP_SQL.test(b))) c.dbDrop = true;
      }
      // a shell reading a heredoc runs it: check the body as commands
      if (POSIX_SHELLS.has(seg.cmd)) for (const b of bodies) walk(b, depth + 1, true);
      // naming a guard-rail file with anything but a read-only command
      if (!READ_ONLY_COMMANDS.includes(seg.cmd) && seg.args.some((a) => touchesGuardRail(a, ctx))) {
        if (!(seg.cmd === 'git' && !/^(?:rm|mv|checkout|restore|reset|clean|apply)$/.test(gitSub(seg.args)))) c.touchesGuardRails = true;
      }
      pipeline.push({ seg, words });
      // tee, Set-Content, Out-File write files too
      if (seg.cmd === 'tee' || ['out-file', 'set-content', 'add-content', 'sc', 'ac'].includes(seg.cmd)) {
        c.writesFile = true;
        for (let i = 0; i < seg.args.length; i++) {
          const a = seg.args[i];
          if (/^-(?:filepath|path|literalpath)$/i.test(a)) { c.redirects.push(seg.args[i + 1] || ''); i++; continue; }
          if (!a.startsWith('-')) c.redirects.push(a);
        }
      }
      for (const t of deleteTargets(seg)) {
        const danger = classifyDelete(t, ctx);
        if (danger) c.deletes.push({ target: t, danger });
      }
      if (seg.cmd === 'git') parseGit(seg.args, c, ctx);
      const inner = innerCommand(seg);
      if (inner) {
        const innerPosix = ['pwsh', 'powershell', 'cmd', 'iex', 'invoke-expression'].includes(seg.cmd) ? false
          : seg.cmd === 'eval' ? posix : true;
        // sh -c "$(curl ...)", eval "$(curl ...)": runs whatever was downloaded
        if (/^\s*(?:\$\u0001?\(|`|\u0001)\s*(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i.test(inner)) c.pipeToShell = true;
        walk(inner, depth + 1, innerPosix);
      }
      // $( ... ) inside double quotes still runs (bash and PowerShell): check
      // what it runs. Inside single quotes nothing runs (see tokenize).
      for (const w of words) {
        if (w.includes('$(') || (posix && w.includes('`'))) for (const sub of substitutions(w, posix)) walk(sub, depth + 1, posix);
      }
    }
  };
  walk(raw, 0, ctx.posixShell !== false);
  if (c.redirects.some((r) => touchesGuardRail(r, ctx))) c.touchesGuardRails = true;
  if (c.redirects.length || /<</.test(raw)) c.writesFile = true;
  c.secret = findSecret(raw, { maxChars: LIMITS.maxCommandScan, off: ctx.offPatterns });
  return c;
}

function gitSub(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += (args[i] === '-C' || args[i] === '-c') ? 2 : 1;
  return (args[i] || '').toLowerCase();
}

function parseGit(args, c, ctx) {
  let i = 0;
  let gitCwd = ctx.cwdRaw;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C') { gitCwd = path.resolve(gitCwd, args[i + 1] || '.'); i += 2; continue; }
    if (a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { i += 2; continue; }
    i++;
  }
  const sub = (args[i] || '').toLowerCase();
  const rest = args.slice(i + 1);
  c.git.push({ sub, args: rest, cwd: gitCwd });
  if (sub === 'push') c.pushes.push(parsePush(rest, gitCwd, ctx));
}

const MAIN_BRANCHES = ['main', 'master'];

function parsePush(args, gitCwd, ctx) {
  let force = false; let del = false; let mirror = false; let all = false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force' || a === '--force-if-includes' || a.startsWith('--force-with-lease')) { force = true; continue; }
    if (a === '--delete') { del = true; continue; }
    if (a === '--mirror') { mirror = true; continue; }
    if (a === '--all' || a === '--branches') { all = true; continue; }
    if (/^--(?:repo|receive-pack|exec|push-option)$/.test(a) || a === '-o') { i++; continue; }
    if (a.startsWith('--')) continue;
    if (/^-[a-zA-Z]+$/.test(a)) {
      if (a.includes('f')) force = true;
      if (a.includes('d')) del = true;
      continue;
    }
    positional.push(a);
  }
  const refspecs = positional.slice(1);
  let main = all;
  const isMain = (name) => MAIN_BRANCHES.includes(name.replace(/^refs\/heads\//, ''));
  if (refspecs.length === 0 && !all && !mirror) {
    const branch = ctx.currentBranch(gitCwd);
    if (branch && isMain(branch)) main = true;
  }
  for (let r of refspecs) {
    if (r.startsWith('+')) { force = true; r = r.slice(1); }
    let dest = r;
    if (r.includes(':')) {
      const [src, dst] = r.split(':');
      dest = dst;
      if (src === '') del = true;
    } else if (r === 'HEAD') {
      dest = ctx.currentBranch(gitCwd) || '';
    }
    if (isMain(dest)) main = true;
  }
  return { main, force, del, mirror };
}

// ---- decisions -------------------------------------------------------------

export function loadConfig(companyHome) {
  try {
    const file = path.join(companyHome, 'guard-config.json');
    if (!fs.existsSync(file)) return {};
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function makeCtx(input, opts) {
  const platform = opts.platform || process.platform;
  const homeRaw = opts.home || os.homedir();
  const cwdRaw = (input && typeof input.cwd === 'string' && input.cwd) || opts.cwd || process.cwd();
  const projectRaw = opts.projectDir || cwdRaw;
  return {
    platform,
    homeRaw,
    home: canon(homeRaw, platform),
    cwdRaw,
    project: canon(projectRaw, platform),
    safeRoots: (opts.safeRoots || SAFE_DELETE_ROOTS).filter(Boolean).map((p) => canon(p, platform)),
    systemDrive: opts.systemDrive || (platform === 'win32' ? (process.env.SystemDrive || 'C:') : '/'),
    currentBranch: opts.currentBranch || currentGitBranch,
    gitIgnores: opts.gitIgnores || gitIgnores,
    offPatterns: opts.config && Array.isArray(opts.config.offPatterns) ? opts.config.offPatterns : [],
  };
}

function applyConfig(rule, decision, config) {
  const off = new Set([...(Array.isArray(config.off) ? config.off : [])]);
  const soft = new Set(Array.isArray(config.ask) ? config.ask : []);
  if (off.has(rule)) return null;
  if (decision === 'deny' && soft.has(rule)) return 'ask';
  return decision;
}

// The pure decision function: no stdin, no stdout. Used by the hook and tests.
// Returns { decision: 'allow' | 'ask' | 'deny', rule, reason }.
export function evaluate(input, opts = {}) {
  const tool = input && typeof input.tool_name === 'string' ? input.tool_name : '';
  const ti = input && input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const config = opts.config || {};
  const ctx = makeCtx(input, opts);
  let best = { decision: 'allow', rule: null, reason: '' };
  const consider = (rule, decision, reason) => {
    const d = applyConfig(rule, decision, config);
    if (d && ORDER[d] > ORDER[best.decision]) best = { decision: d, rule, reason };
  };

  if (WRITE_TOOLS[tool]) {
    const rawFile = ti.file_path || ti.notebook_path || '';
    const texts = WRITE_TOOLS[tool](ti).filter((t) => typeof t === 'string');
    // a deny-level pattern anywhere beats an ask-level one
    let found = null;
    for (const t of texts) {
      const hit = findSecret(t, { off: ctx.offPatterns });
      if (hit && (!found || secretDecision(hit) === 'deny')) found = hit;
      if (found && secretDecision(found) === 'deny') break;
    }
    if (found) {
      const file = rawFile ? path.resolve(ctx.cwdRaw, rawFile) : '';
      const ignoredEnv = file && isEnvFile(file) && ctx.gitIgnores(file) === true;
      if (!ignoredEnv) {
        const level = secretDecision(found);
        consider('secret-in-file', level, level === 'deny'
          ? `The new content looks like a live secret (${found.name}). Keep secrets in a .env file that git ignores and read them from the environment.`
          : `The new content holds something that looks like a ${found.name}. Some are public by design (Firebase web keys); others are secrets. Check before saving.`);
      }
    }
    const rail = RULES.find((r) => r.id === 'guard-rails-change');
    if (rail && touchesGuardRail(String(rawFile), ctx)) consider(rail.id, rail.decision, rail.reason);
  }

  if (SHELL_TOOLS.includes(tool) && typeof ti.command === 'string') {
    const c = parseCommand(ti.command, { ...ctx, posixShell: tool !== 'PowerShell' });
    for (const rule of RULES) {
      let hit = false;
      if (rule.pattern) {
        const list = Array.isArray(rule.pattern) ? rule.pattern : [rule.pattern];
        hit = list.some((re) => c.skeletons.some((s) => re.test(s)));
      }
      if (!hit && rule.match) hit = Boolean(rule.match(c));
      if (hit) consider(rule.id, rule.decision, rule.reason);
    }
  }
  return best;
}

export function formatReason(result) {
  if (result.decision === 'deny') {
    return `[guard: ${result.rule}] Blocked: ${result.reason} If this is really needed, the owner can run it by hand, or switch the rule off in guard-config.json.`;
  }
  return `[guard: ${result.rule}] ${result.reason}`;
}

export function toolSummary(tool, ti) {
  ti = ti && typeof ti === 'object' ? ti : {};
  let s;
  const str = (v) => (typeof v === 'string' ? v : '');
  if (SHELL_TOOLS.includes(tool)) s = str(ti.command);
  else if (WRITE_TOOLS[tool] || ['Read', 'NotebookRead'].includes(tool)) s = str(ti.file_path || ti.notebook_path);
  else if (tool === 'Glob' || tool === 'Grep') s = `${str(ti.pattern)} in ${str(ti.path) || '.'}`;
  else if (tool === 'WebFetch') s = str(ti.url);
  else if (tool === 'WebSearch') s = str(ti.query);
  else if (tool === 'Task' || tool === 'Agent') s = str(ti.description) || str(ti.subagent_type);
  else s = 'keys: ' + Object.keys(ti).slice(0, 12).join(',');
  s = s.slice(0, 4096).replace(/\s+/g, ' ').trim();
  return redact(s).slice(0, LIMITS.summaryChars);
}

export function companyHomeFrom(env = process.env) {
  const custom = env.SOLO_COMPANY_HOME;
  if (custom && custom.trim()) return path.resolve(custom.trim());
  return path.join(os.homedir(), 'company');
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function writeAudit(companyHome, entry) {
  try {
    const now = new Date();
    const dir = path.join(companyHome, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ time: now.toISOString(), ...entry }) + '\n';
    fs.appendFileSync(path.join(dir, `audit-${localDate(now)}.jsonl`), line);
  } catch {
    // The audit log must never break a tool call.
  }
}

// ---- the hook --------------------------------------------------------------

function readStdin(limit) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (d) => {
      size += d.length;
      if (size <= limit) chunks.push(d);
    });
    process.stdin.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(null));
  });
}

async function runHook() {
  const state = { decision: null, input: null, done: false, companyHome: null };

  const finish = (result, note) => {
    if (state.done) return;
    state.done = true;
    clearTimeout(watchdog);
    const tool = state.input && typeof state.input.tool_name === 'string' ? state.input.tool_name : '?';
    if (state.companyHome) {
      const entry = {
        tool,
        decision: result.decision,
        rule: result.rule || null,
        summary: state.input ? toolSummary(tool, state.input.tool_input) : '',
      };
      if (note) entry.note = note;
      writeAudit(state.companyHome, entry);
    }
    const exit = () => process.exit(0);
    setTimeout(exit, 500).unref();
    if (result.decision === 'deny' || result.decision === 'ask') {
      const out = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: result.decision,
          permissionDecisionReason: result.formatted || formatReason(result),
        },
      };
      process.stdout.write(JSON.stringify(out) + '\n', exit);
    } else {
      exit();
    }
  };

  const fallback = (note) => finish(state.decision || { decision: 'allow', rule: null }, note);
  const watchdog = setTimeout(() => fallback('watchdog'), LIMITS.watchdogMs);
  process.on('uncaughtException', () => fallback('crash'));
  process.on('unhandledRejection', () => fallback('crash'));

  // 1. Kill switch. Fails closed: if we cannot tell, we block.
  try {
    state.companyHome = companyHomeFrom(process.env);
    const stopFile = path.join(state.companyHome, 'STOP');
    let stopped = false;
    let home = null;
    try {
      home = fs.statSync(state.companyHome);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e; // no company folder yet: nothing to stop
    }
    if (home && !home.isDirectory()) throw new Error('company path is not a folder');
    if (home) {
      try {
        fs.statSync(stopFile);
        stopped = true;
      } catch (e) {
        if (!e || e.code !== 'ENOENT') throw e;
      }
    }
    if (stopped) {
      const shown = displayPath(stopFile);
      state.decision = { decision: 'deny', rule: 'kill-switch', formatted: `Company is stopped: delete ${shown} to resume.` };
    }
  } catch {
    state.decision = { decision: 'deny', rule: 'kill-switch-error', formatted: 'Company guard could not check the STOP file, so it blocks to be safe. Check that the company folder is readable.' };
  }

  // 2. Read the tool call.
  const text = await readStdin(LIMITS.maxStdinBytes);
  try {
    state.input = text ? JSON.parse(text) : null;
  } catch {
    state.input = null;
  }
  if (state.decision) { finish(state.decision); return; }
  if (!state.input || typeof state.input !== 'object') { finish({ decision: 'allow', rule: null }, 'unreadable-input'); return; }

  // 3. Rules.
  const config = loadConfig(state.companyHome);
  const envOff = String(process.env.SOLO_GUARD_OFF || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (envOff.length) config.off = [...(Array.isArray(config.off) ? config.off : []), ...envOff];
  const result = evaluate(state.input, {
    config,
    projectDir: process.env.CLAUDE_PROJECT_DIR || undefined,
  });
  state.decision = result;
  finish(result);
}

function displayPath(p) {
  const home = os.homedir();
  if (home && canon(p).startsWith(canon(home) + '/')) {
    return '~/' + path.relative(home, p).split(path.sep).join('/');
  }
  return p;
}

function isMainModule() {
  try {
    if (!process.argv[1]) return false;
    const a = fs.realpathSync(path.resolve(process.argv[1]));
    const b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isMainModule()) runHook();
