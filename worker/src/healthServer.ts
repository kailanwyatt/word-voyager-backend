import { createServer, type Server } from 'node:http';

/**
 * Railway (and similar hosts) inject PORT and may health-check it during
 * deploys. A polling worker must still bind so checks return 200 instead of
 * flapping the deployment and sending SIGTERM.
 */
export function startHealthServer(port = Number(process.env.PORT || 8080)): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  server.listen(port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[study-worker] health listening on 0.0.0.0:${port}`);
  });

  server.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.error('[study-worker] health server error', error);
  });

  return server;
}
