#!/usr/bin/env node
// Derives shape B (one skill per area) from a shape A standards skill, so the two shapes
// carry the same rules word for word and the experiment measures only the shape.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JudgeError, args, main, need, readJson } from './lib.mjs';

const USAGE = 'usage: shape-b.mjs --a <shape A skill dir> --areas <areas.json> --out <dir> --repo-slug <slug>';

function parseIndex(text) {
  const end = text.indexOf('\n---', 4);
  if (!text.startsWith('---\n') || end < 0) throw new JudgeError('shape A SKILL.md has no frontmatter');
  const body = text.slice(end + 4).replace(/^\n+/, '');
  const parts = body.split(/^(?=## §\d+ )/m);
  const [preamble, ...areas] = parts;
  return {
    preamble: preamble.trimEnd(),
    areas: areas.map((a) => {
      const [, section, name] = /^## (§\d+) (.+)$/m.exec(a);
      const links = [...a.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]);
      return { section, name: name.trim(), text: a.trimEnd(), links };
    }),
  };
}

main((argv) => {
  const { values } = args(argv, { a: { type: 'string' }, areas: { type: 'string' }, out: { type: 'string' }, 'repo-slug': { type: 'string' } }, USAGE);
  need(values, ['a', 'areas', 'out', 'repo-slug'], USAGE);
  const a = resolve(values.a);
  const out = resolve(values.out);
  const index = parseIndex(readFileSync(join(a, 'SKILL.md'), 'utf8'));
  const meta = new Map(readJson(resolve(values.areas)).map((x) => [x.section, x]));
  const title = /^# (.+)$/m.exec(index.preamble)?.[1] ?? `${values['repo-slug']} standards`;
  const intro = index.preamble.replace(/^# .+\n+/m, '');

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const placed = new Set();
  for (const area of index.areas) {
    const m = meta.get(area.section);
    if (!m?.slug || !m?.description) throw new JudgeError(`areas.json lacks a slug or description for ${area.section}`);
    const name = `${values['repo-slug']}-standards-${m.slug}`;
    const dir = join(out, name);
    mkdirSync(join(dir, 'references'), { recursive: true });
    for (const link of area.links) {
      if (!existsSync(join(a, link))) throw new JudgeError(`${area.section} links ${link}, which shape A lacks`);
      cpSync(join(a, link), join(dir, link));
      placed.add(link);
    }
    const skill = ['---', `name: ${name}`, `description: ${JSON.stringify(m.description)}`, 'metadata:', '  generator: standards', '---', '', `# ${title}: ${area.name}`, '', intro, '', area.text, ''].join('\n');
    writeFileSync(join(dir, 'SKILL.md'), skill);
  }
  const all = readdirSync(join(a, 'references')).map((f) => `references/${f}`);
  const orphans = all.filter((f) => !placed.has(f));
  if (orphans.length) throw new JudgeError(`shape A files with no index line: ${orphans.join(', ')}`);
  console.log(`${index.areas.length} skills, ${placed.size} § files, written to ${out}`);
}, import.meta.url);
