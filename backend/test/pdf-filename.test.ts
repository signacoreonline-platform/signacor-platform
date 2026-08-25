/**
 * pdf-filename.test.ts — PDF SAVE FILENAME REGRESSION (2026-08-25)
 *
 * THE MECHANISM, ESTABLISHED FIRST
 *   Quote, Invoice, Proforma and Job Card are all produced the same way in
 *   index.html: a full HTML document string is written into a
 *   `window.open('','_blank')` popup, which then calls window.print(). There is
 *   no Blob, no object URL and no `<a download>` anywhere in that path — so the
 *   filename the browser's "Save as PDF" dialog suggests can only come from the
 *   printed document's TITLE. The popup's URL is about:blank, so if the title
 *   is missing or empty there is nothing else for the browser to fall back to
 *   and the dialog opens with a blank filename.
 *
 *   (This suite asserts that mechanism explicitly — case [1] — so that if a
 *   future change switches any of these four to a download-based path, this
 *   test fails and says so rather than silently checking the wrong thing.)
 *
 * THE FIX BEING PROVED
 *   Every print entry point now passes its own document number down to the
 *   print call, which sanitises it (sgrDocFileName), installs it as the written
 *   document's <title> (sgrWithDocTitle) and also assigns it to the live popup
 *   document's title (sgrWritePrintWindow). Nothing about the PDF's content,
 *   layout or margins changes, and the main application title is never touched.
 *
 * COVERAGE (numbered to match the brief's required tests)
 *   1  each of the four paths is title-based, not download-based
 *   2  Quote     filename contains the quote number      (SQ-#####)
 *   3  Invoice   filename contains the invoice number    (INV-#####)
 *   4  Proforma  filename contains the proforma number   (PRO-#####)
 *   5  Job Card  filename contains the job number        (SNS-#####)
 *   6  the filename is never blank, for any input
 *   7  the application title is never changed, so nothing needs restoring
 *   8  repeated printing produces the same filename every time
 *   9  only genuinely invalid filename characters are removed
 *
 * Pure source + sandbox evaluation of index.html — no database, no server.
 *
 * Usage (from backend/):
 *   npx ts-node --transpile-only test/pdf-filename.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(__dirname, '..', '..', 'index.html');

let failures = 0, passed = 0;
function ok(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

/** Brace-matched extraction of a top-level function, same helper shape
 *  proforma-frontend-logic.test.ts already uses. */
