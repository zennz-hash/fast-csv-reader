// Fast dependency-free drop-in replacement for csv-reader 1.0.0.
// Uses C++ SIMD indexOf cursors (nextNL, nextCR, nextQ, comma),
// cursor-skipped newline checks inside quoted fields, and packed template row arrays.

let _pos = 0;
let _line = 0;
let _ended = 0;

function normalizeMultiline(s) {
  let out = '';
  let seg = 0;
  let delta = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) {
      delta++;
    } else if (c === 13) {
      out += s.slice(seg, i) + '\n';
      delta++;
      if (i + 1 < n && s.charCodeAt(i + 1) === 10) i++;
      seg = i + 1;
    }
  }
  _line += delta;
  if (seg === 0) return s;
  return seg < n ? out + s.slice(seg) : out;
}

function readUnquotedWithCR(text, len, pos, line, errors, recordLine, recordRow) {
  let parts = '';
  let hasParts = false;
  let seg = pos;
  while (pos < len) {
    const c = text.charCodeAt(pos);
    if (c <= 44) {
      if (c === 44) {
        const val = hasParts ? (pos > seg ? parts + text.slice(seg, pos) : parts) : (pos > seg ? text.slice(seg, pos) : '');
        _pos = pos + 1;
        _line = line;
        _ended = 0;
        return val;
      }
      if (c === 10) {
        const val = hasParts ? (pos > seg ? parts + text.slice(seg, pos) : parts) : (pos > seg ? text.slice(seg, pos) : '');
        _pos = pos + 1;
        _line = line + 1;
        _ended = 1;
        return val;
      }
      if (c === 13) {
        if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
          const val = hasParts ? (pos > seg ? parts + text.slice(seg, pos) : parts) : (pos > seg ? text.slice(seg, pos) : '');
          _pos = pos + 2;
          _line = line + 1;
          _ended = 1;
          return val;
        }
        parts = hasParts ? (pos > seg ? parts + text.slice(seg, pos) : parts) : text.slice(seg, pos);
        hasParts = true;
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos++;
        seg = pos;
        continue;
      }
    }
    pos++;
  }
  const val = hasParts ? (pos > seg ? parts + text.slice(seg, pos) : parts) : (pos > seg ? text.slice(seg, pos) : '');
  _pos = pos;
  _line = line;
  _ended = 2;
  return val;
}

function readQuoteJunk(text, len, pos, val, line, errors, recordLine, recordRow) {
  let seg = pos;
  let added = 0;
  let ended = 2;
  while (pos < len) {
    const c = text.charCodeAt(pos);
    if (c <= 44) {
      if (c === 44) {
        if (pos > seg) {
          val += text.slice(seg, pos);
          added += pos - seg;
        }
        pos++;
        ended = 0;
        break;
      }
      if (c === 10) {
        if (pos > seg) {
          val += text.slice(seg, pos);
          added += pos - seg;
        }
        pos++;
        line++;
        ended = 1;
        break;
      }
      if (c === 13) {
        if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
          if (pos > seg) {
            val += text.slice(seg, pos);
            added += pos - seg;
          }
          pos += 2;
          line++;
          ended = 1;
          break;
        }
        if (pos > seg) {
          val += text.slice(seg, pos);
          added += pos - seg;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos++;
        seg = pos;
        continue;
      }
    }
    pos++;
  }
  if (ended === 2 && pos > seg) {
    val += text.slice(seg, pos);
    added += pos - seg;
  }
  if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  _pos = pos;
  _line = line;
  _ended = ended;
  return val;
}

function readUnterminated(text, len, open, openLine, errors, recordLine, recordRow) {
  errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
  return '"' + readUnquotedWithCR(text, len, open + 1, openLine, errors, recordLine, recordRow);
}

function readQuoted(text, len, open, line, nextNL, nextCR, errors, recordLine, recordRow) {
  let q = text.indexOf('"', open + 1);
  if (q === -1) return readUnterminated(text, len, open, line, errors, recordLine, recordRow);

  let val;
  if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
    val = text.slice(open + 1, q + 1);
    let seg = q + 2;
    while (true) {
      q = text.indexOf('"', seg);
      if (q === -1) return readUnterminated(text, len, open, line, errors, recordLine, recordRow);
      if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
        val += text.slice(seg, q + 1);
        seg = q + 2;
        continue;
      }
      if (q > seg) val += text.slice(seg, q);
      break;
    }
  } else {
    val = q === open + 1 ? '' : text.slice(open + 1, q);
  }

  _line = line;
  if (q >= nextNL || q >= nextCR) {
    if (val.indexOf('\n') !== -1 || val.indexOf('\r') !== -1) {
      val = normalizeMultiline(val);
    }
  }

  const after = q + 1;
  if (after >= len) {
    _pos = after;
    _ended = 2;
    return val;
  }
  const nc = text.charCodeAt(after);
  if (nc === 44) {
    _pos = after + 1;
    _ended = 0;
    return val;
  }
  if (nc === 10) {
    _pos = after + 1;
    _line++;
    _ended = 1;
    return val;
  }
  if (nc === 13 && after + 1 < len && text.charCodeAt(after + 1) === 10) {
    _pos = after + 2;
    _line++;
    _ended = 1;
    return val;
  }
  return readQuoteJunk(text, len, after, val, _line, errors, recordLine, recordRow);
}

