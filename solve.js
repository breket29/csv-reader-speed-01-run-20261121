// A fast drop-in for csv-reader 1.0.0: run(input) returns {columns, rows, errors}
// exactly as csv-reader does, for every input {text, header}.
//
// The reference reads one character at a time and builds every field up a
// character at a time. This one scans with indexOf jumps instead: an unquoted
// field is found by the next comma, line feed or carriage return, and a quoted
// field by the next quote, so the work per field is a few native scans and a
// slice rather than a JavaScript loop over its characters. The reading policy
// is csv-reader's own, followed step for step:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it is one quote and each CRLF or lone CR inside it
//     is read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//   - a quote that never closes is a literal character, and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with empty strings (short_row, with
//     fields: its field count) or cut (long_row, with extra: the cut fields)
//     to the first record's width;
//   - each error is {code, line, row}, in the order met: line the 1-based
//     line its record starts on, counting every LF, CRLF and lone CR inside
//     quotes, and row its record's index in rows, null for the header.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept.
  //
  // The field's end is found first (the nearer of the next comma and the
  // next line feed), then the field is taken as one slice: every CR in it is
  // a stray one, except a CR standing just before the line feed that ends
  // the field, which is the CRLF ending. That keeps the scan to two native
  // searches and one short slice instead of a search per stray CR.
  function readUnquoted(value) {
    let added = 0;
    if (pos >= len) return { value, ended: END, added };
    const ci = text.indexOf(',', pos);
    const ni = text.indexOf('\n', pos);
    let end;
    let kind;
    if (ci === -1 && ni === -1) {
      end = len;
      kind = END;
    } else if (ni === -1 || (ci !== -1 && ci < ni)) {
      end = ci;
      kind = COMMA;
    } else {
      end = ni;
      kind = LINE_BREAK;
    }
    let s;
    if (kind === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === 13) {
      // The CR is the first half of the CRLF that ends the field.
      s = text.slice(pos, end - 1);
    } else {
      s = text.slice(pos, end);
    }
    if (s.indexOf('\r') !== -1) {
      // Lone CRs inside the field: dropped, one error each, in order.
      const parts = s.split('\r');
      for (let i = 1; i < parts.length; i += 1) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      }
      s = parts.join('');
    }
    if (s.length > 0) {
      value += s;
      added += s.length;
    }
    if (kind === COMMA) {
      pos = end + 1;
      return { value, ended: COMMA, added };
    }
    if (kind === LINE_BREAK) {
      pos = end + 1;
      line += 1;
      return { value, ended: LINE_BREAK, added };
    }
    pos = len;
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    let segStart = pos;
    for (;;) {
      const qi = text.indexOf('"', pos);
      if (qi === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      // The stretch up to the next quote holds no quote; a CR or CRLF in it
      // reads as LF, and every line break in it moves the line on.
      let seg = text.slice(segStart, qi);
      if (seg.indexOf('\r') !== -1) seg = seg.replace(/\r\n?/g, '\n');
      let n = 0;
      let p = -1;
      while ((p = seg.indexOf('\n', p + 1)) !== -1) n += 1;
      line += n;
      value += seg;
      if (qi + 1 < len && text.charCodeAt(qi + 1) === 34) {
        // A doubled quote is one quote inside the field.
        value += '"';
        pos = qi + 2;
        segStart = qi + 2;
        continue;
      }
      // The closing quote.
      pos = qi + 1;
      if (pos >= len) return { value, ended: END };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = readUnquoted(value);
      if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return junk;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    let fields;
    let quoted = false;
    // Fast path: a physical line that holds no quote and no stray CR is one
    // whole record, read by splitting it on commas. A quoted field is the
    // only thing that can carry a record over a line break, and none can open
    // in a line with no quote in it, so the record ends at this line's break.
    let fast = false;
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    const q = text.indexOf('"', pos);
    if (q === -1 || q >= lineEnd) {
      let contentEnd = lineEnd;
      if (nl !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) contentEnd = lineEnd - 1;
      if (contentEnd > pos) {
        // The slice holds the line's content, its CRLF ending already
        // stripped, so any CR left in it is a stray one and the line goes
        // to the slow path instead.
        const s = text.slice(pos, contentEnd);
        if (s.indexOf('\r') === -1) {
          fields = s.split(',');
          if (nl !== -1) line += 1;
          pos = nl === -1 ? len : nl + 1;
          fast = true;
        }
      }
    }
    if (!fast) {
      fields = [];
      let field;
      do {
        quoted = text.charCodeAt(pos) === 34;
        field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
      } while (field.ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
