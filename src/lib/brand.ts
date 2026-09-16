/**
 * The product's name and the few sentences that go with it, in one place.
 *
 * Everything client-facing reads from here — the sign-in page, the shell,
 * the page titles, the emails — so renaming the product is a one-file change
 * and no surface can drift to an older name.
 */
export const BRAND = {
  name: 'Webamend',
  /** The promise, in the client's terms. */
  tagline: 'Say what you want changed. See it before it goes live.',
  /** One line for the browser tab and link previews. */
  description:
    'Describe a change to your website in your own words, look at a private preview, and publish it with one press.',
} as const;
