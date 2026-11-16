/**
 * quote-email-attachments.test.js — 2026-11-16.
 *
 * Proves, against the SHIPPED index.html code, that emailing a quotation puts
 * the cover letter, the quotation PDF and the selected attached files into ONE
 * Outlook .eml, each as a real MIME attachment with its own name, content type
 * and exact bytes. No database, no network, no browser.
 *
 * The functions under test are lifted out of index.html verbatim:
 *   buildEmlFile, sgrEmlFilenameParams, generateAndEmailDocument, sgrFmtBytes,
 *   SGR_EMAIL_MAX_MESSAGE_BYTES
 * Only the PDF renderers and the browser download are replaced by recorders.
 *
 * Run:  node test/quote-email-attachments.test.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INDEX = path.resolve(__dirname, '..', '..', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');
const OPEN = '<script type="text/babel" data-presets="react-classic">';
const SRC = html.slice(html.indexOf(OPEN) + OPEN.length, html.lastIndexOf('</script>'));

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

// A function's source: from its declaration to the first closing brace that
// makes it a complete, parseable function (regex literals such as /.{1,76}/
// contain braces, so counting braces alone is not enough).
function extractFunction(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(SRC);
  if (!m) throw new Error('function not found in index.html: ' + name);
  let i = SRC.indexOf('{', m.index);
  for (let end = SRC.indexOf('}', i); end !== -1; end = SRC.indexOf('}', end + 1)) {
    const cand = SRC.slice(m.index, end + 1);
    try { new Function(cand); return cand; } catch (e) { /* keep looking */ }
  }
  throw new Error('could not extract ' + name);
}
function extractConstLine(name) {
  const m = new RegExp('^const\\s+' + name + '\\s*=.*;', 'm').exec(SRC);
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}

const STUBS = `
  const __rec = { downloads: [], marked: 0 };
  async function generateCoverLetterPdf(){ return __COVER_B64; }
  async function generateDocumentPdfFromHtml(){ return __DOC_B64; }
  function sgrInvoiceWithCurrentCustomer(d){ return d; }
  function downloadFile(content, filename, mime){ __rec.downloads.push({ content, filename, mime }); }
`;
const COVER = Buffer.from('%PDF-1.4\n% cover letter\n%%EOF\n', 'latin1');
const DOC = Buffer.from('%PDF-1.4\n% quotation\n%%EOF\n', 'latin1');
const lib = new Function('__COVER_B64', '__DOC_B64', [
  STUBS,
  extractConstLine('SGR_EMAIL_MAX_MESSAGE_BYTES'),
  extractFunction('sgrFmtBytes'),
  extractFunction('sgrEmlFilenameParams'),
  extractFunction('buildEmlFile'),
  extractFunction('generateAndEmailDocument'),
  'return { __rec, buildEmlFile, generateAndEmailDocument, SGR_EMAIL_MAX_MESSAGE_BYTES };',
].join('\n'))(COVER.toString('base64'), DOC.toString('base64'));

// ── a small, strict MIME reader for the .eml the dashboard produces ─────────
function parseEml(text) {
  const [head, ...rest] = text.split('\r\n\r\n');
  const headers = {};
  for (const line of head.split('\r\n')) { const i = line.indexOf(':'); headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
  const boundary = /boundary="([^"]+)"/.exec(headers['content-type'])[1];
  const body = rest.join('\r\n\r\n');
  const chunks = body.split('--' + boundary).slice(1);
  const parts = [];
  for (const chunk of chunks) {
    if (chunk.startsWith('--')) break; // closing delimiter
    const c = chunk.replace(/^\r\n/, '');
    const sep = c.indexOf('\r\n\r\n');
    const ph = {};
    for (const line of c.slice(0, sep).split('\r\n')) { const i = line.indexOf(':'); ph[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
    const payload = c.slice(sep + 4).replace(/\r\n$/, '');
    const disp = ph['content-disposition'] || '';
    const star = /filename\*=UTF-8''([^;]+)/.exec(disp);
    const plain = /filename="([^"]*)"/.exec(disp);
    parts.push({
      contentType: (ph['content-type'] || '').split(';')[0],
      attachment: /^attachment/.test(disp),
      filename: star ? decodeURIComponent(star[1]) : (plain ? plain[1] : null),
      asciiFilename: plain ? plain[1] : null,
      bytes: /base64/i.test(ph['content-transfer-encoding'] || '') ? Buffer.from(payload.replace(/\r\n/g, ''), 'base64') : Buffer.from(payload, 'utf8'),
    });
  }
  return { headers, parts: parts.filter((p) => p.attachment) };
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const QUOTE = { num: 'SQ-09001', client: 'Synthetic Buyer CC', contact: 'Sam Buyer', email: 'buyer@customer.test', co: 2, lines: [] };
const COMPANIES = [{ id: 2, name: 'Signacore' }];

// Synthetic attachments with real signatures.
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(3000)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(2000)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), crypto.randomBytes(4000)]);
const extra = (filename, bytes, contentType) => ({ filename, base64: bytes.toString('base64'), contentType });

