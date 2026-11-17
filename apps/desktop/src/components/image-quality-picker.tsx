// The composer's image quality control, shown in an image chat in place of the
// thinking control (no chat model runs there): how much detail gpt-image draws.
// The same setting as Settings → Images → Quality. Hidden for models without it.
// The menu is portalled (Radix), since the composer clips what overflows it.

import { ChevronUpIcon, SparklesIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { effectiveQuality, QUALITY_LABELS, qualityLevels, setImageSettings, takesQuality, type ImageSettings } from "@/lib/images";
import type { ImageQuality } from "@/lib/tauri";

export function ImageQualityPicker({ image }: { image: ImageSettings | null }) {
  if (!image || !takesQuality(image.model)) return null;
  const value = effectiveQuality(image);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Image quality: ${QUALITY_LABELS[value].label}`}
        title="How much detail the image model draws"
        className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground dark:hover:bg-white/10"
      >
        <SparklesIcon className="size-3.5 shrink-0" />
        <span className="hidden sm:inline">{QUALITY_LABELS[value].label}</span>
        <ChevronUpIcon className="size-3.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-56">
        <DropdownMenuLabel>Image quality</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(quality) => setImageSettings({ quality: quality as ImageQuality })}>
          {qualityLevels(image.model).map((q) => (
            <DropdownMenuRadioItem key={q} value={q}>
              <span>{QUALITY_LABELS[q].label}</span>
              {QUALITY_LABELS[q].hint && <span className="text-xs text-muted-foreground">{QUALITY_LABELS[q].hint}</span>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
