#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = JSON.parse(readFileSync(new URL('./lint-rules.json', import.meta.url), 'utf8'));
const SKIP_DIRS = new Set(['.git', 'node_modules']);

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
      current = { key, line: i + 1, value: block || rest.trim() === '' ? '' : parseScalar(rest), block };
      fields.set(key, current);
    } else if (current?.block && line.trim() !== '') {
      current.value += (current.value ? ' ' : '') + line.trim();
    }
  }
  return { fields, bodyStartLine: end + 2, body: lines.slice(end + 1).join('\n') };
}

function maskCode(text, maskInline) {
  const lines = text.split('\n');
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return '';
    }
    if (inFence) return '';
    return maskInline ? line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length)) : line;
  });
}

const isQuote = (line) => /^\s*>/.test(line);

// quoteExempt lists rules that skip blockquoted lines, where generated standards quote reviewers verbatim.
function scanDenylists(file, text, scope, report, { skip = [], quoteExempt = [] } = {}) {
  for (const list of denylists) {
    if (!list.scopes.includes(scope) || skip.includes(list.rule)) continue;
    const skipQuotes = quoteExempt.includes(list.rule);
    maskCode(text, list.skipInlineCode).forEach((line, i) => {
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

  const lines = text.split('\n');
  let fenceStart = -1;
  lines.forEach((line, i) => {
    if (!/^\s*(```|~~~)/.test(line)) return;
    if (fenceStart === -1) {
      fenceStart = i;
      return;
    }
    const length = i - fenceStart - 1;
    if (length > spec.fenceMaxLines) {
      report(skillFile, fenceStart + 1, 'fence-length', `code block runs ${length} lines, max ${spec.fenceMaxLines}; move it to references/`);
    }
    fenceStart = -1;
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

function lintMarketplace(root, report) {
  const file = join(root, '.claude-plugin', 'marketplace.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const pluginsDir = join(root, 'plugins');
  const onDisk = existsSync(pluginsDir)
    ? readdirSync(pluginsDir).filter((d) => statSync(join(pluginsDir, d)).isDirectory()).sort()
    : [];
  const listed = (manifest.plugins ?? []).map((p) => p.source?.replace(/^\.\/plugins\//, '').replace(/\/$/, ''));
  for (const dir of onDisk.filter((d) => !listed.includes(d))) {
    report(file, 1, 'marketplace-plugins', `plugins/${dir} is not listed`);
  }
  for (const entry of manifest.plugins ?? []) {
    const dir = entry.source?.replace(/^\.\/plugins\//, '').replace(/\/$/, '');
    if (!onDisk.includes(dir)) {
      report(file, 1, 'marketplace-plugins', `"${entry.name}" source "${entry.source}" is not a plugins/* directory`);
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
    const docs = ['AGENTS.md', 'README.md'].map((f) => join(root, f));
    if (existsSync(pluginsDir)) {
      for (const p of readdirSync(pluginsDir)) docs.push(join(pluginsDir, p, 'README.md'));
    }
    for (const doc of docs.filter((d) => existsSync(d))) {
      // The repo's own install slug is the one identity a doc must carry, so it is blanked first.
      let text = readFileSync(doc, 'utf8');
      for (const phrase of RULES.docAllow) text = text.split(phrase).join(' '.repeat(phrase.length));
      scanDenylists(doc, text, 'doc', report);
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
