// A generated image, opened large: the picture fitted to the window on a dark
// backdrop, with its prompt, the model that drew it and Save underneath.
// Escape, a click on the backdrop or the close button shuts it.

import { DownloadIcon, XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";

export function ImageLightbox({
  src,
  alt,
  caption,
  detail,
  onSave,
  children,
}: {
  src: string;
  alt: string;
  caption?: string;
  /** A second, quieter line: who drew it. */
  detail?: string;
  onSave?: () => void;
  /** What opens it, usually the thumbnail. */
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger asChild>{children}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 p-6 outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          {/* The content fills the window, so clicks around the picture close it like the backdrop does. */}
          <DialogPrimitive.Close asChild>
            <div className="absolute inset-0" aria-hidden />
          </DialogPrimitive.Close>
          <DialogPrimitive.Title className="sr-only">{caption || alt || "Image"}</DialogPrimitive.Title>
          {/* Actions in the window's corner, clear of the picture, as image viewers put them. */}
          <div className="absolute top-4 right-4 z-10 flex items-center gap-2 text-white">
            {onSave && (
              <button
                type="button"
                onClick={onSave}
                title="Save image"
                className="flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-3.5 text-sm font-medium backdrop-blur hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
              >
                <DownloadIcon className="size-4" />
                Save
              </button>
            )}
            <DialogPrimitive.Close
              aria-label="Close"
              title="Close (Esc)"
              className="flex size-9 items-center justify-center rounded-full bg-white/10 backdrop-blur hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
            >
              <XIcon className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <img
            src={src}
            alt={alt}
            className="relative mt-10 max-h-[calc(100vh-11rem)] max-w-full rounded-lg object-contain shadow-2xl"
          />
          {(caption || detail) && (
            <div className="relative max-w-3xl text-center">
              {caption && <p className="line-clamp-2 text-sm text-white/90">{caption}</p>}
              {detail && <p className="mt-1 truncate text-xs text-white/55">{detail}</p>}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
