import { readFileSync } from 'node:fs';

if (process.argv.includes('--version-check')) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    name: string;
    version: string;
  };
  process.stdout.write(`${pkg.name} ${pkg.version} node ${process.version}\n`);
  process.exit(0);
}
