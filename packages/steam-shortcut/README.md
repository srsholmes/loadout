# @loadout/steam-shortcut

Register and remove non-Steam shortcuts via Steam's running JS client.

Wraps the three-call persistence sequence (`AddShortcut` →
`SetShortcutName` → `SetShortcutLaunchOptions`) plus the
best-effort compat-tool, user-tag, and user-collection writes
that Loadout plugins (recomp, store-bridge, …) previously
hand-rolled side-by-side.

## Install

```sh
bun add @loadout/steam-shortcut
```

Workspace consumers depend on it via:

```json
"dependencies": {
  "@loadout/steam-shortcut": "workspace:*"
}
```

## API

```ts
import {
  addNonSteamShortcut,
  removeNonSteamShortcut,
  type SteamShortcutSpec,
  type SteamShortcutResult,
} from "@loadout/steam-shortcut";

const result: SteamShortcutResult = await addNonSteamShortcut({
  displayName: "Alba (Epic Games)",
  exe: "/games/alba.exe",
  args: "--fullscreen",
  platform: "windows",       // → Proton Experimental on Linux hosts
  userTag: "Epic Games",     // → sidebar dynamic group
  collectionName: "Epic Games", // → Collections tab entry
});

await removeNonSteamShortcut(result.appId);
```

`addNonSteamShortcut` throws an actionable error if
`SteamClient.Apps.AddShortcut` returns no appid — restart Steam
and retry is the right next step.

`removeNonSteamShortcut` is a no-op when Steam isn't reachable.

## Known Gaming Mode behavior

`addAppToCollection` historically silently no-ops under stock SteamOS Big
Picture Mode — BPM omits the user-collections API. The call is wrapped
in `bestEffort()` and warns rather than failing; the shortcut is still
registered correctly and the compat tool / user tag writes still apply.

If you depend on the collection write succeeding (e.g. for an emulator
launcher's "Recomp" hub), surface a Desktop-mode setup-step to the user
rather than relying on it landing in Gaming Mode.
