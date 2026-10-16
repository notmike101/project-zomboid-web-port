/**
 * @file Movement speed setting for the built-in `accessible-walking` sample mod.
 *
 * It lives in its own module so the shipped proof is genuinely multi-file: the
 * mod entry point imports this module through an ordinary ES module import, the
 * only packaging mechanism M1 delivers. There is no package manifest, dependency
 * resolution or file layout beyond the browser's own import rules.
 */

/**
 * Movement speed in world units per second. The engine accepts 0.1-10 and
 * refuses anything else; the value travels no further than that check.
 *
 * @type {number}
 */
export const speed = 2.25;
