// Simple server to test GitHub Pages deployment locally
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 3000;
const BASE_PATH = '/data-acquisition';
const DIST_DIR = join(__dirname, 'dist');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.svg': 'image/svg+xml',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
};

const server = createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);
  
  // Remove base path from URL
  let path = req.url.startsWith(BASE_PATH) 
    ? req.url.slice(BASE_PATH.length) 
    : req.url;
  
  // Remove query string
  path = path.split('?')[0];
  
  // Default to index.html
  if (path === '/' || path === '') {
    path = '/index.html';
  }
  
  let filePath = join(DIST_DIR, path);
  
  // If file doesn't exist and it's not an asset, serve index.html (SPA routing)
  if (!existsSync(filePath) && !path.startsWith('/assets/')) {
    filePath = join(DIST_DIR, 'index.html');
  }
  
  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (error) {
    res.writeHead(404);
    res.end('404 Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Testing GitHub Pages deployment locally`);
  console.log(`📍 Base path: ${BASE_PATH}`);
  console.log(`🌐 Server: http://localhost:${PORT}${BASE_PATH}/`);
  console.log(`🔗 Dashboard: http://localhost:${PORT}${BASE_PATH}/dashboard`);
  console.log(`\nThis simulates: https://western-formula-racing.github.io/data-acquisition/\n`);
});
