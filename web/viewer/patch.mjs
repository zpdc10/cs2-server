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
// The landing page (viewer/UploadPage.jsx) is the upload box with a short note and a link back to /demos.
patch('src/App.jsx', [
  ['import { Home } from "./Index/Home";', 'import { UploadPage } from "./UploadPage";'],
  ['<Home path="/" />', '<UploadPage path="/viewer/" />'],
  ['<Route path="/player" component={PlayerApp} />', '<Route path="/viewer/player" component={PlayerApp} />'],
]);
patch('src/Index/Uploader/Uploader.jsx', [
  ['route("/player");', 'route("/viewer/player");'],
  ['route(`/player?demourl=', 'route(`/viewer/player?demourl='],
  // Only demos hosted on this site can be loaded by link (/viewer/download is not an open proxy).
  ['placeholder="http://replay392.valve.net/730/….dem.bz2"', 'placeholder="Demo link from this site\'s Demos page"'],
]);

// The parser (patched in the Dockerfile) posts "parse-error:<reason>" when a demo can't be read; show it.
patch('src/Player/PlayerApp.jsx', [
  ['      if (e.data === "ready") {\n        setIsWasmLoaded(true);\n      } else {',
    '      if (e.data === "ready") {\n        setIsWasmLoaded(true);\n      } else if (typeof e.data === "string" && e.data.startsWith("parse-error:")) {\n'
    + '        setIsError(true);\n        setLoadingMessage(["This demo could not be read by the 2D viewer.", e.data.slice(12)]);\n      } else {'],
]);

// Demos stored on this server are parsed on the server (bin/replay, see src/replays.js). The player fetches
// /viewer/replay (gzip protobuf frames; 202 while the server prepares it) instead of downloading the .dem.
// The WebAssembly parser is only loaded for a visitor's own file.
patch('src/Player/PlayerApp.jsx', [
  ['  useEffect(() => {\n    console.log("isWasmLoaded", isWasmLoaded);',
    `  const loadServerReplay = (demoUrl, attempt = 0) => {
    fetch(\`/viewer/replay?url=\${encodeURIComponent(demoUrl)}\`)
      .then(async (res) => {
        if (!worker.current) return;
        if (res.status === 202 && attempt < 600) {
          const info = await res.json().catch(() => ({}));
          setLoadingMessage(["Preparing this demo on the server...", "This only happens once per demo and takes up to a minute.", info.message || ""]);
          setTimeout(() => loadServerReplay(demoUrl, attempt + 1), 3000);
          return;
        }
        if (!res.ok) {
          const info = await res.json().catch(() => ({}));
          throw new Error(info.error || \`HTTP \${res.status}\`);
        }
        setLoadingMessage(["Downloading replay..."]);
        const buf = await res.arrayBuffer();
        if (!worker.current) return;
        setLoadingMessage(["Loading match..."]);
        worker.current.postMessage({ replay: buf }, [buf]);
      })
      .catch((error) => {
        setIsError(true);
        setLoadingMessage(["This demo could not be loaded.", error.message]);
      });
  };

  useEffect(() => {
    console.log("isWasmLoaded", isWasmLoaded);`],
  ['      const demoUrl = location.query.demourl;\n      setIsDownloading(true);',
    '      const demoUrl = location.query.demourl;\n      setLoadingMessage(["Loading replay..."]);\n      loadServerReplay(demoUrl);\n      return;\n      setIsDownloading(true);'],
]);
patch('src/Player/demo.worker.js', [
  ['self.onmessage = ({ data: { filename, data } }) => {',
    `// Frames from the server: [uint32 little-endian length][protobuf Message], repeated.
function postReplay(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  while (off + 4 <= bytes.length) {
    const len = view.getUint32(off, true);
    off += 4;
    if (off + len > bytes.length) break;
    self.postMessage(decodeMessage(bytes.subarray(off, off + len)));
    off += len;
  }
}

self.onmessage = ({ data: msg }) => {
  if (msg && msg.replay) {
    postReplay(new Uint8Array(msg.replay));
    return;
  }
  const { filename, data } = msg;`],
  ['    globalThis.wasmParseDemo(filename, data, (payload) => {',
    '    (wasmLoading ||= loadWasm()).then(() => globalThis.wasmParseDemo(filename, data, (payload) => {'],
  ['      );\n    });\n  }\n};', '      );\n    }));\n  }\n};'],
  ['async function loadWasm() {', 'let wasmLoading = null;\nasync function loadWasm() {'],
  ['\nloadWasm();', '\n// The parser is loaded on first use (a visitor\'s own file); server replays never need it.\nself.postMessage("ready");'],
]);

fs.copyFileSync(new URL('./UploadPage.jsx', import.meta.url), 'src/UploadPage.jsx');

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
