/** Line icons, drawn rather than typed: emoji and dingbats do not scale or
 *  recolour, and a plan tool should not carry them. 24px grid, 1.8 stroke. */
type P = { size?: number; className?: string };

const svg = (d: React.ReactNode, size: number, className?: string) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
    focusable="false"
    style={{ flex: "none" }}
  >
    {d}
  </svg>
);

export const IconCursor = ({ size = 17, className }: P) => svg(<path d="m4 3 7 17 2.5-6.5L20 11z" />, size, className);
export const IconHand = ({ size = 17, className }: P) =>
  svg(
    <>
      <path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M14 11V6.5a1.5 1.5 0 0 1 3 0V13" />
      <path d="M17 8.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a7 7 0 0 1-6-4l-1.6-3a1.5 1.5 0 0 1 2.6-1.5L8 14" />
    </>,
    size,
    className,
  );
export const IconGrid = ({ size = 17, className }: P) =>
  svg(
    <>
      <path d="M3 3h18v18H3z" />
      <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
    </>,
    size,
    className,
  );
export const IconLayers = ({ size = 17, className }: P) =>
  svg(
    <>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 14 9 5 9-5" />
    </>,
    size,
    className,
  );
export const IconReset = ({ size = 17, className }: P) =>
  svg(
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </>,
    size,
    className,
  );
export const IconMinus = ({ size = 15, className }: P) => svg(<path d="M5 12h14" />, size, className);
export const IconPlus = ({ size = 15, className }: P) => svg(<path d="M12 5v14M5 12h14" />, size, className);
export const IconFit = ({ size = 15, className }: P) =>
  svg(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />, size, className);
export const IconOrbit = ({ size = 14, className }: P) =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <ellipse cx="12" cy="12" rx="10" ry="4.5" />
      <ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(60 12 12)" />
    </>,
    size,
    className,
  );
export const IconSend = ({ size = 16, className }: P) =>
  svg(
    <>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </>,
    size,
    className,
  );
export const IconTick = ({ size = 14, className }: P) => svg(<path d="M20 6 9 17l-5-5" />, size, className);
export const IconWarn = ({ size = 14, className }: P) =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16.4v.01" />
    </>,
    size,
    className,
  );
