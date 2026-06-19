import { loadBundledRegistry } from "../lib/registry";
import { FRANCHISE_GROUPS, HEADLINE_IDS } from "../lib/ranking";

function rank(tags: string[]): number {
  for (const { tag, rank } of FRANCHISE_GROUPS) if (tags.includes(tag)) return rank;
  return 3;
}

const games = loadBundledRegistry();
const sorted = [...games].sort((a, b) => {
  const d = rank(a.tags ?? []) - rank(b.tags ?? []);
  if (d) return d;
  const ai = HEADLINE_IDS.indexOf(a.id);
  const bi = HEADLINE_IDS.indexOf(b.id);
  if (ai !== bi) { if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
});

console.log(`--- top 20 of ${sorted.length} ---`);
sorted.slice(0, 20).forEach((g, i) => {
  const tag = (g.tags ?? []).find(t => ["zelda","mario","sonic"].includes(t)) ?? "(other)";
  const flag = HEADLINE_IDS.includes(g.id) ? "★" : " ";
  console.log(`${String(i+1).padStart(2)}. ${flag} [${tag.padEnd(6)}] ${g.id.padEnd(28)} ${g.name}`);
});
