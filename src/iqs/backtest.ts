/**
 * `npm run iqs:backtest` -- scores every case in the local cache that has an
 * imported official score, compares against Contributor Score (never Case
 * Score -- see official.ts's module doc for why), and reports MAE, bias, a
 * worst-10 breakdown, per-dimension correlation, band agreement, and a
 * predicted-vs-official table.
 *
 * Deliberately scores fresh in-process via `loadCaseFacts()`/`scoreCase()`
 * rather than reading the cached `iqs_scores` row -- this always reflects
 * whatever `rubric.ts`/`layer1.ts` currently say, with no dependency on a
 * sync or a boot-time rescore having run since the last edit. Layer 1 is
 * pure regex (no network call, no cost), and this never calls Layer 2's
 * `scoreWithModel()` at all, so it structurally cannot touch the Layer 2
 * daily budget or cache -- run it as many times as you like.
 *
 * v9 phase 2. Gate (phase 3): overall MAE < 8, bias within +/-3.
 */

import fs from "fs";
import path from "path";
import { db } from "../db";
import { loadCaseFacts } from "./store";
import { scoreCase } from "./layer1";
import { bandFor } from "./rubric";
import type { Band } from "./rubric";

interface OfficialRow {
  case_id: string;
  case_number: string;
  overall: number;
  contributor_count: number | null;
  rules_version: string | null;
}

interface DimensionSample {
  id: string;
  label: string;
  earned: number;
  max: number;
  band: Band;
}

