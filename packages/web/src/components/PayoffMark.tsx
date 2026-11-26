/**
 * Official Payoff monochrome brand mark (payoff-mark.svg / payoff-lockup-reversed.svg).
 * Monochrome currentColor (defaults to official reversed off-white #F6F7F5 on dark),
 * no gradients, circles, shadows, or multi-color strokes.
 */
export function PayoffMark({
  size = 24,
  className = "text-[#f6f7f5]",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M1 15.25 L6.275 15.25 L16.275 5.25 L23 5.25 L23 8.75 L17.725 8.75 L7.725 18.75 L1 18.75 Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Official Payoff reversed brand lockup (#F6F7F5 mark + wordmark) */
export function PayoffLockup({
  markSize = 22,
  className = "",
}: {
  markSize?: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 text-[#f6f7f5] ${className}`}
    >
      <PayoffMark size={markSize} className="text-[#f6f7f5] shrink-0" />
      <span className="text-[19px] font-semibold tracking-[-0.025em] leading-none">
        Payoff
      </span>
    </span>
  );
}

/** Tether USDT collateral token icon (/usdt.svg) */
export function UsdtIcon({
  size = 18,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src="/usdt.svg"
      alt="USDT"
      width={size}
      height={size}
      className={`inline-block shrink-0 rounded-full ${className}`}
    />
  );
}
