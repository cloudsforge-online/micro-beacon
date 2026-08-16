/**
 * Product groups — the public names.
 *
 * Split out of `estate.ts` because three files now need them and `estate.ts` imports two of those
 * three to assemble the registry; leaving the constant there would make the import graph a cycle
 * for the sake of five strings.
 *
 * **Never a service name.** The public status projection publishes the group and only the group:
 * `publicstatus.ts` exists because the service this replaces emitted `pay.rates` and
 * `hearth.seed` — internal topology — onto a pre-auth page. A group is the unit a customer can be
 * told about.
 */
export const GROUPS = {
  account: 'Account',
  wallet: 'Wallet',
  market: 'Market',
  worlds: 'Worlds',
  network: 'Network',
  // The sixth, added when the browser tier gained journeys that drive it. It is a PUBLIC product
  // name — `ui/packages/ui/src/surfaces.ts` carries the registry row and it is a switcher
  // entry — so it satisfies the rule above. A `foresight` group is what a customer can be told
  // about; the service behind it is still never published.
  foresight: 'Foresight',
  // The seventh, on the same test as the sixth and passing it for the same reason: `exchange` is a
  // registry row in `ui/packages/ui/src/surfaces.ts`, a switcher entry, and the name on the tile a
  // customer presses. What is NOT published, here as everywhere, is what sits behind it — and
  // behind this one there is no service at all. Forge Exchange is a static bundle and a pair of
  // contracts on Hearth; `deploy/scripts/surface-routes.py` carries a `# REMOVED: cf-api-exchange`
  // line saying exactly that. A group whose service set is empty is still a product.
  exchange: 'Exchange',
} as const

export type ProductGroup = (typeof GROUPS)[keyof typeof GROUPS]
