import type { CSSProperties } from "react";
import { cn } from "../lib/utils";
import { TRAILING_GLYPH_BOX_CLASS } from "./StatusGlyph";
import { useProviderMark } from "./useProviderMark";

function providerMaskStyle(logoUrl: string): CSSProperties {
  const maskImage = `url(${JSON.stringify(logoUrl)})`;
  return {
    maskImage,
    maskPosition: "center",
    maskRepeat: "no-repeat",
    maskSize: "contain",
    WebkitMaskImage: maskImage,
    WebkitMaskPosition: "center",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskSize: "contain",
  };
}

/**
 * B23-B25. The agent a thread runs on, resolved from bb's live provider
 * directory.
 *
 * Three cases, not two. Provider ids are plugin-contributed (`acp-*`), so no
 * hardcoded id map may exist (B24):
 *
 * 1. A logo plus `strings.iconTint` — masked and filled per theme.
 * 2. A logo with no tint — masked and filled `bg-muted-foreground/70`, the
 *    tone every other monochrome glyph in the row uses (§7's B23 ruling;
 *    `strings` and `iconTint` are two independent optionals).
 * 3. No logo, or a provider absent from the directory — a neutral dot, never
 *    nothing and never a broken image, with `providerId` as the accessible
 *    name when there is no `displayName` to use (B25).
 *
 * It reads the directory itself rather than taking a prop, because the
 * directory is a host-cached context read shared by every row, not a per-row
 * subscription — unlike the PR hook, which `ThreadRow` owns (§6).
 *
 * `useProviderMark` puts a localStorage cache in front of that read, so a
 * reload draws last run's logos instead of waiting on the directory.
 */
export function ProviderGlyph({
  providerId,
  className,
}: {
  providerId: string;
  className?: string;
}) {
  const { mark, status } = useProviderMark(providerId);

  const box = cn(TRAILING_GLYPH_BOX_CLASS, className);
  const label = mark?.displayName ?? providerId;
  const logoUrl = mark?.logoUrl ?? null;
  const tint = mark?.iconTint;

  // B80. A loading directory is an EMPTY directory, so without this branch every
  // row falls into case 3 below — and that dot means "bb does not know this
  // provider", not "bb has not answered yet". Measured on a real reload:
  // `GET /api/v1/system/providers` took 5.97s, so 41 rows drew the wrong mark for
  // six seconds and then flipped to logos. The box keeps its size, so nothing
  // shifts when the answer lands; only the mark is withheld.
  //
  // `error` still draws the dot on purpose: there the directory will never
  // answer, and "unknown provider" is then the true statement.
  //
  // With a cached mark for this provider the hook never reports `loading`, so
  // this branch is now the cold-start case only: a first run, a cleared store,
  // or a provider installed since the last reload.
  if (status === "loading") {
    return <span role="img" aria-label={label} className={box} />;
  }

  if (logoUrl === null) {
    return (
      <span role="img" aria-label={label} className={box}>
        <span
          aria-hidden
          data-better-sidebar-provider="dot"
          className="size-2 rounded-full bg-muted-foreground/50"
        />
      </span>
    );
  }

  const maskStyle = providerMaskStyle(logoUrl);
  return (
    <span role="img" aria-label={label} className={box}>
      {tint === undefined ? (
        <span
          aria-hidden
          data-better-sidebar-provider="mask"
          className="size-3 bg-muted-foreground/70"
          style={maskStyle}
        />
      ) : (
        <>
          <span
            aria-hidden
            data-better-sidebar-provider="mask-light"
            className="size-3 dark:hidden"
            style={{ ...maskStyle, backgroundColor: tint.light }}
          />
          <span
            aria-hidden
            data-better-sidebar-provider="mask-dark"
            className="hidden size-3 dark:block"
            style={{ ...maskStyle, backgroundColor: tint.dark }}
          />
        </>
      )}
    </span>
  );
}
