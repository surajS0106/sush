// AI Elements' Image (https://elements.ai-sdk.dev/components/image): shows a
// generated image. Besides the upstream base64 form it takes a `src`, since
// generated images here are kept as blobs and served on `sushblob:`.

import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type Source = { base64: string; mediaType: string; src?: never } | { src: string; base64?: never; mediaType?: string };

export type ImageProps = Source & Omit<ComponentProps<"img">, "src">;

export const Image = ({ base64, mediaType, src, className, alt, ...props }: ImageProps) => (
  <img
    {...props}
    alt={alt}
    className={cn("h-auto max-w-full overflow-hidden rounded-md", className)}
    src={src ?? `data:${mediaType};base64,${base64}`}
  />
);
