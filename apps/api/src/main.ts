import './version-check.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);

createApp().listen(port, () => {
  process.stdout.write(`api listening on http://localhost:${port}\n`);
});
