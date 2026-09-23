import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  }),
  esbuild.context({
    ...common,
    entryPoints: { webview: 'webview/main.ts' },
    outdir: 'dist',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    loader: { '.css': 'text' },
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
