import { describe, it, expect } from "bun:test";
import { pickTileAction } from "./tile-action";

describe("pickTileAction", () => {
  it("returns Cancel during an active install regardless of status", () => {
    expect(pickTileAction({ status: "library" }, true).kind).toBe("cancel");
    expect(pickTileAction({ status: "installed" }, true).kind).toBe("cancel");
    expect(pickTileAction({ status: "imported", installed: { addedToSteam: true } }, true).kind).toBe(
      "cancel",
    );
  });

  it("returns Install for a library entry not yet installed", () => {
    const a = pickTileAction({ status: "library" }, false);
    expect(a.kind).toBe("install");
    expect(a.variant).toBe("primary");
  });

  it("returns Play for an installed game that's been added to Steam", () => {
    const a = pickTileAction({ status: "installed", installed: { addedToSteam: true } }, false);
    expect(a.kind).toBe("launch");
    expect(a.variant).toBe("primary");
    expect(a.label).toBe("Play");
  });

  it("returns Play for an imported game that's been added to Steam", () => {
    const a = pickTileAction({ status: "imported", installed: { addedToSteam: true } }, false);
    expect(a.kind).toBe("launch");
  });

  it("returns Add to Steam when installed but not yet a Steam shortcut", () => {
    const a = pickTileAction({ status: "installed", installed: { addedToSteam: false } }, false);
    expect(a.kind).toBe("add-to-steam");
    expect(a.variant).toBe("secondary");
  });

  it("returns Add to Steam when installed record is missing entirely (defensive default)", () => {
    // status="installed" but no `installed` snapshot is a transient
    // shape during reload — fall through to Add to Steam rather than
    // claiming Play.
    const a = pickTileAction({ status: "installed" }, false);
    expect(a.kind).toBe("add-to-steam");
  });
});
