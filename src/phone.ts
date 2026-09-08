/**
 * The AMER phone queue board -- someone else's CGI script, on someone else's
 * box, that self-refreshes every 15s and was never meant to be machine-read.
 *
 * Two rules keep this a good citizen: fetch it on demand with a 10s minimum
 * interval between real upstream requests (no server-side timer -- no
 * request from the browser means no fetch, so "the monitor is off" and "no
 * requests reach the board" are the same thing rather than two things kept
 * in sync by hand), and cache the last good parse so a transient upstream
 * failure degrades to "a bit stale" instead of "broken."
 *
 * Position among agents is deliberately *not* computed by a fresh idea here.
 * Case Desk (https://10.26.117.234/) already solves this for the org and is
 * the tool colleagues trust; its own app.js does exactly two things worth
 * copying verbatim -- see POSITION DISCOVERY below -- and this module
 * matches that logic rather than inventing a second answer that could
 * disagree with it for the same board state.
 *
 * POSITION DISCOVERY (recorded here and in docs/PHONE.md): fetched Case
 * Desk's own app.js from the VM. Its phone-queue tab does
 *   const nonFederal = data.agents.filter((a) => !a.federal);
 *   const nowInTop3 = nonFederal.slice(0, 3).some((a) => a.name === WATCHED_NAME);
 * against `data.agents` from its own `/api/phone-queue` backend, which
 * returns agents in the *same order the source board already lists them* --
 * confirmed by fetching that endpoint directly and comparing row order
 * against the raw board HTML for the same moment: available agents already
 * arrive sorted by duration descending, non-available statuses trail after.
 * So: a federal agent never counts toward a non-federal agent's position
 * (settling the plan's open question), and position is a name's 1-based
 * index into the board's own row order after filtering out federal rows --
 * no re-sort needed, because the source already presents it that way.
 */

import { log, errText } from "./log";
import { db, now } from "./db";

export type AgentStatus =
  | "available" | "ringing" | "accepting_call" | "inbound" | "outbound"
  | "on_call" | "on_call__inbound_" | "on_call__outbound_"
  | "on_hold__in_" | "on_hold__out_"
  | "acw" | "acw_in_" | "acw_out_" | "acw__inbound_" | "acw__outbound_" | "acw__transfer_"
  | "after_call_work" | "zoom" | "busy" | "away" | "offline" | "missed";

export interface PhoneAgent {
  name: string;
  statusClass: AgentStatus | string;
  statusText: string;
  duration: string;
  federal: boolean;
}

export interface PhoneBoard {
  ok: true;
  asOf: string | null;
  queuedAgents: number;
  queuedFederal: number;
  agents: PhoneAgent[];
  fetchedAt: number;
  stale: boolean;
}

export interface PhoneBoardError {
  ok: false;
  reason: string;
  fetchedAt: number;
}

const BOARD_URL = "http://reportrunner.colo.rubrik.com/cgi-bin/amer/phone_now_et.pl";
const MIN_FETCH_INTERVAL_MS = 10_000;

/**
 * Hand-written tokeniser, not an HTML parser dependency (constraint #2 in
 * the plan) -- the row shape is simple and fixed:
 *   <tr><td class="STATUS[ fed]">NAME</td><td class="STATUS">LABEL</td><td class="STATUS value">DURATION</td></tr>
 * and the header:
 *   <tr><th class="heading">Queued: Agents : N;  Federal : N</th><th></th><th class="time">HH:MM</th></tr>
 */
const ROW_RE =
  /<tr><td class="([a-z_]+)\s*(fed)?\s*">([^<]*)<\/td><td class="[a-z_]+">([^<]*)<\/td><td class="[a-z_]+ value">([^<]*)<\/td><\/tr>/g;
const HEADER_RE = /Queued:\s*Agents\s*:\s*(\d+);\s*Federal\s*:\s*(\d+)/i;
const TIME_RE = /<th class="time">([^<]*)<\/th>/;

