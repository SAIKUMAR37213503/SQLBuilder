// Snapshot-based undo/redo for the workspace. States are stored as JSON
// strings, which makes snapshots immutable and duplicates cheap to detect.

export class UndoStack {
    constructor(limit = 100) {
        this.limit = limit;
        this.past = [];
        this.future = [];
        this.current = null;
    }

    reset(state) {
        this.past = [];
        this.future = [];
        this.current = JSON.stringify(state);
    }

    /** Records a new state. Returns false when nothing changed. */
    push(state) {
        const snapshot = JSON.stringify(state);
        if (snapshot === this.current) return false;
        if (this.current !== null) this.past.push(this.current);
        if (this.past.length > this.limit) this.past.shift();
        this.current = snapshot;
        this.future = [];
        return true;
    }

    undo() {
        if (this.past.length === 0) return null;
        this.future.push(this.current);
        this.current = this.past.pop();
        return JSON.parse(this.current);
    }

    redo() {
        if (this.future.length === 0) return null;
        this.past.push(this.current);
        this.current = this.future.pop();
        return JSON.parse(this.current);
    }

    get canUndo() {
        return this.past.length > 0;
    }

    get canRedo() {
        return this.future.length > 0;
    }
}
