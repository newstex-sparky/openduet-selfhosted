import {
  AudioPlayerApi,
  IconApi,
  ImageApi,
  VideoApi,
} from "@a2ui/web_core/v0_9/basic_catalog";
import type { CSSProperties } from "react";
import { createReactComponent } from "../adapter";
import type { ComponentViewProps } from "../types";

const FIT: Record<string, CSSProperties["objectFit"]> = {
  contain: "contain",
  cover: "cover",
  fill: "fill",
  none: "none",
  scaleDown: "scale-down",
};

const IMAGE_SIZE: Record<string, CSSProperties> = {
  icon: { width: "1.5rem", height: "1.5rem" },
  avatar: { width: "2.5rem", height: "2.5rem", borderRadius: "9999px" },
  smallFeature: { width: "8rem" },
  mediumFeature: { width: "16rem" },
  largeFeature: { width: "100%" },
  header: { width: "100%", maxHeight: "12rem" },
};

function ImageView({ props }: ComponentViewProps<typeof ImageApi>) {
  return (
    <img
      src={String(props.url ?? "")}
      alt={typeof props.description === "string" ? props.description : ""}
      style={{
        ...IMAGE_SIZE[props.variant ?? "mediumFeature"],
        maxWidth: "100%",
        objectFit: FIT[props.fit ?? "cover"],
      }}
    />
  );
}

/**
 * `Icon` accepts either a name from the A2UI icon set or a raw SVG path. Only the path form can be
 * drawn without shipping an icon font, so a named icon becomes a labelled placeholder that still
 * announces itself to a screen reader rather than leaving a silent gap.
 */
function IconView({ props }: ComponentViewProps<typeof IconApi>) {
  const name = props.name;
  if (name && typeof name === "object" && "svgPath" in name) {
    return (
      <svg
        viewBox="0 0 24 24"
        width="1.25em"
        height="1.25em"
        role="img"
        aria-hidden="true"
      >
        <path d={String(name.svgPath)} fill="currentColor" />
      </svg>
    );
  }
  return (
    <span
      role="img"
      aria-label={typeof name === "string" ? name : "icon"}
      style={{ display: "inline-block", width: "1.25em", height: "1.25em" }}
    />
  );
}

/**
 * An A2UI `Video` carries a url and nothing else — no caption track, no poster, no transcript. The
 * element is still drawn as a real `<video controls>` so the browser supplies its own controls and
 * keyboard support; the missing captions are a limit of the payload, not of this markup.
 */
function VideoView({ props }: ComponentViewProps<typeof VideoApi>) {
  return (
    // biome-ignore lint/a11y/useMediaCaption: the A2UI Video component's schema has only `url`; there is no caption source in the payload to point a <track> at.
    <video
      controls
      src={String(props.url ?? "")}
      style={{ maxWidth: "100%", borderRadius: "var(--radius)" }}
    />
  );
}

function AudioPlayerView({ props }: ComponentViewProps<typeof AudioPlayerApi>) {
  return (
    <figure style={{ margin: 0, display: "grid", gap: "0.25rem" }}>
      {/* biome-ignore lint/a11y/useMediaCaption: the A2UI AudioPlayer component's schema has only `url` and `description` — no caption file to reference. */}
      <audio controls src={String(props.url ?? "")} style={{ width: "100%" }} />
      {typeof props.description === "string" ? (
        <figcaption>{props.description}</figcaption>
      ) : null}
    </figure>
  );
}

export const Image = createReactComponent(ImageApi, ImageView);
export const Icon = createReactComponent(IconApi, IconView);
export const Video = createReactComponent(VideoApi, VideoView);
export const AudioPlayer = createReactComponent(
  AudioPlayerApi,
  AudioPlayerView,
);
