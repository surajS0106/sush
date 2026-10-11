// How `artifact_write` calls and web citations appear inside a message.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { DynamicToolUIPart } from "ai";
import { FileIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { toast } from "sonner";
import { defaultComponents, type Components, type ExtraProps } from "streamdown";

import { ToolResultRow } from "@/components/tool-approval-card";
import { Artifact, type Version } from "@/components/ui/Artifact";
import { Citation, SourceList } from "@/components/ui/Sources";
import type { ArtifactView } from "@/lib/artifacts";
import { isCitationText, type CitedSource } from "@/lib/citations";
import { api, errorMessage } from "@/lib/tauri";

// --- artifacts ---------------------------------------------------------------------

export function ArtifactPart({ part, view }: { part: DynamicToolUIPart; view?: ArtifactView }) {
  if (part.state === "output-error") {
    return (
      <ToolResultRow
        error
        detail={part.errorText}
        label={
          <>
            <FileIcon className="size-4 shrink-0" />
            <span className="line-clamp-1 text-left">Couldn't show the artifact</span>
          </>
        }
      />
    );
  }
  if (!view) return null;
  return (
    <Artifact
      className="w-full"
      title={view.filename}
      versions={view.versions}
      generating={part.state === "input-streaming"}
      onDownload={(version) => void saveArtifact(view.filename, version)}
    />
  );
}

async function saveArtifact(filename: string, version: Version) {
  try {
    await api.saveTextFileAs(filename, version.code);
  } catch (e) {
    toast.error(`Couldn't save ${filename}: ${errorMessage(e)}`);
  }
}

// --- citations ---------------------------------------------------------------------

const DefaultLink = defaultComponents.a;

/** Markdown overrides that render `[cite](url)` links as numbered citation markers. */
export function citationComponents(sources: CitedSource[]): Components {
  return {
    a: (props: ComponentProps<"a"> & ExtraProps) => {
      if (!isCitationText(props.children)) return DefaultLink ? <DefaultLink {...props} /> : <a {...props} />;
      const source = sources.find((s) => sameUrl(s.url, props.href));
      return source ? <Citation n={source.n} title={source.title} /> : null;
    },
  };
}

export function CitedSourceList({ sources }: { sources: CitedSource[] }) {
  return <SourceList sources={sources} onOpen={(s) => s.url && void openUrl(s.url)} />;
}

/** The renderer may re-encode hrefs, so compare decoded forms. */
function sameUrl(url: string, href: string | undefined) {
  if (!href) return false;
  if (href === url) return true;
  try {
    return decodeURI(href) === url || href === encodeURI(url);
  } catch {
    return false;
  }
}
