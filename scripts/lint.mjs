#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = JSON.parse(readFileSync(new URL('./lint-rules.json', import.meta.url), 'utf8'));
const SKIP_DIRS = new Set(['.git', 'node_modules']);

// Names of real people, employers and private packages stay out of this public file. A maintainer keeps them in
// a private list outside the repo and points this variable at it; its patterns join org-term.
const PRIVATE_ENV = 'STANDARDS_LINT_PRIVATE_DENYLIST';
if (process.env[PRIVATE_ENV]) {
  let extra;
  try {
    extra = JSON.parse(readFileSync(process.env[PRIVATE_ENV], 'utf8'));
  } catch (e) {
    console.error(`${PRIVATE_ENV}=${process.env[PRIVATE_ENV]} is not a readable JSON file: ${e.message}`);
    process.exit(2);
  }
  if (!Array.isArray(extra.patterns) || !extra.patterns.every((p) => typeof p === 'string')) {
    console.error(`${PRIVATE_ENV} must name a file holding {"patterns": ["regex", ...]}`);
    process.exit(2);
  }
  RULES.denylists.find((l) => l.rule === 'org-term').patterns.push(...extra.patterns);
}

const denylists = RULES.denylists.map((list) => ({
  ...list,
  regexes: list.patterns.map((p) => new RegExp(p, `g${list.flags}`)),
}));

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    visit(full, entry);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walk(full, visit);
  }
}

function listFiles(dir, predicate) {
  const out = [];
  walk(dir, (full, entry) => {
    if (entry.isFile() && predicate(full)) out.push(full);
  });
  return out;
}

function parseScalar(raw) {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return null;
  const fields = new Map();
  let current = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const top = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (top) {
      const [, key, rest] = top;
      const block = /^\s*[>|][+-]?\s*$/.test(rest);
      // A scalar on the key's line may continue on indented lines, which YAML folds into one string.
      current = { key, line: i + 1, value: block ? '' : rest.trim(), block, scalar: !block && rest.trim() !== '' };
      fields.set(key, current);
    } else if ((current?.block || (current?.scalar && /^\s/.test(line))) && line.trim() !== '') {
      current.value += (current.value ? ' ' : '') + line.trim();
    }
  }
  for (const f of fields.values()) if (f.scalar) f.value = parseScalar(f.value);
  return { fields, bodyStartLine: end + 2, body: lines.slice(end + 1).join('\n') };
}

/**
 * Marks each line as a fence opener, a fence closer, inside a fence, or prose. A fence closes only on a line of
 * its own marker character at least as long as the opener, so a ``` line inside a ```` fence stays code.
 */
function fenceStates(lines) {
  let open = null;
  return lines.map((line) => {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      if (!m) return 'prose';
      open = m[1];
      return 'open';
    }
    if (m && m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) {
      open = null;
      return 'close';
    }
    return 'code';
  });
}

function maskCode(text, maskInline) {
  const lines = text.split('\n');
  const states = fenceStates(lines);
  return lines.map((line, i) => {
    if (states[i] !== 'prose') return '';
    return maskInline ? line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length)) : line;
  });
}

const isQuote = (line) => /^\s*>/.test(line);

// Code and other tracked files are scanned raw: their backticks and fences are not Markdown.
const RAW_SCOPES = new Set(['code', 'tracked']);

// quoteExempt lists rules that skip blockquoted lines, where generated standards quote reviewers verbatim.
function scanDenylists(file, text, scope, report, { skip = [], quoteExempt = [] } = {}) {
  for (const list of denylists) {
    if (!list.scopes.includes(scope) || skip.includes(list.rule)) continue;
    const skipQuotes = quoteExempt.includes(list.rule);
    (RAW_SCOPES.has(scope) ? text.split('\n') : maskCode(text, list.skipInlineCode)).forEach((line, i) => {
      if (skipQuotes && isQuote(line)) return;
      for (const re of list.regexes) {
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) {
          report(file, i + 1, list.rule, `"${m[0]}" ${list.message}`);
        }
      }
    });
  }
}

function scanUrls(file, text, report) {
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\bhttps?:\/\/([^\s/)>\]"'`]+)[^\s)>\]"'`]*/g)) {
      const host = m[1].toLowerCase();
      const allowed = RULES.urlAllowlist.some((a) => host === a || host.endsWith(`.${a}`));
      if (!allowed) report(file, i + 1, 'url-allowlist', `"${m[0]}" is not on the URL allowlist`);
    }
  });
}

