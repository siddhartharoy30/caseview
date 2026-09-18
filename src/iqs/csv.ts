/**
 * A small, hand-rolled RFC 4180 delimited-text parser.
 *
 * `src/iqs/official.ts`'s old cell-splitting was a plain `line.split(delimiter)`
 * -- no quote-awareness at all. A real SentryAI export quotes its multi-
 * contributor column ("Siddhartha Roy, Akshay Kumar, Shamanth Yadav S U,
 * Rohini B"), and that quoted comma split the row into extra cells, shifting
 * every column after it. This is the fix: a character-scanning state machine
 * over the whole raw text, not per line -- a line-based pre-split (the old
 * code's `raw.split(/\r?\n/)` before any quote parsing) would itself corrupt
 * a field with a real embedded newline inside quotes, so the delimiter and
 * the newline are both handled by the same state machine, in one pass.
 *
 * No dependency added, per the project's own constraint -- this is ~40 lines.
 */

/**
 * Which of comma, tab, or pipe actually separates the header row into more
 * than one cell. Deliberately sniffs only the header line's raw text (a
 * plain split is fine for this one purpose -- a header row containing an
 * embedded newline is not a realistic case worth complicating this for), not
 * the full RFC 4180 state machine below, which needs the delimiter as an
 * input in the first place.
 */
export function detectDelimiter(headerLine: string): string {
  const candidates = ["\t", ",", "|"];
  let best = ",";
  let bestCount = 1;
  for (const d of candidates) {
    const count = headerLine.split(d).length;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Parses `raw` as RFC 4180 delimited text: quoted fields, an embedded
 * delimiter or newline inside quotes, and `""` as an escaped literal quote.
 * Returns rows of cells, header row included (callers slice it off).
 *
 * Every cell is trimmed. A cell that came from an actually-quoted field
 * needs no separate quote-stripping -- the state machine below only ever
 * appends the characters between the delimiting quotes to the field buffer,
 * so the buffer already holds the unquoted content.
 */
export function parseDelimited(raw: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const endField = () => {
    row.push(field.trim());
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\n") {
      if (field.endsWith("\r")) field = field.slice(0, -1);
      endRow();
    } else {
      field += ch;
    }
  }

  // Flush a trailing row that had no final newline. A row that is just one
  // empty trailing field (the file ended in "\n") is not a real blank row.
  if (field !== "" || row.length) endRow();

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}
