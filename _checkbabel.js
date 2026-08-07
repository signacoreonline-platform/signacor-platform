const fs = require('fs');
const babel = require('@babel/core');
const html = fs.readFileSync(__dirname + '/index.html','utf8');
const m = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if(!m){ console.log('no script block found'); process.exit(1); }
const code = m[1];
try {
  babel.transform(code, { presets: ['@babel/preset-react'] });
  console.log('BABEL PARSE OK — no syntax errors');
} catch(e) {
  console.log('BABEL ERROR:', e.message);
}
