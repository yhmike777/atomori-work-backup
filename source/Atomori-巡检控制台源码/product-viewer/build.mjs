import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
const dependencies = resolve(process.argv[2] || join(root, 'node_modules'));
const { build } = await import(pathToFileURL(join(dependencies, 'vite/dist/node/index.js')));
await build({
  root, configFile: false, base: './',
  resolve: { alias: [
    { find: /^three\/addons\//, replacement: join(dependencies, 'three/examples/jsm/').replaceAll('\\', '/') },
    { find: /^three$/, replacement: join(dependencies, 'three/build/three.module.js') },
  ] },
  build: { outDir: resolve(root, '../assets/product-viewer'), emptyOutDir: false, target: 'es2022' },
});
