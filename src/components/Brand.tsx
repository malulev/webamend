import { BRAND } from '@/lib/brand';

/**
 * The mark: a W whose middle peak is a proofreader's caret, the sign for
 * "insert here". The letter is the name; the caret is what it does.
 *
 * Kept identical to the marketing site's (`Brand.tsx` there, same geometry
 * and the same two tokens) so a client who arrives from webamend.com meets
 * the same logo when they sign in. Drawn in currentColor so it sits on any
 * surface, with the caret in the accent when one is available.
 */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label={BRAND.name}
    >
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="currentColor" />
      <path
        d="M7 10.5l4.5 12.5L16 13l4.5 10L25 10.5"
        fill="none"
        stroke="var(--brand-paper, #fff)"
        strokeWidth="2.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.6 20.5L16 13l3.4 7.5"
        fill="none"
        stroke="var(--brand-accent-on-ink, #5FD4CF)"
        strokeWidth="2.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Mark plus wordmark, for headers. */
export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <span className="wordmark">
      <BrandMark size={size} className="wordmark__mark" />
      <span className="wordmark__name">{BRAND.name}</span>
    </span>
  );
}
