/**
 * Shared retro header: building SVG on top, "INDIGO HQ" block lettering in
 * a cool-blue gradient, and the tagline below. Used by the Welcome route
 * and (future) install wizard headers.
 */

import BuildingSvg from "@/routes/Welcome/BuildingSvg";

interface RetroHeaderProps {
  tagline?: string;
}

const RetroHeader = ({
  tagline = "Personal OS for AI Workers",
}: RetroHeaderProps) => {
  return (
    <header
      className="flex flex-col items-center gap-4 pt-10 pb-4 select-none"
      data-testid="retro-header"
    >
      <BuildingSvg />
      <h1
        className="retro-heading-block text-5xl md:text-6xl"
        data-testid="retro-heading"
      >
        INDIGO HQ
      </h1>
      <p className="text-sm text-zinc-400 font-mono tracking-wider">
        {tagline}
      </p>
    </header>
  );
};

export default RetroHeader;
