// Creature Lab desktop shell: serves the built studio from a local http server
// (module workers need http, not file://) and opens it in a native window.
const { app, BrowserWindow, shell, Menu } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.png': 'image/png', '.json': 'application/json' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const f = path.join(root, path.normalize(p));
      if (!f.startsWith(root)) return res.writeHead(403).end();
      fs.readFile(f, (err, data) => {
        if (err) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

async function main() {
  const port = await serve();
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0c0e11', title: 'Creature Lab',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${port}/`);
}
app.whenReady().then(main);
app.on('window-all-closed', () => app.quit());
