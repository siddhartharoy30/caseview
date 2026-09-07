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

/** 1-based position among non-federal agents, in the board's own row order
 * -- see POSITION DISCOVERY above. Null if the name is not on the board at
 * all (off shift, or a name mismatch worth knowing about separately). */
export function positionOf(board: PhoneBoard, name: string): number | null {
  const nonFederal = board.agents.filter((a) => !a.federal);
  const idx = nonFederal.findIndex((a) => a.name === name);
  return idx === -1 ? null : idx + 1;
}
