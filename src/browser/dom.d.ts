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
  querySelector(selectors: string): unknown | null
}

interface HTMLAnchorElement {
  readonly href: string
}

/** BJ-ACC-02 reads the values three inputs kept after a refusal. */
interface HTMLInputElement {
  readonly value: string
}

/** BJ-XS-10 clicks the switcher's trigger, because its entries do not exist until it is open. */
interface HTMLButtonElement {
  click(): void
  /** BJ-WAL-09 finds Confirm by its accessible name, per doc 22 §2.4: never by class or DOM path. */
  readonly textContent: string | null
}

/** BJ-WAL-08 reads which asset the Send form has selected, so it can price it off the API. */
interface HTMLSelectElement {
  readonly value: string
}

/** BJ-ACC-02 reads the refusal banner's text. `innerText`, so hidden nodes do not count. */
interface HTMLElement {
  readonly innerText: string
}

/**
 * `smoke.ts` asks whether the page is PAINTED, not just mounted.
 *
 * Two members and no more. `backgroundColor` is the one that decides: every CloudsForge surface
 * paints `body` from its own stylesheet, so `rgba(0, 0, 0, 0)` means that sheet did not apply and
 * the user is looking at unstyled markup on white. `fontFamily` is carried alongside purely so the
 * failure message can say what the browser fell back to — it is never asserted on, because the
 * default serif's NAME differs between an operator's macOS and CI's Linux and an assertion on it
 * would be a check that means something different in each place.
 */
declare function getComputedStyle(element: unknown): {
  readonly backgroundColor: string
  readonly fontFamily: string
}
