/**
 * Parses an operator-downloaded bank statement CSV.
 *
 * HDFC netbanking statements use Date, Narration, Chq./Ref.No., Value Dt,
 * Withdrawal Amt., Deposit Amt., Closing Balance. A UPI credit narration is
 * dash-separated and carries one 12-digit reference, for example
 * UPI-PAYEE-name@upi-IFSC-401537805904-NOTE.
 * Other INR exports are accepted when the header names a date, a narration,
 * and a deposit/credit column. There is no bank-feed client here.
 */

const MAX_STATEMENT_ROWS = 2000;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function headerKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function classifyHeader(value) {
  const h = headerKey(value);
  if (!h) return null;
  if (h === 'date' || h === 'txn date' || h === 'transaction date' || h === 'tran date') return 'date';
  if (h === 'value dt' || h === 'value date' || h.startsWith('value dt')) return 'valueDate';
  if (h === 'narration' || h === 'description' || h.includes('particular') || h.includes('remark')) return 'narration';
  if (h.includes('withdrawal') || h === 'debit' || h.startsWith('debit ')) return 'debit';
  if (h.includes('deposit') || h === 'credit' || h.startsWith('credit ')) return 'credit';
  if (h.includes('chq') || h.includes('ref')) return 'ref';
  return null;
}

function columnMap(headerRow) {
  const map = {};
  headerRow.forEach((cell, index) => {
    const kind = classifyHeader(cell);
    if (kind && map[kind] === undefined) map[kind] = index;
  });
  if (map.date === undefined || map.narration === undefined || map.credit === undefined) return null;
  return map;
}

export function rupeesToPaise(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text === '-' || text === '0' || text === '0.00' || text === '0.0') return 0;
  const cleaned = text.replace(/[₹,\s]/g, '').replace(/(cr|dr)$/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function parseStatementDate(raw) {
  const text = String(raw || '').trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(text);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  match = /^(\d{2})[/-](\d{2})[/-](\d{2})$/.exec(text);
  if (match) {
    const year = Number(match[3]) < 70 ? 2000 + Number(match[3]) : 1900 + Number(match[3]);
    return `${year}-${match[2]}-${match[1]}`;
  }
  return null;
}

export function extractTwelveDigitReferences(narration, ref) {
  const found = `${ref || ''} ${narration || ''}`.match(/\d{12}/g) || [];
  return [...new Set(found)];
}

/**
 * @param {string} csvText
 * @returns {{ error?: string, lines: Array<{
 *   bookedOn: string|null, amountPaise: number, direction: 'CREDIT'|'DEBIT',
 *   utr: string|null, referenceCount: number, narration: string, ref: string
 * }> }}
 */
export function parseStatementCsv(csvText) {
  const rows = parseCsv(csvText);
  let headerAt = -1;
  let columns = null;
  const scanLimit = Math.min(rows.length, 40);
  for (let i = 0; i < scanLimit; i++) {
    const mapped = columnMap(rows[i]);
    if (mapped) {
      headerAt = i;
      columns = mapped;
      break;
    }
  }
  if (!columns) {
    return {
      error: 'UNSUPPORTED_STATEMENT',
      lines: []
    };
  }

  const lines = [];
  for (let i = headerAt + 1; i < rows.length; i++) {
    if (lines.length >= MAX_STATEMENT_ROWS) {
      return { error: 'STATEMENT_TOO_LARGE', lines: [] };
    }
    const row = rows[i];
    const bookedOn = parseStatementDate(row[columns.valueDate ?? columns.date] || row[columns.date]);
    const narration = String(row[columns.narration] || '').trim();
    const ref = columns.ref === undefined ? '' : String(row[columns.ref] || '').trim();
    if (!bookedOn && !narration) continue;
    const creditPaise = rupeesToPaise(row[columns.credit]);
    const debitPaise = columns.debit === undefined ? 0 : rupeesToPaise(row[columns.debit]);
    if (creditPaise === null || debitPaise === null || !bookedOn) continue;
    const credit = creditPaise > 0 ? creditPaise : 0;
    const debit = debitPaise > 0 ? debitPaise : 0;
    if (credit > 0 && debit > 0) continue;
    if (credit === 0 && debit === 0) continue;
    const references = extractTwelveDigitReferences(narration, ref);
    lines.push({
      bookedOn,
      amountPaise: credit > 0 ? credit : debit,
      direction: credit > 0 ? 'CREDIT' : 'DEBIT',
      utr: references.length === 1 ? references[0] : null,
      referenceCount: references.length,
      narration,
      ref
    });
  }
  return { lines };
}
