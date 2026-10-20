import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseHeldout, seriesOf, titlePrefix } from './split.mjs';

test('a title prefix is the text before a part number', () => {
  assert.equal(titlePrefix('`gh issue artifact` stack 9/12: Document it'), '`gh issue artifact` stack');
  assert.equal(titlePrefix('Retry uploads (part 2)'), 'retry uploads');
  assert.equal(titlePrefix('Cache tokens [3 of 4]: add expiry'), 'cache tokens');
  assert.equal(titlePrefix('Validate repository names'), null);
});

const pr = (number, extra = {}) => ({ number, author: 'a', title: `Change ${number}`, base_ref: 'trunk', head_ref: `b${number}`, default_branch: 'trunk', ...extra });

test('stacked bases and shared title prefixes by one author join a series', () => {
  const prs = [
    pr('1', { head_ref: 'stack-1' }),
    pr('2', { base_ref: 'stack-1', head_ref: 'stack-2' }),
    pr('3', { base_ref: 'stack-2' }),
    pr('4', { title: 'Attach stack 1/2: upload' }),
    pr('5', { title: 'Attach stack 2/2: flag' }),
    pr('6', { title: 'Attach stack 2/2: flag', author: 'b' }),
    pr('7', { base_ref: 'stack-1', author: 'b' }),
  ];
  const s = seriesOf(prs);
  assert.equal(s.get('2'), s.get('1'));
  assert.equal(s.get('3'), s.get('1'));
  assert.equal(s.get('5'), s.get('4'));
  assert.notEqual(s.get('4'), s.get('1'));
  assert.notEqual(s.get('6'), s.get('4'));
  assert.notEqual(s.get('7'), s.get('1'));
});

// Newest first. Each change's graded comments come from the reviewers listed.
function world(rows) {
  const qualifying = rows.map(([number, author, seriesId], i) => ({ number, author, seriesId, merged_at: `2024-01-${String(30 - i).padStart(2, '0')}` }));
  const graded = new Map(rows.map(([number, , , reviewers]) => [number, reviewers.map((r) => ({ author: r }))]));
  const series = new Map(qualifying.map((p) => [p.number, p.seriesId]));
  return { qualifying, graded, series };
}

test('caps changes per author and per series, newest first', () => {
  const { qualifying, graded, series } = world([
    ['10', 'ann', 's1', ['r1', 'r2']],
    ['9', 'ann', 's1', ['r2', 'r3']],
    ['8', 'ann', 's1', ['r3', 'r1']],
    ['7', 'ann', 's7', ['r1', 'r3']],
    ['6', 'bob', 's6', ['r2', 'r1']],
    ['5', 'cat', 's5', ['r3', 'r2']],
  ]);
  const { heldout, diverse } = chooseHeldout(qualifying, graded, series, { n: 3, maxPerAuthor: 2, maxPerSeries: 2, maxShare: 0.5 });
  assert.deepEqual(heldout.map((p) => p.number), ['10', '9', '6']);
  assert.equal(diverse, true);
});

test('pulls further back when one reviewer wrote over half the held-out comments', () => {
  const { qualifying, graded, series } = world([
    ['10', 'ann', 's10', ['r1', 'r1', 'r1']],
    ['9', 'bob', 's9', ['r1', 'r1']],
    ['8', 'cat', 's8', ['r2', 'r1']],
    ['7', 'dan', 's7', ['r1', 'r1', 'r1']],
    ['6', 'eve', 's6', ['r3', 'r3']],
    ['5', 'fay', 's5', ['r2']],
  ]);
  const opts = { n: 3, maxPerAuthor: 2, maxPerSeries: 2, maxShare: 0.5 };
  const { heldout, top, diverse } = chooseHeldout(qualifying, graded, series, opts);
  assert.deepEqual(heldout.map((p) => p.number), ['9', '8', '6']);
  assert.deepEqual(top, { reviewer: 'r1', share: 0.5 });
  assert.equal(diverse, true);
});

test('reports a held-out set it could not diversify', () => {
  const { qualifying, graded, series } = world([
    ['10', 'ann', 's10', ['r1', 'r1']],
    ['9', 'bob', 's9', ['r1']],
    ['8', 'cat', 's8', ['r1', 'r2']],
  ]);
  const { heldout, top, diverse } = chooseHeldout(qualifying, graded, series, { n: 2, maxPerAuthor: 2, maxPerSeries: 2, maxShare: 0.5 });
  assert.deepEqual(heldout.map((p) => p.number), ['10', '9']);
  assert.deepEqual(top, { reviewer: 'r1', share: 1 });
  assert.equal(diverse, false);
});
