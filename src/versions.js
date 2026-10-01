// Compares two versions of a query by their SQL, line by line, for the
// template Versions dialog. Both sides are written by the generator with the
// same settings, so a difference is a change to the query, not to layout.

/** Longest inputs compared line by line (the work grows with their product). */
export const MAX_DIFF_LINES = 1500;

/**
 * @typedef {{ type: 'same' | 'added' | 'removed', text: string }} DiffLine
 */

/**
 * The lines of `after` against `before`: kept, added or removed, in order.
 * Returns null when either side is too long to compare.
 * @param {string} before
 * @param {string} after
 * @returns {DiffLine[] | null}
 */
export function diffLines(before, after) {
    const a = before === '' ? [] : before.split('\n');
    const b = after === '' ? [] : after.split('\n');
    if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
    // Common start and end first: most versions differ in a few lines
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    // Longest common subsequence of the middle parts
    const n = midA.length;
    const m = midB.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    /** @type {DiffLine[]} */
    const middle = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (midA[i] === midB[j]) {
            middle.push({ type: 'same', text: midA[i] });
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            middle.push({ type: 'removed', text: midA[i++] });
        } else {
            middle.push({ type: 'added', text: midB[j++] });
        }
    }
    while (i < n) middle.push({ type: 'removed', text: midA[i++] });
    while (j < m) middle.push({ type: 'added', text: midB[j++] });
    return [
        ...a.slice(0, start).map(text => ({ type: /** @type {const} */ ('same'), text })),
        ...middle,
        ...a.slice(endA).map(text => ({ type: /** @type {const} */ ('same'), text }))
    ];
}

/**
 * "2 lines added, 1 removed", or "Same SQL" when only something the SQL
 * doesn't show changed.
 * @param {DiffLine[] | null} diff
 */
export function describeDiff(diff) {
    if (!diff) return 'Too long to compare line by line';
    const added = diff.filter(d => d.type === 'added').length;
    const removed = diff.filter(d => d.type === 'removed').length;
    if (!added && !removed) return 'Same SQL';
    const lines = (count) => `${count} line${count === 1 ? '' : 's'}`;
    if (added && removed) return `${lines(added)} added, ${removed} removed`;
    return added ? `${lines(added)} added` : `${lines(removed)} removed`;
}