function parseBoardHtml(html: string): PhoneAgent[] | null {
  const agents: PhoneAgent[] = [];
  let m: RegExpExecArray | null;
  ROW_RE.lastIndex = 0;
  while ((m = ROW_RE.exec(html))) {
    const [, statusClass, fed, name, , duration] = m;
    agents.push({
      name: name.trim(),
      statusClass,
      statusText: m[4].trim(),
      duration: duration.trim(),
      federal: fed === "fed",
    });
  }
  return agents;
}

let lastGood: PhoneBoard | null = null;
let lastFetchAt = 0;
let inFlight: Promise<PhoneBoard | PhoneBoardError> | null = null;

async function fetchBoard(): Promise<PhoneBoard | PhoneBoardError> {
  try {
    const res = await fetch(BOARD_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status, fetchedAt: Date.now() };
    const html = await res.text();

    const headerMatch = HEADER_RE.exec(html);
    const timeMatch = TIME_RE.exec(html);
    const agents = parseBoardHtml(html);

    // A shape change (constraint: no HTML parser, so a redesign of the page
    // breaks these regexes) must read as "cannot read the board," not as an
    // empty board -- an empty board with a real queue header is a very
    // different fact than a parser that stopped working.
    if (!headerMatch || agents === null) {
      return { ok: false, reason: "board shape did not match the expected structure", fetchedAt: Date.now() };
    }

    const board: PhoneBoard = {
      ok: true,
      asOf: timeMatch ? timeMatch[1].trim() : null,
      queuedAgents: Number(headerMatch[1]),
      queuedFederal: Number(headerMatch[2]),
      agents,
      fetchedAt: Date.now(),
      stale: false,
    };
    lastGood = board;
    // Counts only at info -- never agent names (log.ts's redaction matches
    // key names like "token"/"secret", not "name", so this has to be
    // deliberate rather than relied on).
    log.info("phone.board_fetched", { agents: agents.length, queued: board.queuedAgents, queuedFederal: board.queuedFederal });
    log.debug("phone.board_names", { names: agents.map((a) => a.name) });
    return board;
  } catch (err) {
    log.warn("phone.board_fetch_failed", { error: errText(err) });
    return { ok: false, reason: errText(err), fetchedAt: Date.now() };
  }
}

/**
 * Serve on demand. A request within MIN_FETCH_INTERVAL_MS of the last real
 * fetch gets the cached result (stale-flagged if it's the error case and
 * there's nothing cached yet); no request means no upstream call, which is
 * the whole polling-discipline contract.
 */
export async function getPhoneBoard(): Promise<PhoneBoard | PhoneBoardError> {
  const age = Date.now() - lastFetchAt;
  if (age < MIN_FETCH_INTERVAL_MS && (lastGood || inFlight)) {
    if (lastGood) return { ...lastGood, stale: age > 0 && Date.now() - lastGood.fetchedAt > MIN_FETCH_INTERVAL_MS };
    if (inFlight) return inFlight;
  }
  if (inFlight) return inFlight;

  lastFetchAt = Date.now();
  inFlight = fetchBoard().finally(() => { inFlight = null; });
  const result = await inFlight;
  if (!result.ok && lastGood) {
    // A failed poll still serves the last good parse, aged rather than gone.
    return { ...lastGood, stale: true };
  }
  return result;
}

/* -------------------------------------------------------- v5 phase 2: roster */

/**
 * v5 phase 2 discovery, before any of this was written: probed ~18 sibling
 * `reportrunner` CGI paths (regional variants, a routing-profile report, a
 * federal/ sibling directory) -- only the known amer/phone_now_et.pl exists,
 * everything else 404s or 403s on directory listing. Re-fetched Case Desk's
 * own app.js and its live /api/phone-queue response: its agent objects carry
 * exactly name/status_text/status_class/duration/federal -- no region field
 * anywhere, meaning Case Desk shares this exact bug (see docs/PHONE.md).
 * Both machine-readable avenues came up empty, so the explicit roster below
 * is the only option, not a fallback.
 */
export type Region = "us" | "india" | "unknown";
const VALID_REGIONS = new Set<Region>(["us", "india", "unknown"]);

export interface RosterEntry {
  name: string;
  line: string | null;
  region: Region;
  note: string | null;
  updatedAt: number;
}

