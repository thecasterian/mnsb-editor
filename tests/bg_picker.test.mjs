import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterGroups, nextActiveValue, tapAction, visibleValues } from '../bg_picker.js';

const GROUPS = [
  { label: null, items: [{ value: '', label: '(none — black)', pinned: true }] },
  { label: 'Main', items: [
    { value: 'm/Background_001_001.png', label: 'Background_001_001' },
    { value: 'm/Background_023_001.png', label: 'Background_023_001' },
  ] },
  { label: 'Stills', items: [
    { value: 's/Still_023_004.png', label: 'Still_023_004' },
  ] },
];

test('an empty filter returns every group unchanged', () => {
  assert.deepEqual(filterGroups(GROUPS, ''), GROUPS);
});

test('a filter keeps matching rows across every group', () => {
  const out = filterGroups(GROUPS, '023');
  assert.deepEqual(out.map(g => g.label), [null, 'Main', 'Stills']);
  assert.deepEqual(out[1].items.map(i => i.label), ['Background_023_001']);
  assert.deepEqual(out[2].items.map(i => i.label), ['Still_023_004']);
});

test('a group with no matching rows disappears', () => {
  const out = filterGroups(GROUPS, 'Still');
  assert.deepEqual(out.map(g => g.label), [null, 'Stills']);
});

test('filtering is case-insensitive', () => {
  assert.equal(filterGroups(GROUPS, 'background_023').length, 2);
});

test('the pinned row survives a filter that matches nothing', () => {
  const out = filterGroups(GROUPS, 'zzzz');
  assert.deepEqual(out.map(g => g.label), [null]);
  assert.deepEqual(out[0].items.map(i => i.value), ['']);
});

test('visibleValues flattens groups into display order', () => {
  assert.deepEqual(visibleValues(GROUPS), [
    '', 'm/Background_001_001.png', 'm/Background_023_001.png', 's/Still_023_004.png',
  ]);
});

test('arrowing down from nothing lands on the first row', () => {
  assert.equal(nextActiveValue(['a', 'b', 'c'], null, 1), 'a');
});

test('arrowing up from nothing lands on the last row', () => {
  assert.equal(nextActiveValue(['a', 'b', 'c'], null, -1), 'c');
});

test('arrowing moves one row at a time', () => {
  assert.equal(nextActiveValue(['a', 'b', 'c'], 'b', 1), 'c');
  assert.equal(nextActiveValue(['a', 'b', 'c'], 'b', -1), 'a');
});

test('arrowing clamps at both ends rather than wrapping', () => {
  assert.equal(nextActiveValue(['a', 'b', 'c'], 'c', 1), 'c');
  assert.equal(nextActiveValue(['a', 'b', 'c'], 'a', -1), 'a');
});

test('arrowing after the active row was filtered away starts over', () => {
  assert.equal(nextActiveValue(['a', 'b'], 'gone', 1), 'a');
  assert.equal(nextActiveValue(['a', 'b'], 'gone', -1), 'b');
});

test('arrowing an empty list yields nothing', () => {
  assert.equal(nextActiveValue([], null, 1), null);
});

test('the first tap on a row previews it', () => {
  assert.equal(tapAction({ previewValue: null }, { value: 'a', hasThumb: true }), 'preview');
});

test('a second tap on the previewing row commits it', () => {
  assert.equal(tapAction({ previewValue: 'a' }, { value: 'a', hasThumb: true }), 'commit');
});

test('tapping a different row moves the preview instead of committing', () => {
  assert.equal(tapAction({ previewValue: 'a' }, { value: 'b', hasThumb: true }), 'preview');
});

test('a row with no thumbnail commits on the first tap', () => {
  // "(none — black)" has nothing to preview; two taps would be a tax for nothing.
  assert.equal(tapAction({ previewValue: null }, { value: '', hasThumb: false }), 'commit');
  assert.equal(tapAction({ previewValue: 'a' }, { value: '', hasThumb: false }), 'commit');
});
