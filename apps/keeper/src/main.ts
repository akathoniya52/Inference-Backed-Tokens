import './version-check.js';
import { createHealthServer } from './health-server.js';

const port = Number(process.env.KEEPER_PORT ?? 4001);

createHealthServer().listen(port, () => {
  process.stdout.write(`keeper health server listening on http://localhost:${port}\n`);
});