interface RosterRow {
  name: string;
  line: string | null;
  region: string;
  note: string | null;
  updated_at: number;
}

function toRosterEntry(r: RosterRow): RosterEntry {
  return { name: r.name, line: r.line, region: r.region as Region, note: r.note, updatedAt: r.updated_at };
}

export function listRoster(): RosterEntry[] {
  return (db.prepare("SELECT * FROM phone_roster ORDER BY name ASC").all() as RosterRow[]).map(toRosterEntry);
}

function rosterMap(): Map<string, RosterEntry> {
  return new Map(listRoster().map((r) => [r.name, r]));
}

export function regionOf(name: string, map?: Map<string, RosterEntry>): Region {
  return (map ?? rosterMap()).get(name)?.region ?? "unknown";
}

export function upsertRosterEntry(
  name: string,
  patch: { line?: string | null; region: Region; note?: string | null },
): RosterEntry {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required");
  if (!VALID_REGIONS.has(patch.region)) throw new Error("Region must be us, india, or unknown");
  const row: RosterRow = {
    name: trimmed,
    line: patch.line ?? null,
    region: patch.region,
    note: patch.note ?? null,
    updated_at: now(),
  };
  db.prepare(
    `INSERT INTO phone_roster (name, line, region, note, updated_at) VALUES (@name, @line, @region, @note, @updated_at)
     ON CONFLICT(name) DO UPDATE SET line = excluded.line, region = excluded.region, note = excluded.note, updated_at = excluded.updated_at`,
  ).run(row);
  // Counts/region at info, the name itself at debug -- same split phone.board_fetched already uses.
  log.info("phone.roster_updated", { region: patch.region });
  log.debug("phone.roster_updated_name", { name: trimmed });
  return toRosterEntry(row);
}

export function deleteRosterEntry(name: string): void {
  db.prepare("DELETE FROM phone_roster WHERE name = ?").run(name);
}

export interface PositionResult {
  /** 1-based rank in my pool, board's own row order. Null if I'm not on the board. */
  position: number | null;
  /** Pool members on this snapshot, any live status -- not just available ones. */
  poolSize: number;
  poolLabel: string; // "Federal" | "AMER · India" | "AMER · US" | "AMER · Unclassified"
  ahead: number;
  uncertain: boolean;
  /** Available same-line agents with region 'unknown', excluding me. */
  unclassified: string[];
}

function poolLabelFor(region: Region): string {
  return region === "unknown" ? "AMER · Unclassified" : "AMER · " + (region === "us" ? "US" : "India");
}

/**
 * Same mechanism as v4, narrowed. Filter the board's own agent order --
 * first to non-federal, then to my own region -- and take a 1-based index.
 * No re-sort, no duration-string parsing: the source board already lists
 * available agents duration-descending with other statuses trailing (see
 * POSITION DISCOVERY above and docs/PHONE.md), and filtering a subset of an
 * already-correctly-ordered list preserves that order. This is provably
 * equal to "1 + count of same-pool available agents idle longer than me,"
 * the same reasoning that made the original federal/non-federal split
 * correct, just narrowed by one more dimension.
 */
export function positionOf(
  board: PhoneBoard,
  name: string,
  map: Map<string, RosterEntry> = rosterMap(),
): PositionResult | null {
  const mine = board.agents.find((a) => a.name === name);
  if (!mine) return null;

  if (mine.federal) {
    return { position: null, poolSize: 0, poolLabel: "Federal", ahead: 0, uncertain: false, unclassified: [] };
  }

  const myRegion = regionOf(name, map);
  const sameLine = board.agents.filter((a) => !a.federal);
  const pool = sameLine.filter((a) => regionOf(a.name, map) === myRegion);
  const idx = pool.findIndex((a) => a.name === name);

  const unclassified = sameLine
    .filter((a) => a.name !== name && a.statusClass === "available" && regionOf(a.name, map) === "unknown")
    .map((a) => a.name);

  return {
    position: idx === -1 ? null : idx + 1,
    poolSize: pool.length,
    poolLabel: poolLabelFor(myRegion),
    ahead: idx === -1 ? 0 : idx,
    uncertain: unclassified.length > 0,
    unclassified,
  };
}
