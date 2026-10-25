import { startTestServer } from './server.ts';

const port = Number(process.env['PORT'] ?? 8787);
const server = await startTestServer({ port });
console.info(`Servare test server listening on ${server.origin}`);
console.info('Pages: / | media: /media/... | big file: /synthetic/2gb.bin');

const stop = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
