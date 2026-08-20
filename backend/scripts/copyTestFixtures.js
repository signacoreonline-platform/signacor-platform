// Copies test/fixtures/*.json into dist/test/fixtures/ after the test
// build compiles test/*.ts -> dist/test/*.js. Plain Node (fs.cpSync, no
// shell utilities) so this runs identically on Windows/macOS/Linux via
// `npm run build:test` — avoids relying on `cp`/`mkdir -p`, which do not
// exist on a plain Windows cmd.exe/PowerShell prompt.
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '..', 'test', 'fixtures');
const dest = path.resolve(__dirname, '..', 'dist', 'test', 'fixtures');

fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`Copied test fixtures: ${src} -> ${dest}`);
