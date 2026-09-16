// Keep Webpack's compilation heap out of the browser measurement process.
import webpack from 'webpack';
import { fileURLToPath } from 'node:url';

const compiler = webpack({ mode: 'development', devtool: false,
  entry: fileURLToPath(new URL(process.argv.includes('--pixels')
    ? './fixtures/cloud-shadow-pixels.ts' : './fixtures/performance-scene.ts', import.meta.url)),
  output: { path: process.argv[2], filename: 'fixture.js' },
  resolve: { extensions: ['.ts', '.js'] },
  module: { rules: [
    { test: /\.ts$/, use: { loader: 'ts-loader', options: { transpileOnly: true, compilerOptions: { rootDir: process.cwd() } } } },
    { test: /\.png$/, type: 'asset/resource' },
    { test: /\.wasm$/, type: 'asset/resource', generator: { filename: 'lerc-wasm.wasm' } },
  ] },
});
await new Promise((resolve, reject) => compiler.run((error, stats) => {
  compiler.close(() => {
    if (error || stats?.hasErrors()) reject(error ?? new Error(stats.toString('errors-only')));
    else resolve();
  });
}));
