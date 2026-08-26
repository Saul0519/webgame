// Fold the built client into one HTML file with no external requests.
//
//   pnpm --filter @webgame/client build:standalone
//   node tools/build-standalone.mjs
//
// The output is shaped for an embedding host that supplies its own document
// skeleton: it carries a <title>, a stylesheet link, inline CSS and inline JS,
// but no <html>/<head>/<body> of its own.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps/client/dist-standalone');
const out = join(dist, 'reactor.html');

for (const f of ['app.js', 'app.css']) {
  if (!existsSync(join(dist, f))) {
    console.error(`missing ${f} — run the standalone vite build first`);
    process.exit(1);
  }
}

const css = readFileSync(join(dist, 'app.css'), 'utf8');
// A literal </script> inside a string would close the tag early.
const js = readFileSync(join(dist, 'app.js'), 'utf8').replaceAll('</script', '<\\/script');

const html = `<title>REACTOR Arena</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&family=JetBrains+Mono:wght@400;700&display=swap"
  rel="stylesheet"
/>
<style>
${css}
</style>
<div id="app"></div>
<script type="module">
${js}
</script>
`;

writeFileSync(out, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`wrote ${out} (${kb} KB)`);