function scanLinks(file, text, skillDir, report) {
  maskCode(text, true).forEach((line, i) => {
    for (const m of line.matchAll(/\]\(\s*(?:<([^>]*)>|([^)]*?))(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1] ?? m[2];
      // A template's {{ }} placeholder is filled in later, so it is the one target not checked.
      if (/^\{\{.*\}\}$/.test(target)) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const path = decodeURIComponent(target.split('#')[0].split('?')[0]);
      const abs = resolve(dirname(file), path);
      if (abs !== skillDir && !abs.startsWith(skillDir + sep)) {
        report(file, i + 1, 'link-escape', `"${target}" points outside its skill folder`);
      } else if (!existsSync(abs)) {
        report(file, i + 1, 'link-broken', `"${target}" does not resolve`);
      }
    }
  });
}

function lintSkill(skillDir, report) {
  const skillFile = join(skillDir, 'SKILL.md');
  const text = readFileSync(skillFile, 'utf8');
  const fm = parseFrontmatter(text);
  const { spec } = RULES;
  if (!fm) {
    report(skillFile, 1, 'frontmatter-missing', 'SKILL.md must open with --- delimited frontmatter');
  } else {
    for (const field of fm.fields.values()) {
      if (!spec.frontmatterKeys.includes(field.key) && !RULES.extensionKeys.includes(field.key)) {
        report(skillFile, field.line, 'frontmatter-key', `"${field.key}" is not an Agent Skills spec key or a listed extension key`);
      }
    }
    const name = fm.fields.get('name');
    if (!name || !name.value) {
      report(skillFile, 1, 'name-missing', 'frontmatter needs a name');
    } else {
      if (name.value.length > spec.nameMaxLength) {
        report(skillFile, name.line, 'name-length', `name is ${name.value.length} characters, max ${spec.nameMaxLength}`);
      }
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.value)) {
        report(skillFile, name.line, 'name-format', `"${name.value}" must use lowercase letters, digits and single hyphens`);
      }
      if (name.value !== basename(skillDir)) {
        report(skillFile, name.line, 'name-dir', `name "${name.value}" does not match its directory "${basename(skillDir)}"`);
      }
    }
    const description = fm.fields.get('description');
    if (!description || !description.value) {
      report(skillFile, 1, 'description-missing', 'frontmatter needs a description');
    } else if (description.value.length > spec.descriptionMaxLength) {
      report(skillFile, description.line, 'description-length', `description is ${description.value.length} characters, max ${spec.descriptionMaxLength}`);
    }
    const compatibility = fm.fields.get('compatibility');
    if (compatibility && compatibility.value.length > spec.compatibilityMaxLength) {
      report(skillFile, compatibility.line, 'compatibility-length', `compatibility is ${compatibility.value.length} characters, max ${spec.compatibilityMaxLength}`);
    }
    const tokens = Math.ceil(fm.body.length / spec.charsPerToken);
    if (tokens >= spec.bodyMaxTokens) {
      report(skillFile, fm.bodyStartLine, 'body-tokens', `body is about ${tokens} tokens, must stay under ${spec.bodyMaxTokens}`);
    }
  }

  let fenceStart = -1;
  fenceStates(text.split('\n')).forEach((state, i) => {
    if (state === 'open') fenceStart = i;
    if (state !== 'close') return;
    const length = i - fenceStart - 1;
    if (length > spec.fenceMaxLines) {
      report(skillFile, fenceStart + 1, 'fence-length', `code block runs ${length} lines, max ${spec.fenceMaxLines}; move it to references/`);
    }
  });

  // Standards generated for one repo describe that repo, so they may name the services it runs on.
  const generated = /^\s+generator:\s*standards\s*$/m.test(text.slice(0, text.indexOf('\n---', 3)));
  const exempt = generated ? { skip: RULES.generatedStandardsExempt, quoteExempt: RULES.generatedQuoteExempt } : {};
  for (const file of listFiles(skillDir, (f) => f.endsWith('.md'))) {
    const body = readFileSync(file, 'utf8');
    scanDenylists(file, body, 'skill', report, exempt);
    scanUrls(file, body, report);
    scanLinks(file, body, skillDir, report);
  }
  // Scripts and schemas ship with the skill too, so they carry no identity, no time word and no stray URL.
  for (const file of listFiles(skillDir, (f) => /\.(mjs|json)$/.test(f))) {
    let body = readFileSync(file, 'utf8');
    // A schema's top-level $schema names the JSON Schema dialect, the one URL a schema must carry.
    if (file.endsWith('.json')) body = body.replace(/^(\s{0,2}"\$schema"\s*:\s*)"[^"]*"/m, (m, key) => key + ' '.repeat(m.length - key.length));
    scanDenylists(file, body, 'code', report, exempt);
    scanUrls(file, body, report);
  }
  if (generated) lintGeneratedSections(skillDir, report);

  const scriptsDir = join(skillDir, 'scripts');
  if (existsSync(scriptsDir)) {
    const schemasDir = join(skillDir, 'references', 'schemas');
    const schemas = existsSync(schemasDir) ? readdirSync(schemasDir).map((f) => f.split('.')[0]) : [];
    for (const script of readdirSync(scriptsDir)) {
      const stem = script.split('.')[0];
      if (!schemas.includes(stem)) {
        report(join(scriptsDir, script), 1, 'script-schema', `no output schema at references/schemas/${stem}.*`);
      }
    }
  }
}