(async function main() {
  console.log('\n[1] the quotation, its cover letter and three selected files travel in one .eml');
  lib.__rec.downloads.length = 0;
  let marked = 0;
  await lib.generateAndEmailDocument('quote', QUOTE, COMPANIES, null, () => { marked++; }, [], [
    extra('site photo.jpg', JPG, 'image/jpeg'), extra('logo.png', PNG, 'image/png'), extra('spec sheet.pdf', PDF, 'application/pdf'),
  ]);
  ok(lib.__rec.downloads.length === 1, 'exactly one file is downloaded');
  const d = lib.__rec.downloads[0];
  ok(d.filename === 'Quote_SQ-09001.eml' && d.mime === 'message/rfc822', 'it is the usual Quote_<number>.eml', [d.filename, d.mime]);
  const eml = parseEml(d.content);
  ok(eml.headers.to === QUOTE.email && /Quotation SQ-09001/.test(eml.headers.subject) && eml.headers['x-unsent'] === '1', 'recipient, subject and "unsent" flag are unchanged');
  const names = eml.parts.map((p) => p.filename);
  ok(JSON.stringify(names) === JSON.stringify(['Cover_Letter_SQ-09001.pdf', 'Quotation_SQ-09001.pdf', 'site photo.jpg', 'logo.png', 'spec sheet.pdf']), 'five attachments in order: cover letter, quotation, then the selected files', names);
  ok(sha(eml.parts[0].bytes) === sha(COVER) && sha(eml.parts[1].bytes) === sha(DOC), 'the two generated PDFs are byte-identical');
  ok(sha(eml.parts[2].bytes) === sha(JPG) && sha(eml.parts[3].bytes) === sha(PNG) && sha(eml.parts[4].bytes) === sha(PDF), 'every selected file is byte-identical to the original');
  ok(JSON.stringify(eml.parts.map((p) => p.contentType)) === JSON.stringify(['application/pdf', 'application/pdf', 'image/jpeg', 'image/png', 'application/pdf']), 'each part carries its real content type');
  ok(marked === 1, 'the quotation is marked sent once, after the package is built');

  console.log('\n[2] sending without extra files is the original two-PDF message');
  lib.__rec.downloads.length = 0;
  await lib.generateAndEmailDocument('quote', QUOTE, COMPANIES, null, null, []);
  await lib.generateAndEmailDocument('quote', QUOTE, COMPANIES, null, null, [], []);
  const a = parseEml(lib.__rec.downloads[0].content), b = parseEml(lib.__rec.downloads[1].content);
  ok(a.parts.length === 2 && b.parts.length === 2, 'no extra argument, or an empty list: exactly two attachments');
  ok(a.parts.every((p, i) => sha(p.bytes) === sha(b.parts[i].bytes) && p.filename === b.parts[i].filename), 'both forms produce the same attachments');

  console.log('\n[3] file names are safe and unambiguous');
  lib.__rec.downloads.length = 0;
  await lib.generateAndEmailDocument('quote', QUOTE, COMPANIES, null, null, [], [
    extra('logo.png', PNG, 'image/png'), extra('logo.png', PNG, 'image/png'), extra('Quotation_SQ-09001.pdf', PDF, 'application/pdf'),
    extra('Façade – plan.pdf', PDF, 'application/pdf'), extra('evil"\r\nBcc: x@y.test.pdf', PDF, 'application/pdf'),
  ]);
  const n = parseEml(lib.__rec.downloads[0].content);
  const nn = n.parts.map((p) => p.filename);
  ok(nn[2] === 'logo.png' && nn[3] === 'logo (2).png', 'a second file with the same name becomes "logo (2).png"', nn);
  ok(nn[4] === 'Quotation_SQ-09001 (2).pdf', 'a file named like the generated quotation PDF does not replace it', nn[4]);
  ok(nn[5] === 'Façade – plan.pdf' && /^[\x20-\x7e]+$/.test(n.parts[5].asciiFilename), 'a non-ASCII name is kept exactly (RFC 2231) with a plain-ASCII fallback');
  ok(!/\r\nBcc:/i.test(lib.__rec.downloads[0].content) && n.headers.bcc === undefined, 'a line break in a file name cannot add a header to the message');

  console.log('\n[4] the aggregate message limit');
  lib.__rec.downloads.length = 0;
  let threw = null, markedBig = 0;
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(4.9 * 1024 * 1024)]);
  try {
    await lib.generateAndEmailDocument('quote', QUOTE, COMPANIES, null, () => { markedBig++; }, [], [0, 1, 2, 3, 4].map((i) => extra('big-' + i + '.pdf', big, 'application/pdf')));
  } catch (e) { threw = e; }
  ok(threw && threw.code === 'EMAIL_TOO_LARGE' && /25 MB/.test(threw.message), 'five 4.9 MB files are refused with EMAIL_TOO_LARGE and a plain message', threw && threw.message);
  ok(lib.__rec.downloads.length === 0 && markedBig === 0, 'nothing is downloaded and the quotation is not marked sent');
  ok(lib.SGR_EMAIL_MAX_MESSAGE_BYTES === 25 * 1024 * 1024, 'the limit is 25 MB of encoded message');
  lib.__rec.downloads.length = 0;
  await lib.generateAndEmailDocument('quote', QUOTE, COMPANIES, null, null, [], [0, 1, 2].map((i) => extra('big-' + i + '.pdf', big, 'application/pdf')));
  const three = parseEml(lib.__rec.downloads[0].content);
  ok(three.parts.length === 5 && Buffer.byteLength(lib.__rec.downloads[0].content) < lib.SGR_EMAIL_MAX_MESSAGE_BYTES && three.parts.slice(2).every((p) => sha(p.bytes) === sha(big)), 'three of them fit and arrive intact');

  console.log(`\n══ quote-email-attachments: PASSED ${passed}   FAILED ${failed} ══`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });
