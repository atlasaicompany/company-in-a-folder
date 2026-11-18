#!/usr/bin/env node
// Company in a Folder: roster. Lists every agent Claude Code can call from
// here (your user folder and this project), tells the company's own
// departments from the rest, and finds the best few for a task.
//
//   node roster.mjs                   summary: how many, which kinds
//   node roster.mjs --find "words"    the 8 best matches for a task
//   node roster.mjs --all             every agent, one line each
//   node roster.mjs --line            one line (the doctor prints it)
//   node roster.mjs --json            everything above, as JSON
//   node roster.mjs --top 12          how many --find returns (default 8)
//
// Reads only: it never changes, moves or copies an agent file.
// Works with zero, a few or hundreds of agents. Node 18+, built-ins only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A pack of community agents (github.com/msitarzewski/agency-agents) copies
// its files flat into ~/.claude/agents, named <division>-<role>.md, with
// extra "emoji" and "vibe" lines in the frontmatter. These are only used to
// recognise and group them; nothing from that pack is part of this kit.
export const PACK_URL = 'https://github.com/msitarzewski/agency-agents';
export const PACK_NAME = 'Agency Agents';
export const PACK_DIVISIONS = [
  'academic', 'design', 'engineering', 'finance', 'game-development', 'gis', 'healthcare',
  'marketing', 'paid-media', 'product', 'project-management', 'research', 'sales', 'security',
  'spatial-computing', 'specialized', 'strategy', 'support', 'testing',
];
const MAX_DEPTH = 3;
const SKIP = new Set(['node_modules', '.git']);

// Where Claude Code keeps user agents: ~/.claude/agents, or CLAUDE_CONFIG_DIR/agents.
export function userClaudeDir(env = process.env, home = os.homedir()) {
  if (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim()) return path.resolve(env.CLAUDE_CONFIG_DIR.trim());
  return path.join(home, '.claude');
}

export function companyDir(env = process.env, home = os.homedir()) {
  if (env.SOLO_COMPANY_HOME && env.SOLO_COMPANY_HOME.trim()) return path.resolve(env.SOLO_COMPANY_HOME.trim());
  return path.join(home, 'company');
}

