// Shown while "Compact now" summarises a chat (`lib/compact.ts`): Sushi hops
// into a takeout box, the lid drops on, a nori band wraps it and a sparkle
// pops, then it starts again. Pixel art on Sushi's own grid; the motion is the
// `pack-*` keyframes in index.css, and with reduced motion it rests packed.

import { PixelRows, SushiPixels } from "@/components/mascot";
import { cn } from "@/lib/utils";

const BOX = {
  A: "#e2ad6f", // kraft rim, light
  a: "#c98f52", // kraft
  d: "#a8703a", // kraft shade
};

// The tray's front, drawn over Sushi's lower half so it sits inside.
const TRAY = [
  "AAAAAAAAAAAAAAAAAAAA",
  "daaaaaaaaaaaaaaaaaad",
  "daaaaaaaaaaaaaaaaaad",
  "daaaaaaaaaaaaaaaaaad",
  "daaaaaaaaaaaaaaaaaad",
  ".daaaaaaaaaaaaaaaad.",
  "..dddddddddddddddd..",
];

const LID = [
  "....AAAAAAAAAAAA....",
  "..AAaaaaaaaaaaaaAA..",
  ".AaaaaaaaaaaaaaaaaA.",
  "AaaaaaaaaaaaaaaaaaaA",
  "AaaaaaaaaaaaaaaaaaaA",
  "AaaaaaaaaaaaaaaaaaaA",
  "dddddddddddddddddddd",
];

// The band round the box, with a salmon sticker where it crosses the lid.
const BAND = ["NN", "NN", "NN", "NN", "NN", "NN", "NN", "NN", "NN", "NN", "NN", "NN", "NN", "NN"];
const STICKER = [".SS.", "SsSS", "SSSS", ".SS."];
const STAR = [".Y.", "YYY", ".Y."];

export function CompactSushi({ size = 48, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-hidden
      className={cn("sushi-pack shrink-0 overflow-hidden", className)}
    >
      <g data-pack="hop">
        {/* CSS transforms replace the attribute, so placement goes on an inner group. */}
        <g data-pack="sushi">
          <g transform="translate(4 8)">
            <SushiPixels />
          </g>
        </g>
        <g transform="translate(2 14)">
          <PixelRows rows={TRAY} colors={BOX} />
        </g>
        <g data-pack="lid">
          <g transform="translate(2 7)">
            <PixelRows rows={LID} colors={BOX} />
          </g>
        </g>
        <g data-pack="band">
          <g transform="translate(11 7)">
            <PixelRows rows={BAND} />
          </g>
          <g transform="translate(10 9)">
            <PixelRows rows={STICKER} />
          </g>
        </g>
      </g>
      <g data-pack="star">
        <g transform="translate(19 2)">
          <PixelRows rows={STAR} />
        </g>
      </g>
    </svg>
  );
}
