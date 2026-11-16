// Adapts the upstream CS2 2D demo viewer (sparkoo/csgo-2d-demo-viewer, MIT) to run under
// /viewer/ on this panel, with no third-party requests. Run from the upstream web/ folder:
//   node /path/to/patch.mjs
// Every replacement must match exactly once, so an upstream change fails the build loudly
// instead of shipping a half-patched viewer.
import fs from 'node:fs';

function patch(file, pairs) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    const count = text.split(from).length - 1;
    if (count !== 1) throw new Error(`${file}: expected exactly one "${from}", found ${count}`);
    text = text.replace(from, to);
  }
  fs.writeFileSync(file, text);
}

// Routes live under /viewer/. The landing page is reduced to the uploader (local file / URL);
// the upstream home page links to Faceit, browser extensions and a hosted match list we do not run.
patch('src/App.jsx', [
  ['import { Home } from "./Index/Home";', 'import Uploader from "./Index/Uploader/Uploader";'],
  ['<Home path="/" />', '<Uploader path="/viewer/" />'],
  ['<Route path="/player" component={PlayerApp} />', '<Route path="/viewer/player" component={PlayerApp} />'],
]);
patch('src/Index/Uploader/Uploader.jsx', [
  ['route("/player");', 'route("/viewer/player");'],
  ['route(`/player?demourl=', 'route(`/viewer/player?demourl='],
  // Only demos hosted on this site can be loaded by link (/viewer/download is not an open proxy).
  ['placeholder="http://replay392.valve.net/730/….dem.bz2"', 'placeholder="Demo link from this site\'s Demos page"'],
]);

// Self-hosted icon font and W3.CSS stand-ins instead of fonts.googleapis.com and w3schools.com.
fs.copyFileSync(new URL('./compat.css', import.meta.url), 'src/viewer-compat.css');
patch('src/index.jsx', [
  ["import { App } from './App';", "import { App } from './App';\nimport '@fontsource/material-icons';\nimport './viewer-compat.css';"],
]);
patch('index.html', [
  ['<link\n      rel="stylesheet"\n      href="https://fonts.googleapis.com/icon?family=Material+Icons"\n    />\n', ''],
  ['<link rel="stylesheet" href="https://www.w3schools.com/w3css/4/w3.css" />\n', ''],
  ['<link rel="icon" href="/favicon.ico" />', '<link rel="icon" href="/viewer/favicon.ico" />'],
  ['<link rel="stylesheet" href="/style.css" />', '<link rel="stylesheet" href="/viewer/style.css" />'],
  ['<link rel="manifest" href="/manifest.json" />\n', ''],
]);
console.log('viewer patched');
