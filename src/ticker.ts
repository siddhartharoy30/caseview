/**
 * The shift console's RBRK ticker (v9 part 3 phase 4).
 *
 * Server-side only, by constraint: the browser never calls the quote
 * provider directly, which keeps the API key off the client and off any
 * log line, and sidesteps CORS entirely. Finnhub is the primary provider
 * (confirmed reachable from the production VM in docs/PLAN_V9_CONSOLE.md);
 * Twelve Data is the alternate, selected by whichever key is set.
 *
 * Market hours are the design, not an afterthought: outside NYSE's
 * 09:30-16:00 ET session this serves the last-known close, labeled closed,
 * and makes zero upstream requests -- the bulk of the rate-limit saving and
 * the correctness requirement in one branch. Holidays are not
 * special-cased: if the provider's own quote timestamp hasn't advanced
 * since the last fetch despite nominal hours having passed, nothing is
 * actually trading and this reads the market as closed -- self-correcting,
 * with no calendar to keep current.
 */

import { config } from "./config";
import { zoned, isWeekend } from "./businessHours";
import { log, errText } from "./log";

export interface Quote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  marketOpen: boolean;
  asOf: number; // the provider's own quote timestamp, ms epoch
  fetchedAt: number;
  stale: boolean;
}

interface RawQuote {
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  asOf: number;
}

interface QuoteProvider {
  name: string;
  quote(symbol: string): Promise<RawQuote>;
}

const FINNHUB: QuoteProvider = {
  name: "finnhub",
  async quote(symbol) {
    const url = "https://finnhub.io/api/v1/quote?symbol=" + encodeURIComponent(symbol) + "&token=" + config.ticker.finnhubKey;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = (await res.json()) as { c: number; d: number; dp: number; pc: number; t: number };
    if (!body || typeof body.c !== "number" || body.c === 0) throw new Error("empty quote");
    return { price: body.c, change: body.d, changePercent: body.dp, previousClose: body.pc, asOf: body.t * 1000 };
  },
};

const TWELVE_DATA: QuoteProvider = {
  name: "twelvedata",
  async quote(symbol) {
    const url = "https://api.twelvedata.com/quote?symbol=" + encodeURIComponent(symbol) + "&apikey=" + config.ticker.twelveDataKey;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = (await res.json()) as {
      close?: string; change?: string; percent_change?: string; previous_close?: string; timestamp?: number; message?: string;
    };
    if (!body || body.close === undefined) throw new Error(body?.message || "empty quote");
    return {
      price: Number(body.close),
      change: Number(body.change),
      changePercent: Number(body.percent_change),
      previousClose: Number(body.previous_close),
      asOf: Number(body.timestamp) * 1000,
    };
  },
};

/** Finnhub preferred when both keys happen to be set, per the spec. */
function provider(): QuoteProvider | null {
  if (config.ticker.finnhubKey) return FINNHUB;
  if (config.ticker.twelveDataKey) return TWELVE_DATA;
  return null;
}

const NYSE_OPEN_MINUTE_OF_DAY = 9 * 60 + 30;
const NYSE_CLOSE_MINUTE_OF_DAY = 16 * 60;

function isNyseSessionOpen(atMs: number): boolean {
  if (isWeekend(atMs)) return false;
  const p = zoned(atMs);
  const minuteOfDay = p.hour * 60 + p.minute;
  return minuteOfDay >= NYSE_OPEN_MINUTE_OF_DAY && minuteOfDay < NYSE_CLOSE_MINUTE_OF_DAY;
}

const MIN_FETCH_INTERVAL_MS = 60_000;

let lastGood: Quote | null = null;
let lastFetchAt = 0;
let inFlight: Promise<Quote | null> | null = null;

async function fetchQuote(): Promise<Quote | null> {
  const p = provider();
  if (!p) return null;
  const previousAsOf = lastGood ? lastGood.asOf : null;
  try {
    const raw = await p.quote(config.ticker.symbol);
    const now = Date.now();
    // Holiday handling, per the spec: no calendar. A quote timestamp that
    // hasn't moved since the last fetch, despite nominal hours having
    // passed, means nothing is actually trading today.
    const timestampAdvancing = previousAsOf === null || raw.asOf > previousAsOf;
    const quote: Quote = {
      symbol: config.ticker.symbol,
      price: raw.price,
      change: raw.change,
      changePercent: raw.changePercent,
      previousClose: raw.previousClose,
      marketOpen: isNyseSessionOpen(now) && timestampAdvancing,
      asOf: raw.asOf,
      fetchedAt: now,
      stale: false,
    };
    lastGood = quote;
    log.info("ticker.quote_fetched", { provider: p.name, symbol: config.ticker.symbol });
    return quote;
  } catch (err) {
    log.warn("ticker.quote_fetch_failed", { provider: p.name, error: errText(err) });
    return lastGood ? { ...lastGood, stale: true } : null;
  }
}

/**
 * Serve on demand, same discipline as phone.ts's getPhoneBoard(): a request
 * inside MIN_FETCH_INTERVAL_MS of the last real fetch gets the cached
 * result; outside NYSE hours this never calls fetchQuote() at all, however
 * stale the cache is -- that's the actual point of the market-hours gate,
 * not just a rate-limit nicety. Assumes the caller has already checked
 * config.ticker.enabled (the route does, so a disabled ticker never reaches
 * this module at all).
 */
export async function getQuote(): Promise<Quote | null> {
  const now = Date.now();
  if (!isNyseSessionOpen(now)) {
    return lastGood ? { ...lastGood, marketOpen: false } : null;
  }

  const age = now - lastFetchAt;
  if (age < MIN_FETCH_INTERVAL_MS) {
    if (lastGood) return lastGood;
    if (inFlight) return inFlight;
  }
  if (inFlight) return inFlight;

  lastFetchAt = now;
  inFlight = fetchQuote().finally(() => { inFlight = null; });
  return inFlight;
}
