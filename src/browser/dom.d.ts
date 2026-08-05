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
 * The `<img>` tags a surface actually rendered, for `smoke.ts`'s imagery check.
 *
 * `naturalWidth` is the only member here that decides anything, and it is here for the same reason
 * the `Image` declaration below carries it: it is non-zero ONLY after Chromium's own decoder has
 * accepted the bytes. Reading it off a tag the surface rendered — rather than off one this suite
 * constructed — is what makes the assertion "the reader saw a picture" instead of "the markup
 * claims a picture". An `<img>` whose `src` 404s, whose bytes are truncated, or whose
 * `Content-Type` makes `nosniff` refuse it all report the same zero.
 *
 * `getAttribute` is here rather than a `src` property because the two differ in exactly the case
 * this check exists for: the PROPERTY resolves `src=""` to the document's own URL, so an `<img>`
 * with no source reads back as one pointing at the page. The ATTRIBUTE reads back the empty string
 * it was authored as, which is the "never had an image" case the audit had to tell apart from
 * "has one that fails to load".
 */
interface HTMLImageElement {
  readonly currentSrc: string
  readonly naturalWidth: number
  readonly complete: boolean
  readonly alt: string
  readonly loading: string
  getAttribute(name: string): string | null
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

/**
 * BJ-MED-01 asks the browser to DECODE an uploaded image, rather than to measure its length.
 *
 * `naturalWidth` is the whole reason this is here: it is non-zero only once Chromium's own decoder
 * has accepted the bytes, so reading it back is simultaneously a check that the metadata strip did
 * not corrupt the file, that the `Content-Type` is right, and that `nosniff` did not make the
 * browser refuse an image the estate served. No assertion available in this process can say that.
 *
 * Four members, added one at a time per the rule above: the two handlers, the source, and the one
 * measurement that is actually asserted on. `naturalHeight` comes with `naturalWidth` because a
 * width that matches on a height that does not is precisely the corruption worth catching.
 */
/**
 * `smoke.ts` resolves a surface's DECLARED art with the same call the client makes.
 *
 * `tessera-web/src/lib/sprites.ts` does `createImageBitmap(await res.blob())`, so the smoke tier
 * does too: a check that decoded the bytes some other way could pass on a file the product's own
 * code path rejects. Two members, per the rule at the top of this file — the dimensions are the
 * assertion, and a bitmap with a width has been through a real decoder.
 */
declare function createImageBitmap(source: unknown): Promise<{
  readonly width: number
  readonly height: number
}>

declare class Image {
  onload: (() => void) | null
  onerror: (() => void) | null
  src: string
  readonly naturalWidth: number
  readonly naturalHeight: number
}
