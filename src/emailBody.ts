/**
 * Server-side envelope parsing and quote stripping, run once during sync
 * instead of on every paint in the browser.
 *
 * `htmlToText` and the trailing-quote half of this are a deliberate mirror of
 * `public/js/lib/text.js` -- same precedent as `bizhours.js` mirroring
 * `businessHours.ts` (documented at `bizhours.js:1-19`): the client and
 * server have no shared-module mechanism, so keeping the two in step by hand
 * is the accepted cost. What's new here is the leading-envelope extraction:
 * `splitQuoted`'s `QUOTE_RE` already matches `From:\s*\S`, but its loop
 * starts at line 1 and requires 40+ characters of head, so a body that
 * *opens* with `From:`/`To:`/`Cc:` -- a reply or forward composed with the
 * original headers pasted in as text, not a real MIME forward -- was never
 * split at all.
 */

export const EMAIL_PARSER_VERSION = 1;

export interface ParsedEnvelope {
  from: string | null;
  to: string[];
  cc: string[];
}

export interface ParsedBody {
  envelope: ParsedEnvelope | null;
  cleanBody: string;
  quotedBody: string;
}

const TAG_NAMES = [
  "a", "b", "blockquote", "body", "br", "caption", "center", "code", "col",
  "colgroup", "dd", "div", "dl", "dt", "em", "font", "h[1-6]", "head", "hr",
  "html", "i", "img", "label", "li", "meta", "ol", "p", "pre", "s", "small",
  "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "title", "tr", "u", "ul", "o:p", "v:\\w+", "w:\\w+",
].join("|");

const TAG_RE = new RegExp(`<\\s*/?\\s*(?:${TAG_NAMES})\\b[^>]*>`, "gi");

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  ldquo: "\u201c", rdquo: "\u201d", lsquo: "\u2018", rsquo: "\u2019",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", bull: "\u2022",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", deg: "\u00b0",
  middot: "\u00b7", laquo: "\u00ab", raquo: "\u00bb",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

export function htmlToText(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input).replace(/\r\n?/g, "\n");
  s = s.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\s*hr\s*\/?\s*>/gi, "\n\u2014\u2014\u2014\n");
  s = s.replace(/<\s*li\b[^>]*>/gi, "\n\u2022 ");
  s = s.replace(/<\s*\/\s*(?:p|div|tr|li|ul|ol|table|h[1-6]|blockquote|pre|dd|dt)\s*>/gi, "\n");
  s = s.replace(TAG_RE, "");
  s = decodeEntities(s);
  s = s.replace(/\u00a0/g, " ");
  s = s.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

const QUOTE_RE = /^[ \t>]*(?:On\s.{4,160}\bwrote:\s*$|-{2,}\s*Original Message\s*-*\s*$|_{5,}\s*$|-{3,}\s*Forwarded message\s*-*\s*$|From:\s*\S)/i;

function splitTrailingQuote(text: string): { body: string; quoted: string } {
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (!QUOTE_RE.test(lines[i])) continue;
    const head = lines.slice(0, i).join("\n").trimEnd();
    const tail = lines.slice(i).join("\n").trim();
    if (head.length >= 40 && tail.length > 0) return { body: head, quoted: tail };
    return { body: text, quoted: "" };
  }
  return { body: text, quoted: "" };
}

const HEADER_LINE_RE = /^(From|To|Cc|Bcc|Sent|Date|Subject):[ \t]*(.*)$/i;

function splitAddresses(value: string): string[] {
  return value.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * A block of From:/To:/Cc:/Subject:/Sent: lines starting at line 0 -- before
 * any real message content. Only recognized when the very first line is a
 * `From:` header; a body that happens to mention "To:" on its first real
 * line otherwise would be misread as an envelope.
 */
function extractLeadingEnvelope(text: string): { envelope: ParsedEnvelope; rest: string } | null {
  const lines = text.split("\n");
  if (!/^from:[ \t]*\S/i.test(lines[0] || "")) return null;

  const envelope: ParsedEnvelope = { from: null, to: [], cc: [] };
  let i = 0;
  let sawTo = false;
  let sawCc = false;
  for (; i < lines.length; i++) {
    const m = HEADER_LINE_RE.exec(lines[i]);
    if (!m) break;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "from") envelope.from = val || null;
    else if (key === "to") { envelope.to = splitAddresses(val); sawTo = true; }
    else if (key === "cc") { envelope.cc = splitAddresses(val); sawCc = true; }
    // sent/date/subject are consumed (so they don't leak into the visible
    // body) but not stored -- Subject already comes from Salesforce's own
    // EmailMessage.Subject field on the comment row.
  }
  if (!sawTo && !sawCc && !envelope.from) return null;

  if (lines[i] !== undefined && lines[i].trim() === "") i++;
  const rest = lines.slice(i).join("\n").trim();
  return { envelope, rest };
}

/** HTML/plain body in, envelope + clean text + quoted tail out. */
export function parseEmailBody(rawBody: string | null | undefined): ParsedBody {
  const plain = htmlToText(rawBody);
  const leading = extractLeadingEnvelope(plain);
  const afterEnvelope = leading ? leading.rest : plain;
  const { body, quoted } = splitTrailingQuote(afterEnvelope);
  return {
    envelope: leading ? leading.envelope : null,
    cleanBody: body,
    quotedBody: quoted,
  };
}
