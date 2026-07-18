import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHistory, snapshotsEqual } from '../placement_history.js';

const S = (placements, selectedSlug = null) => ({ placements, selectedSlug });
const P = (slug, x = 0, y = 0, scale = 1) => ({ slug, x, y, scale });

test('snapshotsEqual compares by value, order-stable', () => {
  assert.equal(snapshotsEqual(S([P('a', 1, 2)]), S([P('a', 1, 2)])), true);
  assert.equal(snapshotsEqual(S([P('a', 1, 2)]), S([P('a', 1, 3)])), false);
  assert.equal(snapshotsEqual(S([], 'a'), S([], 'b')), false);
});

test('begin+commit with a change pushes one undo entry', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)]));
  h.commit(S([P('a', 5, 0)]));
  assert.equal(h.canUndo(), true);
  assert.equal(h.canRedo(), false);
});

test('commit with no change pushes nothing', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)]));
  h.commit(S([P('a', 0, 0)]));
  assert.equal(h.canUndo(), false);
});

test('commit without an open gesture is a no-op', () => {
  const h = createHistory();
  assert.equal(h.commit(S([P('a', 9, 9)])), false);
  assert.equal(h.canUndo(), false);
});

test('a second begin during an open gesture does not recapture (coalescing)', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)]));   // captures 0,0
  h.begin(S([P('a', 3, 0)]));   // no-op, still 0,0
  h.commit(S([P('a', 7, 0)]));
  const undone = h.undo(S([P('a', 7, 0)]));
  assert.deepEqual(undone, S([P('a', 0, 0)]));  // restores the pre-burst state
});

test('undo returns the previous snapshot and enables redo', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)]));
  h.commit(S([P('a', 5, 0)]));
  const undone = h.undo(S([P('a', 5, 0)]));
  assert.deepEqual(undone, S([P('a', 0, 0)]));
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), true);
});

test('redo returns the future snapshot round-trip', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)]));
  h.commit(S([P('a', 5, 0)]));
  h.undo(S([P('a', 5, 0)]));
  const redone = h.redo(S([P('a', 0, 0)]));
  assert.deepEqual(redone, S([P('a', 5, 0)]));
  assert.equal(h.canUndo(), true);
  assert.equal(h.canRedo(), false);
});

test('undo/redo on empty stacks return null', () => {
  const h = createHistory();
  assert.equal(h.undo(S([])), null);
  assert.equal(h.redo(S([])), null);
});

test('a new commit clears the redo stack', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)])); h.commit(S([P('a', 5, 0)]));
  h.undo(S([P('a', 5, 0)]));
  assert.equal(h.canRedo(), true);
  h.begin(S([P('a', 0, 0)])); h.commit(S([P('a', 9, 0)]));
  assert.equal(h.canRedo(), false);
});

test('returned snapshots are decoupled clones', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)]));
  h.commit(S([P('a', 5, 0)]));
  const undone = h.undo(S([P('a', 5, 0)]));
  undone.placements[0].x = 999;               // mutate the returned copy
  const redone = h.redo(S([P('a', 0, 0)]));
  assert.equal(redone.placements[0].x, 5);    // stored redo entry unaffected
});

test('undo stack is capped at the limit, dropping oldest', () => {
  const h = createHistory({ limit: 3 });
  for (let i = 1; i <= 5; i++) {
    h.begin(S([P('a', i - 1, 0)]));
    h.commit(S([P('a', i, 0)]));
  }
  // 5 commits, cap 3 → only the last 3 "before" states are retained.
  let s = S([P('a', 5, 0)]);
  const seen = [];
  for (let step; (step = h.undo(s)); ) { seen.push(step.placements[0].x); s = step; }
  assert.deepEqual(seen, [4, 3, 2]);  // oldest (1, 0) evicted
});

test('clear empties both stacks and any open gesture', () => {
  const h = createHistory();
  h.begin(S([P('a', 0, 0)])); h.commit(S([P('a', 5, 0)]));
  h.begin(S([P('a', 5, 0)]));           // leave a gesture open
  h.clear();
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.commit(S([P('a', 8, 0)])), false);  // no open gesture after clear
});
