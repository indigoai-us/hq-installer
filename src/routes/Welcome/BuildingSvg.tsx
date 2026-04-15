/**
 * Layered SVG "office building" header. Translates the ASCII-art building
 * from `create-hq-tui` into a scalable vector:
 *
 *   - Flat base + two columns of lit windows
 *   - Antenna + radio wave arcs at the top
 *   - Each window is a `<rect>` with a pulse animation via retro.css
 *
 * The building renders into the viewport at its natural aspect ratio; the
 * parent container controls the total size via `width` / `height` props.
 */

interface BuildingSvgProps {
  width?: number;
  height?: number;
  "aria-label"?: string;
}

const BuildingSvg = ({
  width = 220,
  height = 160,
  "aria-label": ariaLabel = "Indigo HQ office building",
}: BuildingSvgProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 220 160"
      width={width}
      height={height}
      role="img"
      aria-label={ariaLabel}
      data-testid="retro-building-svg"
    >
      {/* Sky gradient backdrop (subtle) */}
      <defs>
        <linearGradient id="retro-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0a0e18" />
          <stop offset="100%" stopColor="#05070c" />
        </linearGradient>
        <linearGradient id="retro-facade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1a2237" />
          <stop offset="100%" stopColor="#111725" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width="220" height="160" fill="url(#retro-sky)" />

      {/* Antenna stem */}
      <line
        x1="110"
        y1="10"
        x2="110"
        y2="36"
        stroke="#49c7ff"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* Radio wave arcs */}
      <path
        d="M 92 22 Q 110 4 128 22"
        fill="none"
        stroke="#49c7ff"
        strokeWidth="1.5"
        opacity="0.8"
      />
      <path
        d="M 84 26 Q 110 -4 136 26"
        fill="none"
        stroke="#49c7ff"
        strokeWidth="1"
        opacity="0.5"
      />
      {/* Antenna dot */}
      <circle cx="110" cy="10" r="3" fill="#89e6ff" />

      {/* Building facade */}
      <rect
        x="40"
        y="40"
        width="140"
        height="108"
        fill="url(#retro-facade)"
        stroke="#2f6cff"
        strokeWidth="1.25"
      />

      {/* Roof trim */}
      <rect x="36" y="36" width="148" height="6" fill="#2f6cff" />

      {/* Three rows × four windows */}
      {[0, 1, 2].map((row) => (
        <g key={`row-${row}`}>
          {[0, 1, 2, 3].map((col) => {
            const x = 54 + col * 28;
            const y = 54 + row * 28;
            const variantClass =
              (row + col) % 3 === 0
                ? "retro-window retro-window--slow"
                : (row + col) % 3 === 1
                ? "retro-window"
                : "retro-window retro-window--fast";
            return (
              <rect
                key={`win-${row}-${col}`}
                x={x}
                y={y}
                width={18}
                height={16}
                className={variantClass}
                rx={1}
                data-testid={`retro-window-${row}-${col}`}
              />
            );
          })}
        </g>
      ))}

      {/* Front door */}
      <rect x="100" y="126" width="20" height="22" fill="#49c7ff" opacity="0.9" />
      <rect x="100" y="126" width="20" height="22" fill="none" stroke="#89e6ff" strokeWidth="1" />

      {/* Ground */}
      <rect x="0" y="148" width="220" height="12" fill="#0a0e18" />
      <line
        x1="0"
        y1="148"
        x2="220"
        y2="148"
        stroke="#2f6cff"
        strokeWidth="1"
        opacity="0.6"
      />
    </svg>
  );
};

export default BuildingSvg;
