/**
 * Pure helpers shared by the home widget, the full plugin page, and
 * tests. No React, no DOM — keep it that way so `bun test` can
 * exercise the URL-substitution and chip-expansion paths directly.
 */

export interface LinkTemplateLike {
  id: string;
  name: string;
  description?: string;
  urlTemplate: string;
  suffixGroup?: string;
  steamOnly?: boolean;
  builtin: boolean;
  enabled: boolean;
}

export interface GamePinsLike {
  pinnedTemplateIds: string[];
  customLinks: { name: string; url: string }[];
}

export interface QuickLinksStorageLike {
  templates: LinkTemplateLike[];
  suffixes: Record<string, string[]>;
  hidden: string[];
}

export interface RenderedChip {
  key: string;
  label: string;
  url: string;
  /** Source template id, or `"custom"` for per-game custom links.
   *  The landing page uses this to look up the description when
   *  rendering cards. */
  templateId: string;
  /** Static description for the source template (built-ins all carry
   *  one). Empty for custom links and for templates that don't have a
   *  description set; the card UI falls back to the URL host in that
   *  case. */
  description: string;
}

/**
 * Steam app ids fit in 31 bits (the high bit is always clear for real
 * apps). Non-Steam shortcut appids have the top bit set, so they're
 * >= 2^31. Used to gate `steamOnly` templates (ProtonDB / SteamDB
 * etc.) so they don't 404 for shortcut games.
 */
export function isSteamApp(appId: number): boolean {
  return appId > 0 && appId < 0x80000000;
}

/**
 * Substitute `{appId} / {name} / {name_raw} / {suffix}` into a URL
 * template. Order matters — `{name_raw}` is replaced before `{name}`
 * so the longer key wins (otherwise `{name}` would chew off the
 * `{name_` prefix and leave a stray `_raw}`).
 */
export function renderUrl(
  template: string,
  vars: { appId: number; name: string; suffix?: string },
): string {
  return template
    .replace(/\{appId\}/g, String(vars.appId))
    .replace(/\{name_raw\}/g, vars.name)
    .replace(/\{name\}/g, encodeURIComponent(vars.name))
    .replace(/\{suffix\}/g, encodeURIComponent(vars.suffix ?? ""));
}

/**
 * Order: pinned templates → remaining enabled templates → per-game
 * custom links (raw URLs).
 *
 * Templates with `suffixGroup` expand into one chip per suffix. An
 * empty suffix list collapses back to a single chip (with `{suffix}`
 * substituted as the empty string) so a user-emptied YouTube suffix
 * list doesn't make the chip vanish entirely.
 */
export function buildChips(
  storage: QuickLinksStorageLike,
  appId: number,
  gameName: string,
  pins: GamePinsLike | undefined,
): RenderedChip[] {
  const visibleTemplates = storage.templates.filter(
    (t) =>
      t.enabled &&
      !storage.hidden.includes(t.id) &&
      (!t.steamOnly || isSteamApp(appId)),
  );
  const pinned = pins?.pinnedTemplateIds ?? [];
  const ordered = [
    ...pinned
      .map((id) => visibleTemplates.find((t) => t.id === id))
      .filter((t): t is LinkTemplateLike => t !== undefined),
    ...visibleTemplates.filter((t) => !pinned.includes(t.id)),
  ];

  const chips: RenderedChip[] = [];
  for (const tpl of ordered) {
    const description = tpl.description ?? "";
    if (tpl.suffixGroup) {
      const suffixes = storage.suffixes[tpl.suffixGroup] ?? [];
      if (suffixes.length === 0) {
        chips.push({
          key: tpl.id,
          label: tpl.name,
          templateId: tpl.id,
          description,
          url: renderUrl(tpl.urlTemplate, {
            appId,
            name: gameName,
            suffix: "",
          }),
        });
      } else {
        for (const s of suffixes) {
          chips.push({
            key: `${tpl.id}::${s}`,
            label: `${tpl.name} · ${s}`,
            templateId: tpl.id,
            description,
            url: renderUrl(tpl.urlTemplate, {
              appId,
              name: gameName,
              suffix: s,
            }),
          });
        }
      }
    } else {
      chips.push({
        key: tpl.id,
        label: tpl.name,
        templateId: tpl.id,
        description,
        url: renderUrl(tpl.urlTemplate, { appId, name: gameName }),
      });
    }
  }

  for (const [i, link] of (pins?.customLinks ?? []).entries()) {
    chips.push({
      key: `custom::${i}`,
      label: link.name,
      templateId: "custom",
      description: "",
      url: link.url,
    });
  }
  return chips;
}