function extractFunction(src: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Could not find function ${name} in index.html — has it been renamed/removed?`);
  const parenStart = src.indexOf('(', m.index);
  let pdepth = 0, j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') { pdepth--; if (pdepth === 0) { j++; break; } }
  }
  const braceStart = src.indexOf('{', j);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(m.index, i);
}

/** A stand-in for the popup `window.open` returns: just enough of the
 *  document API for the real sgrWritePrintWindow to run against, plus a
 *  `title` property that records what the print dialog would read. */
function fakePrintWindow() {
  const w: any = {
    written: '',
    document: {
      title: '',
      open() { w.written = ''; },
      write(html: string) { w.written += html; },
      close() { /* no-op */ },
    },
  };
  return w;
}

/** What the browser would actually offer as a filename: the printed document's
 *  title, plus '.pdf'. */
function suggestedPdfName(w: any): string {
  return w.document.title + '.pdf';
}

function main() {
  if (!fs.existsSync(INDEX_HTML_PATH)) {
    console.error(`[pdf-filename] index.html not found at ${INDEX_HTML_PATH} — set INDEX_HTML_PATH.`);
    process.exit(1);
  }
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const startMarker = '<script type="text/babel" data-presets="react-classic">';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.lastIndexOf('</script>');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('Could not locate the main <script type="text/babel"> block in index.html');
  }
  const appSrc = html.slice(startIdx + startMarker.length, endIdx);

  // ── The real helpers, evaluated as they are written ──────────────────────
  const extracted = [
    extractFunction(appSrc, 'sgrDocFileName'),
    extractFunction(appSrc, 'sgrWithDocTitle'),
    extractFunction(appSrc, 'sgrJobInvoiceNumber'),
    extractFunction(appSrc, 'sgrWritePrintWindow'),
    extractFunction(appSrc, 'sgrApplyPrintMargins'),
  ].join('\n\n');
  const sandbox: any = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(
      `${extracted}\nglobalThis.__api = { sgrDocFileName, sgrWithDocTitle, sgrJobInvoiceNumber, sgrWritePrintWindow, sgrApplyPrintMargins };`,
      sandbox, { filename: 'index.html-extracted.js' }
    );
  } catch (e: any) {
    console.error('[pdf-filename] Extracted source failed to evaluate — index.html likely changed shape:', e.message);
    process.exit(1);
  }
  const api = sandbox.__api;

  // ══ 1 — the mechanism is title-based, for all four documents ═════════════
  console.log('\n[1] all four documents print through a popup + window.print(), so the filename comes from the title');
  {
    for (const fn of ['printQuoteWindow', 'printInvoice', 'printProformaWindow', 'printManualInvoice']) {
      const body = extractFunction(appSrc, fn);
      ok(/sgrOpenPrintPreview\(/.test(body), `${fn} prints through the shared print-preview popup`, body.slice(0, 160));
      ok(!/\.download\s*=|createObjectURL/.test(body), `${fn} uses no download/Blob path — nothing else could name the file`);
    }
    const jobCard = extractFunction(appSrc, 'printJobCard');
    ok(/window\.open\(/.test(jobCard) && /window\.print\(\)/.test(jobCard),
      'printJobCard prints from its own popup (it does not use the margin preview)');
    ok(!/\.download\s*=|createObjectURL/.test(jobCard), 'printJobCard uses no download/Blob path either');
    const preview = extractFunction(appSrc, 'sgrOpenPrintPreview');
    ok(/window\.open\('', '_blank'/.test(preview) && /sgrWritePrintWindow\(/.test(preview),
      'the shared print handler opens an about:blank popup and writes it through sgrWritePrintWindow');
    ok(!/\.download\s*=|createObjectURL/.test(preview), 'and never through a download link');
  }

  // ══ 2–5 — each document's suggested filename carries its own number ══════
  console.log('\n[2,3,4,5] the suggested filename carries the correct document number');
  {
    const cases = [
      { label: 'Quote',    docNumber: 'SQ-00150',  fallback: 'Quotation ', expect: 'SQ-00150.pdf',  pattern: /^SQ-\d{5}\.pdf$/ },
      { label: 'Invoice',  docNumber: 'INV-00111', fallback: 'Invoice ',   expect: 'INV-00111.pdf', pattern: /^INV-\d{5}\.pdf$/ },
      { label: 'Proforma', docNumber: 'PRO-00103', fallback: 'Proforma ',  expect: 'PRO-00103.pdf', pattern: /^PRO-\d{5}\.pdf$/ },
      { label: 'Job Card', docNumber: 'SNS-00110', fallback: 'Job Card',   expect: 'SNS-00110.pdf', pattern: /^SNS-\d{5}\.pdf$/ },
    ];
    for (const c of cases) {
      const name = api.sgrDocFileName(c.docNumber, c.fallback);
      const w = fakePrintWindow();
      api.sgrWritePrintWindow(w, `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Something_Else</title></head><body>x</body></html>`, name);
      ok(suggestedPdfName(w) === c.expect, `${c.label}: the Save dialog would offer "${c.expect}"`, suggestedPdfName(w));
      ok(c.pattern.test(suggestedPdfName(w)), `${c.label}: and it contains the document number in its own format`, suggestedPdfName(w));
      ok(new RegExp(`<title>${c.docNumber}</title>`).test(w.written),
        `${c.label}: the written document carries the same title, so the two can never disagree`, w.written.slice(0, 120));
      ok(!/Something_Else/.test(w.written), `${c.label}: any pre-existing title in the generated HTML is replaced, not duplicated`);
    }
  }

  // ══ Each print entry point actually passes its own number ════════════════
  console.log('\n[2,3,4,5] …and every entry point really does hand its number to the print call');
  {
    const quote = extractFunction(appSrc, 'printQuoteWindow');
    ok(/sgrOpenPrintPreview\(html, 'Quotation '\+\(q\.num\|\|''\), q\.num\)/.test(quote),
      'printQuoteWindow passes the quote number (q.num)', quote.slice(-120));

    const invoice = extractFunction(appSrc, 'printInvoice');
    ok(/sgrOpenPrintPreview\(html, [^,]+, sgrJobInvoiceNumber\(job\)\)/.test(invoice),
      'printInvoice passes the job’s invoice number via the shared sgrJobInvoiceNumber()', invoice.slice(-140));

    const proforma = extractFunction(appSrc, 'printProformaWindow');
    ok(/sgrOpenPrintPreview\(html, [^,]+, proformaNum\|\|quote\.num\)/.test(proforma),
      'printProformaWindow passes the proforma number (falling back to the quote number)', proforma.slice(-140));

    const manual = extractFunction(appSrc, 'printManualInvoice');
    ok(/sgrOpenPrintPreview\(html, [^,]+, inv\.number\)/.test(manual),
      'printManualInvoice passes the accInvoices record’s own number', manual.slice(-140));

    const jobCard = extractFunction(appSrc, 'printJobCard');
    ok(/sgrWritePrintWindow\(w, html, sgrDocFileName\(job\.num, 'Job Card'\)\)/.test(jobCard),
      'printJobCard names its popup with the job number (SNS-#####)', jobCard.slice(-160));

    // The builders still emit their own <title> too — belt and braces, and what
    // makes the popup correct even before sgrWritePrintWindow assigns it.
    ok(/<title>Quotation_\$\{q\.num\}<\/title>/.test(appSrc), 'the quote builder still emits a <title> of its own');
    ok(/<title>Invoice_'\+invNum\+'<\/title>/.test(appSrc), 'the invoice builders still emit a <title> of their own');
    ok(/<title>Proforma_'\+proformaNum\+'<\/title>/.test(appSrc), 'the proforma builder still emits a <title> of its own');
    ok(/<title>Job Card '\+job\.num\+'<\/title>/.test(appSrc), 'the job card builder still emits a <title> of its own');

    // sgrJobInvoiceNumber is the ONE derivation, shared by the printed document
    // and the filename — they cannot drift apart.
    ok(api.sgrJobInvoiceNumber({ invoiceNum: 'INV-00111', num: 'SNS-00110' }) === 'INV-00111',
      'sgrJobInvoiceNumber prefers the job’s real invoice number');
    ok(api.sgrJobInvoiceNumber({ num: 'SNS-00110' }) === 'INV-00110',
      'and falls back to the historic job-number derivation when there is none');
    ok(/const invNum = sgrJobInvoiceNumber\(job\);/.test(appSrc),
      'the printed invoice document derives its number from that same helper');
  }

  // ══ 6 — never blank ═════════════════════════════════════════════════════
  console.log('\n[6] the filename is never blank — for any input at all');
  {
    const nasty: Array<[unknown, string]> = [
      [undefined, 'Quotation '], [null, 'Invoice '], ['', 'Proforma '], ['   ', 'Job Card'],
      ['///', 'Invoice '], ['...', 'Quotation '], [0, 'Invoice '], [false, 'Invoice '],
    ];
    for (const [raw, fallback] of nasty) {
      const name = api.sgrDocFileName(raw, fallback);
      ok(typeof name === 'string' && name.trim().length > 0,
        `sgrDocFileName(${JSON.stringify(raw)}) is non-empty → "${name}"`, name);
      ok(!/^[. ]|[. ]$/.test(name), `and has no leading/trailing dot or space (Windows rejects those) → "${name}"`, name);
    }
    ok(api.sgrDocFileName(undefined, undefined) === 'Document',
      'with no fallback either, it still produces something usable rather than an empty name');
    // A blank number really does fall back to the document type, end to end.
    const w = fakePrintWindow();
    api.sgrWritePrintWindow(w, '<html><head></head><body></body></html>', api.sgrDocFileName('', 'Quotation '));
    ok(suggestedPdfName(w) === 'Quotation.pdf', 'a quote with no number still offers "Quotation.pdf", never ".pdf"', suggestedPdfName(w));
  }

  // ══ 7 — the application title is never changed ══════════════════════════
  console.log('\n[7] the application’s own title is never changed, so there is nothing to restore');
  {
    const appTitle = /<title>([^<]*)<\/title>/.exec(html);
    ok(!!appTitle && appTitle[1].trim().length > 0, 'index.html still has its own application <title>', appTitle && appTitle[1]);
    // Every assignment to a document title in the app must be to the POPUP's
    // document (w.document.title), never the main one. If a future change ever
    // needs to touch document.title, this fails and forces the restore to be
    // written and tested with it.
    const assignments = appSrc.match(/[\w.]*document\.title\s*=/g) || [];
    ok(assignments.length > 0, 'the print path does set a document title (that is the whole mechanism)', assignments);
    ok(assignments.every((a) => /w\.document\.title\s*=/.test(a)),
      'and every single assignment targets the print popup’s document, never the application’s own', assignments);
    ok(!/document\.title\s*=\s*[^;]*;\s*[\s\S]{0,400}?document\.title\s*=\s*(prev|old|original)/.test(appSrc),
      'so no save-and-restore dance exists to get wrong');
  }

  // ══ 8 — repeatable ══════════════════════════════════════════════════════
  console.log('\n[8] printing the same document repeatedly gives the same filename every time');
  {
    const doc = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice_INV-00111</title></head><body>x</body></html>';
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const w = fakePrintWindow();
      api.sgrWritePrintWindow(w, api.sgrApplyPrintMargins(doc, { top: 12, right: 15, bottom: 15, left: 15 }), api.sgrDocFileName('INV-00111', 'Invoice '));
      names.push(suggestedPdfName(w));
    }
    ok(names.every((n) => n === 'INV-00111.pdf'), 'three consecutive prints all offer INV-00111.pdf', names);
    // …and the margin override the preview injects does not disturb the title.
    const w = fakePrintWindow();
    const withMargins = api.sgrApplyPrintMargins(doc, { top: 5, right: 5, bottom: 5, left: 5 });
    api.sgrWritePrintWindow(w, withMargins, api.sgrDocFileName('INV-00111', 'Invoice '));
    ok(/sgr-margin-override/.test(w.written), 'the chosen print margins are still applied to the written document', w.written.slice(0, 200));
    ok(suggestedPdfName(w) === 'INV-00111.pdf', 'and the filename is unaffected by them', suggestedPdfName(w));
  }

  // ══ 9 — sanitising only what is genuinely invalid ═══════════════════════
  console.log('\n[9] only genuinely invalid filename characters are removed — the document number survives intact');
  {
    ok(api.sgrDocFileName('SQ-00150', 'Quotation ') === 'SQ-00150', 'hyphens and digits are preserved exactly');
    ok(api.sgrDocFileName('INV/00111', 'Invoice ') === 'INV 00111', 'a slash is replaced, not the whole name discarded');
    ok(api.sgrDocFileName('INV:00111*?"<>|', 'Invoice ') === 'INV 00111', 'every character Windows rejects is removed');
    ok(api.sgrDocFileName('SNS-00110  ', 'Job Card') === 'SNS-00110', 'surrounding whitespace is trimmed');
    ok(api.sgrDocFileName('PRO-00103\n', 'Proforma ') === 'PRO-00103', 'a stray newline cannot reach the dialog');
    ok(api.sgrDocFileName('A'.repeat(400), 'Invoice ').length <= 120, 'an absurdly long value is capped rather than rejected by the OS');
    // The title written into the document can never break out of the tag.
    const w = fakePrintWindow();
    api.sgrWritePrintWindow(w, '<html><head></head><body></body></html>', api.sgrDocFileName('INV-00111', 'Invoice '));
    ok(/<title>INV-00111<\/title>/.test(w.written), 'a document with no <title> at all has one inserted into its <head>', w.written);
    const w2 = fakePrintWindow();
    api.sgrWritePrintWindow(w2, '<html><head></head><body></body></html>', '</title><script>bad()</script>');
    ok(!/<script>bad/.test(w2.written), 'and a title value can never inject markup into the printed document', w2.written);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`[pdf-filename] ${passed} passed, ${failures} failed`);
  console.log('='.repeat(60));
  process.exit(failures > 0 ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error('\n[pdf-filename] Fatal error:', err);
  process.exit(1);
}