const section = (text, heading) => {
  const m = new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text);
  return m ? m[1] : null;
};

/**
 * Each generated § file keeps the parts a reader needs to trust its rule: an Applies to line, a why, at least 3
 * evidence items each naming the heuristic it fires, and a confirmed-when bar. doctor reports the same gaps as
 * section-incomplete; this is the half a machine can check.
 */
function lintGeneratedSections(skillDir, report) {
  const refs = join(skillDir, 'references');
  if (!existsSync(refs)) return;
  for (const name of readdirSync(refs).filter((n) => /^s\d+(-\d+)*-.+\.md$/.test(n))) {
    const file = join(refs, name);
    const text = readFileSync(file, 'utf8');
    const gaps = [];
    if (!/^- Applies to: \S/m.test(text)) gaps.push('an Applies to line');
    if (!section(text, 'Why')?.trim()) gaps.push('a non-empty ## Why');
    const items = (section(text, 'Evidence') ?? '').split(/^- /m).slice(1);
    if (items.length < 3) gaps.push(`3 evidence items (has ${items.length})`);
    else if (items.some((it) => !/^\s*fires: \S/m.test(it))) gaps.push('a fires: line under every evidence item');
    if (!section(text, 'Confirmed when')?.trim()) gaps.push('a non-empty ## Confirmed when');
    if (gaps.length) report(file, 1, 'generated-section', `needs ${gaps.join(', ')}`);
  }
}

function lintMarketplace(root, report) {
  const file = join(root, '.claude-plugin', 'marketplace.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const pluginsDir = join(root, 'plugins');
  const onDisk = existsSync(pluginsDir)
    ? readdirSync(pluginsDir).filter((d) => statSync(join(pluginsDir, d)).isDirectory()).sort()
    : [];
  // A source may also be an object naming a remote repo, which no plugins/* folder backs.
  const dirOf = (p) => (typeof p.source === 'string' ? p.source.replace(/^\.\/plugins\//, '').replace(/\/$/, '') : null);
  const listed = (manifest.plugins ?? []).map(dirOf);
  for (const dir of onDisk.filter((d) => !listed.includes(d))) {
    report(file, 1, 'marketplace-plugins', `plugins/${dir} is not listed`);
  }
  for (const entry of manifest.plugins ?? []) {
    const dir = dirOf(entry);
    if (dir === null) {
      report(file, 1, 'marketplace-plugins', `"${entry.name}" has a source that is not a ./plugins/* path; this repo lists only its own plugins`);
    } else if (!onDisk.includes(dir)) {
      report(file, 1, 'marketplace-plugins', `"${entry.name}" source "${entry.source}" is not a plugins/* directory`);
    } else {
      // The listing and the plugin's own manifest are written by hand twice, so they must say the same thing.
      const pluginFile = join(pluginsDir, dir, '.claude-plugin', 'plugin.json');
      const plugin = existsSync(pluginFile) ? JSON.parse(readFileSync(pluginFile, 'utf8')) : {};
      if (entry.name !== dir || plugin.name !== dir) report(file, 1, 'manifest-sync', `"${entry.name}": the entry name, plugin.json's name ("${plugin.name}") and the folder name ("${dir}") must match`);
      for (const key of ['version', 'description']) {
        if (entry[key] !== undefined && entry[key] !== plugin[key]) report(file, 1, 'manifest-sync', `"${entry.name}" ${key} differs from plugins/${dir}/.claude-plugin/plugin.json`);
      }
    }
  }
  if (existsSync(pluginsDir)) {
    walk(pluginsDir, (full, entry) => {
      if (entry.name === 'package.json' || entry.name === 'node_modules') {
        report(full, 1, 'package-file', 'plugins ship no package.json or node_modules; use the standard library');
      }
    });
  }
}

const blank = (text, phrases) => phrases.reduce((t, p) => t.split(p).join(' '.repeat(p.length)), text);

/** The files git would ship from root: tracked plus untracked-but-not-ignored. Outside git, every file. */
function repoFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (r.status === 0) return [...new Set(r.stdout.split('\0').filter(Boolean))].filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile());
  return listFiles(root, () => true).map((f) => relative(root, f).split(sep).join('/'));
}

/** Actions pinned by full commit SHA and a pinned runner image, so a scheduled red run means the repo rotted. */
function lintWorkflows(root, report) {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const file = join(dir, name);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const uses = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
      if (uses && !uses[1].startsWith('./') && !/@[0-9a-f]{40}$/.test(uses[1])) report(file, i + 1, 'workflow-pin', `"${uses[1]}" is not pinned by full commit SHA`);
      const runsOn = /^\s*runs-on:\s*(.+)$/.exec(line);
      if (runsOn && /-latest\b/.test(runsOn[1])) report(file, i + 1, 'workflow-pin', `runs-on "${runsOn[1].trim()}" floats; pin an image version`);
    });
  }
}

