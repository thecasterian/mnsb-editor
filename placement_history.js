// Pure, DOM-free undo/redo ring for the Scene editor's placement state.
// State is `{ placements, selectedSlug }` — small and JSON-serializable, so
// history is a full-state snapshot stack rather than per-action inverses.
//
// Gesture API (begin/commit) coalesces continuous motion (a drag, a slider
// sweep, an arrow-key burst) into a single undo step: begin captures the
// pre-gesture snapshot once; commit pushes it only if the state actually
// changed. The caller (scene.js) drives the DOM refreshes; this module only
// bookkeeps snapshots.

// Value equality via canonical JSON. Placement objects are always built with
// the same key order ({slug,x,y,scale}) and structuredClone preserves it, so
// stringify comparison is stable.
export function snapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createHistory({ limit = 100, clone = structuredClone } = {}) {
  let undoStack = [];
  let redoStack = [];
  let pendingBefore = null;

  return {
    // Open a gesture, capturing the current state as its "before". No-op if a
    // gesture is already open (so a burst captures the pre-burst state once).
    begin(state) {
      if (pendingBefore === null) pendingBefore = clone(state);
    },

    // Close the open gesture. Pushes the captured "before" onto the undo stack
    // only if `state` differs from it. Returns true iff an entry was pushed.
    commit(state) {
      if (pendingBefore === null) return false;
      const before = pendingBefore;
      pendingBefore = null;
      if (snapshotsEqual(before, state)) return false;
      undoStack.push(before);
      if (undoStack.length > limit) undoStack.shift();
      redoStack = [];
      return true;
    },

    // Return the snapshot to restore (a fresh clone), or null if nothing to
    // undo. Pushes the caller's current state onto the redo stack.
    undo(currentState) {
      if (undoStack.length === 0) return null;
      redoStack.push(clone(currentState));
      return undoStack.pop();
    },

    redo(currentState) {
      if (redoStack.length === 0) return null;
      undoStack.push(clone(currentState));
      return redoStack.pop();
    },

    clear() {
      undoStack = [];
      redoStack = [];
      pendingBefore = null;
    },

    canUndo() { return undoStack.length > 0; },
    canRedo() { return redoStack.length > 0; },
  };
}
