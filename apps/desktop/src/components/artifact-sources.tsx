// How `artifact_write` calls and web citations appear inside a message.

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
import { isPassageUrl, openPassage, passageKey } from "@/lib/notebooks";
import { meetingOfLink, openLink } from "@/lib/yammer";
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
      // A Yammer meeting opens in Yammer, not the browser.
      if (meetingOfLink(props.href) !== null && !isCitationText(props.children)) {
        return (
          <a
            href={props.href}
            title="Open this meeting in Yammer"
            className="cursor-pointer font-medium text-primary underline underline-offset-4"
            onClick={(e) => {
              e.preventDefault();
              openLink(props.href!);
            }}
          >
            {props.children}
          </a>
        );
      }
      if (!isCitationText(props.children)) return DefaultLink ? <DefaultLink {...props} /> : <a {...props} />;
      const source = sources.find((s) => sameUrl(s.url, props.href));
      if (!source) return null;
      // A notebook passage opens in the notebook's viewer, highlighting the words this citation quotes.
      const href = props.href ? safeDecode(props.href) : "";
      if (isPassageUrl(source.url)) return <Citation n={source.n} title={source.title} onOpen={() => openPassage(href || source.url)} />;
      if (meetingOfLink(source.url) !== null) return <Citation n={source.n} title={source.title} onOpen={() => openLink(source.url)} />;
      return <Citation n={source.n} title={source.title} />;
    },
  };
}

export function CitedSourceList({ sources }: { sources: CitedSource[] }) {
  return <SourceList sources={sources} onOpen={(s) => s.url && (isPassageUrl(s.url) ? openPassage(s.url) : openLink(s.url))} />;
}

function safeDecode(s: string) {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** The renderer may re-encode hrefs, so compare decoded forms. */
function sameUrl(url: string, href: string | undefined) {
  if (!href) return false;
  if (href === url) return true;
  // A passage is one source whatever words a citation quotes from it.
  if (isPassageUrl(url)) return passageKey(safeDecode(href)) === passageKey(url);
  try {
    return decodeURI(href) === url || href === encodeURI(url);
  } catch {
    return false;
  }
}