function findSkillDirs(dir) {
  return listFiles(dir, (f) => basename(f) === 'SKILL.md').map(dirname).sort();
}

export function lint(target) {
  const root = resolve(target);
  const errors = [];
  const report = (file, line, rule, message) => {
    errors.push({ file: relative(process.cwd(), file) || file, line, rule, message });
  };
  const isRepo = existsSync(join(root, '.claude-plugin', 'marketplace.json'));
  if (isRepo) {
    lintMarketplace(root, report);
    const pluginsDir = join(root, 'plugins');
    const skillDirs = existsSync(pluginsDir) ? findSkillDirs(pluginsDir) : [];
    skillDirs.forEach((d) => lintSkill(d, report));
    lintWorkflows(root, report);
    // Every other file the repo ships: Markdown docs get the doc rules, and everything else the identity rule.
    const inSkill = (rel) => /^plugins\/[^/]+\/skills\//.test(rel);
    for (const rel of repoFiles(root)) {
      if (inSkill(rel) || rel.split('/').includes('lint-fixtures') || RULES.identityExempt.includes(rel)) continue;
      const file = join(root, rel);
      const raw = readFileSync(file);
      if (raw.subarray(0, 8000).includes(0)) continue;
      // The repo's own install slug is the one identity a doc must carry, so it is blanked first.
      let text = blank(raw.toString('utf8'), RULES.docAllow);
      if (rel.endsWith('.md')) {
        scanDenylists(file, text, 'doc', report);
        continue;
      }
      // The install manifests must name their author, so those objects are blanked.
      if (/(^|\/)\.claude-plugin\/[^/]+\.json$/.test(rel)) {
        const keys = RULES.manifestIdentityKeys.join('|');
        text = text.replace(new RegExp(`"(?:${keys})"\\s*:\\s*\\{[^}]*\\}`, 'g'), (m) => m.replace(/[^\n]/g, ' '));
      }
      scanDenylists(file, text, 'tracked', report);
    }
  } else {
    const skillDirs = findSkillDirs(root);
    if (!skillDirs.length) report(root, 1, 'no-skills', 'no SKILL.md found under this path');
    skillDirs.forEach((d) => lintSkill(d, report));
  }
  return errors;
}

const USAGE = `usage: node scripts/lint.mjs [folder]

Lints this repo, or any folder of skills such as generated standards.
Prints file:line rule message per problem and exits 1 when it finds any.`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = lint(process.argv[2] ?? defaultRoot);
  for (const e of errors) console.log(`${e.file}:${e.line} ${e.rule} ${e.message}`);
  if (errors.length) {
    console.error(`${errors.length} problem${errors.length === 1 ? '' : 's'}`);
    process.exit(1);
  }
}