function fixRowWidth(fields, width, errors, recordLine, recordRow) {
  const col = fields.length;
  if (col < width) {
    errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: col });
    for (let i = col; i < width; i++) fields.push('');
  } else {
    errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
  }
}

export function run(input) {
  const text = String(input.text);
  const len = text.length;
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let rowTpl = null;

  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  let nextNL = text.indexOf('\n', pos);
  if (nextNL === -1) nextNL = len;
  let nextCR = text.indexOf('\r', pos);
  if (nextCR === -1) nextCR = len + 1;
  let nextQ = text.indexOf('"', pos);
  if (nextQ === -1) nextQ = len + 1;

  while (pos < len) {
    if (nextNL < pos) {
      nextNL = text.indexOf('\n', pos);
      if (nextNL === -1) nextNL = len;
    }

    if (pos === nextNL) {
      pos++;
      line++;
      continue;
    }
    if (nextNL < len && pos + 1 === nextNL && text.charCodeAt(pos) === 13) {
      pos += 2;
      line++;
      continue;
    }

    let lineEnd = (nextNL < len && text.charCodeAt(nextNL - 1) === 13) ? nextNL - 1 : nextNL;
    if (nextCR < pos) {
      nextCR = text.indexOf('\r', pos);
      if (nextCR === -1) nextCR = len + 1;
    }
    if (nextQ < pos) {
      nextQ = text.indexOf('"', pos);
      if (nextQ === -1) nextQ = len + 1;
    }

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // Fast path 1: clean unquoted line -> single C++ split.
    if (nextQ >= lineEnd && nextCR >= lineEnd) {
      const fields = text.slice(pos, lineEnd).split(',');
      if (nextNL < len) {
        pos = nextNL + 1;
        line++;
      } else {
        pos = len;
      }
      if (width < 0) {
        width = fields.length;
        rowTpl = new Array(width).fill('');
        if (header && columns === null) {
          columns = fields;
          continue;
        }
      } else if (fields.length !== width) {
        fixRowWidth(fields, width, errors, recordLine, recordRow);
      }
      rows.push(fields);
      continue;
    }

    // Fast path 2: row with quotes or stray CR.
    const hasTpl = rowTpl !== null;
    const fields = hasTpl ? rowTpl.slice() : [];
    let col = 0;
    let extra = null;
    let quoted = false;
    let ended = 0;
    let noStrayCR = nextCR >= lineEnd;

    do {
      let val;
      if (pos < len && text.charCodeAt(pos) === 34) {
        quoted = true;
        const prevLine = line;
        val = readQuoted(text, len, pos, line, nextNL, nextCR, errors, recordLine, recordRow);
        pos = _pos;
        line = _line;
        ended = _ended;
        if (ended === 0 && (line !== prevLine || pos > nextNL)) {
          nextNL = text.indexOf('\n', pos);
          if (nextNL === -1) nextNL = len;
          lineEnd = (nextNL < len && nextNL > pos && text.charCodeAt(nextNL - 1) === 13) ? nextNL - 1 : nextNL;
          if (nextCR < pos) {
            nextCR = text.indexOf('\r', pos);
            if (nextCR === -1) nextCR = len + 1;
          }
          noStrayCR = nextCR >= lineEnd;
        }
      } else {
        quoted = false;
        if (noStrayCR) {
          const comma = text.indexOf(',', pos);
          if (comma !== -1 && comma < lineEnd) {
            val = comma === pos ? '' : text.slice(pos, comma);
            pos = comma + 1;
            ended = 0;
          } else {
            val = lineEnd === pos ? '' : text.slice(pos, lineEnd);
            if (nextNL < len) {
              pos = nextNL + 1;
              line++;
              ended = 1;
            } else {
              pos = len;
              ended = 2;
            }
          }
        } else {
          val = readUnquotedWithCR(text, len, pos, line, errors, recordLine, recordRow);
          pos = _pos;
          line = _line;
          ended = _ended;
          if (ended === 0 && nextCR < pos) {
            nextCR = text.indexOf('\r', pos);
            if (nextCR === -1) nextCR = len + 1;
            noStrayCR = nextCR >= lineEnd;
          }
        }
      }

      if (hasTpl) {
        if (col < width) fields[col++] = val;
        else {
          if (extra === null) extra = [val];
          else extra.push(val);
          col++;
        }
      } else {
        fields.push(val);
        col++;
      }
    } while (ended === 0);

    if (col === 1 && fields[0] === '' && !quoted) continue;

    if (!hasTpl) {
      width = col;
      rowTpl = new Array(width).fill('');
      if (header && columns === null) {
        columns = fields;
        continue;
      }
      rows.push(fields);
    } else if (col === width) {
      rows.push(fields);
    } else if (col < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: col });
      rows.push(fields);
    } else {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra });
      rows.push(fields);
    }
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
