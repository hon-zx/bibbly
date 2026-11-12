// Bundles the Electron main and preload scripts. @bibbly/core is bundled in;
// SDKs stay as runtime dependencies that electron-builder packages.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron', '@anthropic-ai/sdk', 'microsoft-cognitiveservices-speech-sdk'],
};

await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' });
