/**
 * The browser's globals, for the closures that are serialised and run inside it.
 *
 * `page.evaluate(fn)` does not call `fn` here. Playwright stringifies it and evaluates it in the
 * page, so its body must reference the browser's globals — which do not exist in this process and
 * which `tsc` therefore cannot see, because this repository's `lib` is `ES2023` with no `dom`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THESE DECLARATIONS ARE DELIBERATELY TINY, AND THAT IS THE POINT.**
 *
 * Adding `"dom"` to `lib` would be the one-line fix and would also make `window`, `localStorage`,
 * `fetch`'s DOM overloads and four hundred other names compile everywhere in `src/` — in a Node
 * service where every one of them is a runtime crash. Declaring only the three members the
 * evaluate closures actually use means reaching for a fourth is a compile error in the one place
 * where that error is the correct answer.
 *
 * Extend this file when a scenario genuinely needs another member, one member at a time.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

declare const document: {
  readonly body: { readonly innerText: string } | null | undefined
  querySelectorAll(selectors: string): ArrayLike<unknown> & Iterable<unknown>
}

interface HTMLAnchorElement {
  readonly href: string
}
