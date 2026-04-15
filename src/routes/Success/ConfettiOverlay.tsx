/**
 * ConfettiOverlay — pure-CSS celebratory animation for the Success screen.
 *
 * No canvas, no runtime dependencies: just 24 absolutely-positioned
 * `<span>` elements with staggered `animation-delay` values. The
 * keyframes live in `retro.css`; this component only seeds positions
 * and colors at mount time.
 *
 * # Why not a library
 *
 * canvas-confetti + its peers pull in ~20KB gzipped and wire into the
 * render loop. For a one-shot celebration on a terminal screen the
 * installer already rendered, pure CSS is both faster to ship and
 * nicer on battery. The animation runs exactly once and the component
 * unmounts itself after the longest delay finishes (via `onAnimationEnd`
 * on the last piece).
 *
 * # Accessibility
 *
 * Respects `prefers-reduced-motion`: when the user has reduced-motion
 * turned on, we render nothing at all rather than a static grid of
 * confetti dots.
 */

import { useMemo, useRef } from "react";

interface ConfettiOverlayProps {
  /** Fires once when the last confetti piece finishes its animation. */
  onDone?: () => void;
}

const PIECE_COUNT = 24;
const COLORS = [
  "#ff4d6d",
  "#ffd23f",
  "#06d6a0",
  "#118ab2",
  "#8338ec",
  "#fb8500",
];

// Pseudorandom positions seeded at construction time so the confetti
// doesn't re-randomize on every React rerender. `useMemo` with an
// empty dep array is the canonical "compute once at mount" idiom.
interface Piece {
  left: number; // vw
  color: string;
  delay: number; // seconds
  rotation: number; // degrees
}

function makePieces(): Piece[] {
  const pieces: Piece[] = [];
  for (let i = 0; i < PIECE_COUNT; i++) {
    pieces.push({
      left: Math.random() * 100,
      color: COLORS[i % COLORS.length]!,
      delay: Math.random() * 0.6,
      rotation: Math.random() * 360,
    });
  }
  return pieces;
}

const ConfettiOverlay = ({ onDone }: ConfettiOverlayProps) => {
  const pieces = useMemo(makePieces, []);

  // Counter lives in a ref, not state — incrementing it doesn't drive
  // any visual change, so re-rendering 24 times (once per piece) is
  // pure waste. The ref still survives re-renders triggered by parent
  // updates, which is all we need.
  const doneCountRef = useRef(0);

  // `prefers-reduced-motion: reduce` → render nothing.
  const prefersReduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (prefersReduced) {
    return null;
  }

  const handleAnimationEnd = () => {
    doneCountRef.current += 1;
    if (doneCountRef.current === PIECE_COUNT) {
      onDone?.();
    }
  };

  return (
    <div
      className="retro-confetti-overlay"
      aria-hidden="true"
      data-testid="confetti-overlay"
    >
      {pieces.map((p, i) => (
        <span
          key={i}
          className="retro-confetti-piece"
          data-testid={`confetti-piece-${i}`}
          style={{
            left: `${p.left}vw`,
            backgroundColor: p.color,
            animationDelay: `${p.delay}s`,
            transform: `rotate(${p.rotation}deg)`,
          }}
          onAnimationEnd={handleAnimationEnd}
        />
      ))}
    </div>
  );
};

export default ConfettiOverlay;
