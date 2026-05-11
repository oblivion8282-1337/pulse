import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Serves /deepfilternet3/** from static/ without Content-Encoding: gzip.
// Vite treats .gz files as precompressed and adds Content-Encoding: gzip,
// which causes the browser to transparently decompress the tar.gz before
// the DFN3 WASM receives it — leading to a double-gunzip panic in df_create.
function dfn3StaticPlugin() {
  const staticDir = path.resolve(__dirname, 'static');
  const handler = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    next: () => void
  ) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/deepfilternet3/')) {
      next();
      return;
    }
    const filePath = path.join(staticDir, url);
    if (!filePath.startsWith(staticDir + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!fs.existsSync(filePath)) {
      next();
      return;
    }
    const contentType = filePath.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  };
  return {
    name: 'dfn3-static',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server: import('vite').PreviewServer) {
      server.middlewares.use(handler);
    }
  };
}

export default defineConfig({
  plugins: [dfn3StaticPlugin(), tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api/auth': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/auth/, '')
      },
      '/api/chat': {
        target: 'http://127.0.0.1:8002',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/chat/, '')
      },
      '/api/voice': {
        target: 'http://127.0.0.1:8003',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/voice/, '')
      },
      '/api/ws': {
        target: 'ws://127.0.0.1:8002',
        ws: true,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/ws/, '')
      }
    }
  }
});
