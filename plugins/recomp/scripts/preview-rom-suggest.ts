#!/usr/bin/env bun
import { suggestRomsForTitle } from "../lib/rom-suggest";

const ROM_DIR = "/run/media/srsholmes/259f1e43-c2ec-4b1c-a5e0-0caa6aaf55ab/Emulation/roms";

const cases = [
  { title: "Super Mario 64 (Render96 HD)", exts: ["z64", "n64", "v64"] },
  { title: "Super Mario 64 (Render96 + Ray Tracing)", exts: ["z64", "n64", "v64"] },
  { title: "The Legend of Zelda: Ocarina of Time", exts: ["z64"] },
  { title: "The Legend of Zelda: Twilight Princess", exts: ["iso"] },
  { title: "Sonic the Hedgehog 1 & 2", exts: ["md", "smd", "bin"] },
];

for (const { title, exts } of cases) {
  console.log(`\n=== ${title} ===`);
  const t0 = performance.now();
  const hits = await suggestRomsForTitle(title, ROM_DIR, exts);
  const ms = (performance.now() - t0).toFixed(0);
  if (hits.length === 0) {
    console.log(`  (no suggestions in ${ms}ms)`);
  } else {
    console.log(`  ${hits.length} suggestion(s) in ${ms}ms:`);
    hits.forEach((h, i) =>
      console.log(`    ${i + 1}. score=${h.score.toString().padStart(6)} ${h.basename}`),
    );
  }
}
