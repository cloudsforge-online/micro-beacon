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
} as const

export type ProductGroup = (typeof GROUPS)[keyof typeof GROUPS]