// Reads the frontmatter block of an agent file: { name, description, ... }.
// Handles quotes, CRLF, a byte-order mark and "|" / ">" block values.
// Returns null when the file has no frontmatter (then it isn't an agent).
export function parseFrontmatter(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(l));
  if (end < 0) return null;
  const out = {};
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s?(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2].trim();
    if (/^[|>][+-]?$/.test(val)) {
      const fold = val[0] === '>';
      const block = [];
      while (i + 1 < end && (/^\s/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      val = block.join(fold ? ' ' : '\n').trim();
    } else if (/^"(?:[^"\\]|\\.)*"$/.test(val)) {
      val = val.slice(1, -1).replace(/\\n/g, ' ').replace(/\\(["\\])/g, '$1');
    } else if (/^'.*'$/.test(val)) {
      val = val.slice(1, -1).replace(/''/g, "'");
    }
    out[key] = val;
  }
  return out;
}

// Long descriptions often carry <example> blocks; the roster shows the first sentence or so.
export function shortDescription(d, max = 140) {
  const s = String(d || '').replace(/<example>[\s\S]*?<\/example>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

// The departments HEAD.md names in its table: | `name` | Department | ... |
export function departmentsFromHead(text) {
  const names = [];
  for (const l of String(text || '').split(/\r?\n/)) {
    const m = l.match(/^\|\s*`([^`]+)`\s*\|/);
    if (m) names.push(m[1].trim().toLowerCase());
  }
  return names;
}

function packGroup(base) {
  const b = base.toLowerCase();
  return PACK_DIVISIONS.slice().sort((x, y) => y.length - x.length).find((d) => b.startsWith(d + '-')) || null;
}

// True when a file looks like it came from the Agency Agents pack: its
// frontmatter has the pack's "vibe" or "emoji" line, which Claude Code's own
// agent format doesn't use. (A name like design-review.md alone is not enough.)
export function looksLikePack(fm) {
  return Boolean(fm && ('vibe' in fm || 'emoji' in fm));
}

function listMd(dir, depth = 0, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try { const st = fs.statSync(p); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
    }
    if (isDir && depth < MAX_DEPTH) listMd(p, depth + 1, out);
    else if (isFile && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md') out.push(p);
  }
  return out;
}

function readHead(env, home) {
  try { return fs.readFileSync(path.join(companyDir(env, home), 'HEAD.md'), 'utf8'); } catch { return ''; }
}

// Everything Claude Code could call from `cwd`: [{ name, description, file,
// scope, department, pack, group }]. A project agent wins over a user agent
// with the same name, the way Claude Code itself picks.
export function discover({ env = process.env, cwd = process.cwd(), home = os.homedir(), departments } = {}) {
  const userDir = path.join(userClaudeDir(env, home), 'agents');
  const projectDir = path.join(path.resolve(cwd), '.claude', 'agents');
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const deps = new Set((departments || departmentsFromHead(readHead(env, home))).map((d) => d.toLowerCase()));
  const sources = [['project', projectDir]];
  if (!same(path.resolve(userDir), path.resolve(projectDir))) sources.push(['user', userDir]);
  const byName = new Map();
  const skipped = [];
  for (const [scope, dir] of sources) {
    for (const file of listMd(dir).sort()) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { skipped.push({ file, why: 'cannot be read' }); continue; }
      const fm = parseFrontmatter(text);
      if (!fm) { skipped.push({ file, why: 'no frontmatter' }); continue; }
      const base = path.basename(file, path.extname(file));
      const name = (fm.name || base).trim();
      const key = name.toLowerCase();
      if (byName.has(key)) continue; // project first, so the project copy wins
      const pack = looksLikePack(fm);
      byName.set(key, {
        name,
        description: fm.description || '',
        file,
        scope,
        department: deps.has(key) || deps.has(base.toLowerCase()),
        pack,
        group: pack ? (packGroup(base) || 'other') : null,
        tools: fm.tools || '',
      });
    }
  }
  const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { home, userDir, projectDir, agents, skipped, counts: countsOf(agents) };
}

function countsOf(agents) {
  const c = { total: agents.length, departments: 0, other: 0, pack: 0, user: 0, project: 0, groups: {} };
  for (const a of agents) {
    if (a.department) c.departments++; else c.other++;
    if (a.pack) { c.pack++; c.groups[a.group] = (c.groups[a.group] || 0) + 1; }
    c[a.scope]++;
  }
  return c;
}

// --- finding the right agent for a task ------------------------------------
const STOP = new Set(('a an and are as at be by can do for from has have help i in into is it its me my need of on or our please '
  + 'so some that the their them then this to up us we what when which who will with you your make get want new all any one just').split(' '));

function stem(w) {
  return w.replace(/(?:ization|isation|ations?|ments?|ings?|ers?|ies|ied|ed|es|s)$/, '') || w;
}
export function tokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

// Scores every agent against the task words: a hit in the name counts 3, in
// the file name or group 2, in the description 1. Returns the best `top`.
export function find(agents, task, top = 8) {
  const want = [...new Set(tokens(task))];
  if (!want.length) return [];
  const scored = agents.map((a) => {
    const nameT = new Set(tokens(a.name));
    const fileT = new Set(tokens(path.basename(a.file, '.md') + ' ' + (a.group || '')));
    const descT = new Set(tokens(shortDescription(a.description, 2000)));
    let score = 0;
    const hits = [];
    for (const w of want) {
      const s = (nameT.has(w) ? 3 : 0) + (fileT.has(w) ? 2 : 0) + (descT.has(w) ? 1 : 0);
      if (s) { score += s; hits.push(w); }
    }
    return { ...a, score, hits };
  }).filter((a) => a.score > 0);
  scored.sort((x, y) => y.score - x.score || Number(y.department) - Number(x.department) || x.name.localeCompare(y.name));
  return scored.slice(0, top);
}

// --- output ------------------------------------------------------------------
function pretty(p, homeDir = os.homedir()) {
  const home = homeDir ? path.resolve(homeDir) : '';
  const full = path.resolve(p);
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (home && (same(full, home) || same(full.slice(0, home.length + 1), home + path.sep))) return '~' + full.slice(home.length).split(path.sep).join('/');
  return p;
}

// The one line the doctor prints.
export function oneLine(r) {
  const c = r.counts;
  const deps = c.departments ? `the company's ${c.departments}` : 'the company';
  if (!c.other) return `other agents: none besides ${deps}`;
  const where = [c.user && pretty(r.userDir, r.home), c.project && 'this project'].filter(Boolean).join(' and ');
  const pack = c.pack ? `; ${c.pack} ${c.pack === 1 ? 'looks' : 'look'} like ${PACK_NAME} (${PACK_URL})` : '';
  return `other agents: ${c.other} in ${where} besides ${deps}${pack}`;
}

export function summary(r) {
  const c = r.counts;
  const lines = [`Agents Claude Code can call from here: ${c.total}`];
  const deps = r.agents.filter((a) => a.department).map((a) => a.name);
  lines.push(`  company departments (named in HEAD.md): ${deps.length}${deps.length ? `  ${deps.join(', ')}` : ''}`);
  lines.push(`  other agents: ${c.other}  (your user folder ${c.user}, this project ${c.project})`);
  if (c.pack) {
    lines.push(`  ${c.pack} ${c.pack === 1 ? 'looks' : 'look'} like ${PACK_NAME} (${PACK_URL})`);
    const g = Object.entries(c.groups).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    lines.push(`  by group: ${g.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  if (r.skipped.length) lines.push(`  skipped ${r.skipped.length} .md file(s) that are not agents (no frontmatter)`);
  lines.push(c.other > 40 ? 'Too many to list here: use --find "your task" or --all.' : '');
  if (c.other && c.other <= 40) {
    for (const a of r.agents.filter((x) => !x.department)) lines.push(`  - ${a.name}: ${shortDescription(a.description, 100)}`);
  }
  return lines.filter((l) => l !== '').join('\n');
}

function parseCli(argv) {
  const o = { find: null, all: false, line: false, json: false, top: 8, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--find') o.find = argv[++i] || '';
    else if (a === '--all') o.all = true;
    else if (a === '--line') o.line = true;
    else if (a === '--json') o.json = true;
    else if (a === '--top') o.top = Math.max(1, Number(argv[++i]) || 8);
    else if (a === '--help' || a === '-h') o.help = true;
    else if (o.find !== null && !a.startsWith('--')) o.find += ' ' + a;
    else o.unknown = a;
  }
  return o;
}

function main() {
  const o = parseCli(process.argv.slice(2));
  if (o.help) { process.stdout.write('node roster.mjs [--find "task words"] [--all] [--line] [--json] [--top N]\n'); return 0; }
  if (o.unknown) { process.stderr.write(`Unknown option: ${o.unknown}\n`); return 2; }
  const r = discover();
  const matches = o.find !== null ? find(r.agents, o.find, o.top) : null;
  if (o.json) {
    const slim = (a) => ({ name: a.name, description: shortDescription(a.description, 300), file: a.file, scope: a.scope, department: a.department, pack: a.pack, group: a.group, ...(a.score ? { score: a.score, hits: a.hits } : {}) });
    process.stdout.write(JSON.stringify({ line: oneLine(r), counts: r.counts, userDir: r.userDir, projectDir: r.projectDir,
      ...(matches ? { matches: matches.map(slim) } : { agents: r.agents.map(slim) }), skipped: r.skipped.length }, null, 2) + '\n');
    return 0;
  }
  if (o.line) { process.stdout.write(oneLine(r) + '\n'); return 0; }
  if (matches) {
    if (!matches.length) { process.stdout.write(`No agent matches "${o.find.trim()}". Do it yourself, or use the closest department.\n`); return 0; }
    process.stdout.write(`Best matches for "${o.find.trim()}" (of ${r.counts.total}):\n`);
    for (const m of matches) {
      process.stdout.write(`  ${String(m.score).padStart(2)}  ${m.name}${m.department ? ' [department]' : ''}  ${pretty(m.file)}\n      ${shortDescription(m.description, 120)}\n`);
    }
    return 0;
  }
  if (o.all) {
    for (const a of r.agents) process.stdout.write(`${a.name}${a.department ? ' [department]' : ''}: ${shortDescription(a.description, 120)}\n`);
    return 0;
  }
  process.stdout.write(summary(r) + '\n');
  return 0;
}

const isMain = (() => {
  try {
    const a = fs.realpathSync(path.resolve(process.argv[1] || ''));
    const b = fs.realpathSync(new URL(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
})();

if (isMain) process.exitCode = main();
