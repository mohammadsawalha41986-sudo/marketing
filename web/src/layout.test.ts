/**
 * The layout invariants a screenshot would catch and a compiler never will.
 *
 * These are source-level assertions, deliberately. There is no browser test
 * framework in this project and adding one for four facts would be a heavier
 * change than the bug that prompted them — but every fact below is one that
 * broke, or could break silently, in a way that only shows up as a visibly
 * wrong page:
 *
 *   - a sticky page bar whose offset drifts from the global header's height
 *     tucks under it or floats below it, and nothing fails until someone looks
 *   - a sticky bar that outranks the header covers it instead of sliding beneath
 *   - a grid of independent cards without `items-start` inflates a short card
 *     to its tallest sibling, which is what put an 823px blank white block on
 *     the content record's Preview tab in production
 *
 * They read the real source rather than a copy of it, so a change to either
 * side of a pairing fails here instead of in a browser someone happens to open.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const shell = read('./components/layout.tsx');
const ui = read('./components/ui.tsx');
const content = read('./routes/content.tsx');

describe('app shell and page bar', () => {
  it('pins the page bar at exactly the global header\'s height', () => {
    // The header is h-16; the bar sticks at top-16. One number, two files.
    expect(shell).toMatch(/header className="sticky top-0 z-20 flex h-16/);
    expect(ui).toMatch(/className="sticky top-16 z-10/);
  });

  it('keeps the page bar under the global header, never over it', () => {
    const headerZ = shell.match(/header className="sticky top-0 z-(\d+)/)?.[1];
    const barZ = ui.match(/className="sticky top-16 z-(\d+)/)?.[1];
    expect(headerZ).toBeDefined();
    expect(barZ).toBeDefined();
    expect(Number(barZ)).toBeLessThan(Number(headerZ));
  });

  it('gives the page bar an opaque background, so content scrolls under it', () => {
    // A transparent sticky bar shows the page sliding through the title, which
    // reads as the title being "behind the header".
    expect(ui).toMatch(/sticky top-16 z-10[^"]*bg-bg/);
  });

  it('offsets the workspace by the rail\'s own width', () => {
    // Two numbers that must agree or the content sits under the sidebar.
    const railWidth = shell.match(/hidden w-\[(\d+)px\] lg:block/)?.[1];
    const mainOffset = shell.match(/lg:ps-\[(\d+)px\]/)?.[1];
    expect(railWidth).toBe(mainOffset);
  });
});

describe('card grids', () => {
  it('does not inflate a short card to its tallest sibling', () => {
    /*
     * The asymmetric grids — an explicit track list rather than N equal
     * columns — are the ones that pair a short card with a tall one: notes
     * beside a preview, details beside the copy. Those must not stretch.
     *
     * A gallery of same-kind tiles (`sm:grid-cols-2`) is deliberately left
     * alone: equal-height rows are right there, and this rule is about the
     * pairing that produced an 823px blank card, not about every grid.
     */
    const asymmetric = content.match(/className="grid[^"]*grid-cols-\[[^"]*"/g) ?? [];
    expect(asymmetric.length).toBeGreaterThan(0);
    for (const grid of asymmetric) expect(grid).toMatch(/items-start/);

    // And the record's own two-column body, which pairs copy with details.
    expect(content).toMatch(/className="grid items-start gap-4 lg:grid-cols-2"/);
  });
});
