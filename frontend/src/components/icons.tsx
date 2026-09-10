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
export const IconRect = ({ size = 17, className }: P) => svg(<rect x="4" y="6" width="16" height="12" rx="1" />, size, className);
export const IconCircle = ({ size = 17, className }: P) => svg(<circle cx="12" cy="12" r="8" />, size, className);
export const IconPolygon = ({ size = 17, className }: P) => svg(<path d="M12 3 20 9.5 17 20H7L4 9.5Z" />, size, className);
export const IconArrow = ({ size = 17, className }: P) => svg(<><path d="M4 12h14" /><path d="m13 7 5 5-5 5" /></>, size, className);
/** A door leaf and the arrow of someone walking out through it: the
 *  building's main entrance. */
export const IconDoorMain = ({ size = 17, className }: P) =>
  svg(<><path d="M5 3h4v18H5z" /><path d="M11 12h7" /><path d="m15 8 4 4-4 4" /></>, size, className);
/** The same door, dashed: a secondary one -- garage, service, deck. */
export const IconDoorSide = ({ size = 17, className }: P) =>
  svg(<><path d="M5 3h4v18H5z" strokeDasharray="2 1.6" /><path d="M11 12h7" /><path d="m15 8 4 4-4 4" /></>, size, className);
export const IconMagnet = ({ size = 17, className }: P) =>
  svg(
    <>
      <path d="M6 4v8a6 6 0 0 0 12 0V4" />
      <path d="M6 4h4v8a2 2 0 0 0 4 0V4h4" />
    </>,
    size,
    className,
  );
export const IconSuggest = ({ size = 17, className }: P) =>
  svg(
    <>
      <path d="M4 17h6" />
      <path d="m8 14 3 3-3 3" />
      <path d="M14 7h6" />
      <path d="m18 4 3 3-3 3" />
    </>,
    size,
    className,
  );
/** A sparkle: the search/generate action, distinct from `IconSuggest`'s
 *  arrow-and-corner (which only proposes doors) -- this one proposes an
 *  arrangement. */
export const IconGenerate = ({ size = 17, className }: P) =>
  svg(
    <>
      <path d="M12 3v5M12 16v5M3 12h5M16 12h5" />
      <path d="m6 6 2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    </>,
    size,
    className,
  );
export const IconUndo = ({ size = 17, className }: P) =>
  svg(<><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>, size, className);
export const IconRedo = ({ size = 17, className }: P) =>
  svg(<><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></>, size, className);
export const IconLayersUp = ({ size = 17, className }: P) =>
  svg(<><path d="m12 3 9 5-9 5-9-5z" /><path d="M12 21v-6" /><path d="m9 18 3 3 3-3" /></>, size, className);
export const IconCarveAuto = ({ size = 17, className }: P) =>
  svg(<><path d="M4 5h9v9H4z" /><path d="M10 10h10v10H10z" /></>, size, className);
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
export const IconTick = ({ size = 14, className }: P) => svg(<path d="M20 6 9 17l-5-5" />, size, className);
/** Two footprints, one ahead of the other: circulation. */
export const IconFootprints = ({ size = 17, className }: P) =>
  svg(
    <>
      <ellipse cx="8.1" cy="6.6" rx="2.05" ry="2.7" transform="rotate(-18 8.1 6.6)" />
      <ellipse cx="16.3" cy="12.3" rx="2.05" ry="2.7" transform="rotate(14 16.3 12.3)" />
      <ellipse cx="7.4" cy="18" rx="2.05" ry="2.7" transform="rotate(-10 7.4 18)" />
    </>,
    size,
    className,
  );
export const IconEye = ({ size = 14, className }: P) =>
  svg(
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="2.7" />
    </>,
    size,
    className,
  );
export const IconEyeOff = ({ size = 14, className }: P) =>
  svg(
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17.7 17.7 0 0 1-3.4 4.3M6.8 6.8C4 8.6 2 12 2 12s3.6 7 10 7c1.4 0 2.6-.3 3.7-.8" />
      <path d="M9.9 10a2.7 2.7 0 0 0 3.9 3.7" />
    </>,
    size,
    className,
  );
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
