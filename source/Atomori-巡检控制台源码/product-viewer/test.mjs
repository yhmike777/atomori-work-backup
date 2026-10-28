import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join, sep } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
const root = dirname(fileURLToPath(import.meta.url));
const dependencies = resolve(process.argv[2] || join(root, 'node_modules'));
const { build } = await import(pathToFileURL(join(dependencies, 'esbuild/lib/main.js')));
// Keep bundles beside their source so the model test retains its relative GLB URL.
const temporary = await mkdtemp(join(root, '.checks-'));
try {
  for (const name of ['model-layouts', 'test_transitions', 'test_two_hand_motion', 'test_palm_motion', 'test_hand_pose', 'test_camera_lifecycle']) {
    const output = join(temporary, `${name}.mjs`);
    await build({entryPoints:[join(root, 'tests', `${name}.mjs`)], outfile:output, bundle:true, platform:'node', format:'esm', target:'es2022', nodePaths:[dependencies]});
    await import(pathToFileURL(output));
  }
} finally {
  const cleanupPath = resolve(temporary);
  if (!cleanupPath.startsWith(`${resolve(root)}${sep}.checks-`)) throw new Error('Unexpected test output directory');
  await rm(cleanupPath, {recursive:true, force:true});
}