interface Sample {
  caseNumber: string;
  official: number;
  predicted: number;
  predictedBand: Band;
  officialBand: Band;
  isSolo: boolean;
  rulesVersion: string;
  dimensions: DimensionSample[];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function mae(samples: Sample[]): number {
  return mean(samples.map((s) => Math.abs(s.predicted - s.official)));
}
function bias(samples: Sample[]): number {
  return mean(samples.map((s) => s.predicted - s.official));
}

/** Pearson correlation. Null when there isn't enough spread to mean anything. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null;
  return num / Math.sqrt(dx2 * dy2);
}

const f2 = (n: number): string => n.toFixed(2);

function report(label: string, group: Sample[]): void {
  if (!group.length) {
    console.log(`${label.padEnd(10)} n=0`);
    return;
  }
  console.log(`${label.padEnd(10)} n=${String(group.length).padEnd(4)} MAE=${f2(mae(group)).padStart(6)}  bias=${f2(bias(group)).padStart(7)}`);
}

function main(): void {
  const officialRows = db
    .prepare(
      `SELECT case_id, case_number, overall, contributor_count, rules_version FROM iqs_official_scores`,
    )
    .all() as OfficialRow[];

  if (!officialRows.length) {
    console.log("No official scores imported yet. Import a report first (Quality page, or POST /api/iqs/official/import).");
    return;
  }

  const samples: Sample[] = [];
  let notInCache = 0;
  let nothingOfMine = 0;

  for (const row of officialRows) {
    const facts = loadCaseFacts(row.case_id);
    if (!facts) {
      notInCache++;
      continue;
    }
    const scored = scoreCase(facts);
    if (scored.overall === null) {
      nothingOfMine++;
      continue;
    }
    samples.push({
      caseNumber: row.case_number,
      official: row.overall,
      predicted: scored.overall,
      predictedBand: scored.band || "not_meeting",
      officialBand: bandFor(row.overall / 100),
      isSolo: (row.contributor_count ?? 1) <= 1,
      rulesVersion: row.rules_version || "unknown",
      dimensions: scored.dimensions.map((d) => ({ id: d.id, label: d.label, earned: d.earned, max: d.max, band: d.band })),
    });
  }

  console.log("\n=== IQS BACKTEST ===");
  console.log(
    `${samples.length} of ${officialRows.length} imported rows scored ` +
      `(${notInCache} not in local cache, ${nothingOfMine} nothing of mine to score).\n`,
  );

  if (!samples.length) {
    console.log("Nothing scoreable. Nothing further to report.");
    return;
  }

  const solo = samples.filter((s) => s.isSolo);
  const multi = samples.filter((s) => !s.isSolo);

  console.log("MAE / bias (target: MAE < 8, bias within +/-3):");
  report("Overall", samples);
  report("Solo", solo);
  report("Multi", multi);
  console.log("");

  const versions = [...new Set(samples.map((s) => s.rulesVersion))].sort();
  if (versions.length > 1) {
    console.log("By rules_version (like-for-like -- a case scored under an older rubric version shouldn't be blended uncritically with a newer one):");
    for (const v of versions) report(`  ${v}`, samples.filter((s) => s.rulesVersion === v));
    console.log("");
  }

  const worst = [...samples]
    .sort((a, b) => Math.abs(b.predicted - b.official) - Math.abs(a.predicted - a.official))
    .slice(0, 10);
  console.log("Worst 10 by absolute error:");
  for (const s of worst) {
    console.log(
      `  ${s.caseNumber}  predicted=${f2(s.predicted)}  official=${f2(s.official)}  error=${f2(s.predicted - s.official)}` +
        (s.isSolo ? "" : "  (multi)"),
    );
    for (const d of s.dimensions) {
      console.log(`      ${d.label.padEnd(20)} ${f2(d.earned)}/${d.max}  ${d.band}`);
    }
  }
  console.log("");

  // Proxy correlation: the export carries no official per-dimension
  // breakdown (SentryAI's own dimensions are inaccessible), so this measures
  // whether scoring well on a dimension tracks with a higher official
  // *overall* score -- a signal-quality proxy, not validated ground truth.
  const dimIds = [...new Set(samples.flatMap((s) => s.dimensions.map((d) => d.id)))];
  console.log("Per-dimension correlation with official score (proxy -- see comment above):");
  for (const id of dimIds) {
    const pairs = samples
      .map((s) => {
        const d = s.dimensions.find((x) => x.id === id);
        return d && d.max > 0 ? { frac: d.earned / d.max, off: s.official } : null;
      })
      .filter((p): p is { frac: number; off: number } => p !== null);
    const label = samples.find((s) => s.dimensions.some((d) => d.id === id))?.dimensions.find((d) => d.id === id)?.label || id;
    const r = pearson(pairs.map((p) => p.frac), pairs.map((p) => p.off));
    console.log(`  ${label.padEnd(20)} r=${r === null ? "n/a".padStart(5) : r.toFixed(2).padStart(5)}  (n=${pairs.length})`);
  }
  console.log("");

  const agree = samples.filter((s) => s.predictedBand === s.officialBand).length;
  console.log(`Band agreement: ${agree}/${samples.length} (${f2((agree / samples.length) * 100)}%)\n`);

  const sorted = [...samples].sort((a, b) => a.caseNumber.localeCompare(b.caseNumber));
  console.log("Predicted vs official, by case number:");
  for (const s of sorted) {
    console.log(`  ${s.caseNumber}  predicted=${f2(s.predicted)}  official=${f2(s.official)}  error=${f2(s.predicted - s.official)}`);
  }

  // A CSV scatter for anyone who wants a real chart, not a chart-rendering
  // dependency -- docs/shots/ is already gitignored, same destination the
  // hand-rolled screenshot workflow already uses.
  try {
    const outDir = path.join(__dirname, "..", "..", "docs", "shots");
    fs.mkdirSync(outDir, { recursive: true });
    const csv = [
      "case_number,predicted,official,error,rules_version,solo",
      ...sorted.map((s) => `${s.caseNumber},${f2(s.predicted)},${f2(s.official)},${f2(s.predicted - s.official)},${s.rulesVersion},${s.isSolo}`),
    ].join("\n");
    fs.writeFileSync(path.join(outDir, "backtest-scatter.csv"), csv);
    console.log(`\nScatter data: docs/shots/backtest-scatter.csv`);
  } catch (err) {
    console.log(`\n(Could not write the scatter CSV: ${(err as Error).message} -- the report above is unaffected.)`);
  }
}

main();
