// Bundles the Electron main and preload scripts. @bibbly/core and @bibbly/connectors are bundled in;
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
  // Desktop OAuth client ids for signing in to Google and Microsoft straight from the app.
  // They're public (no secret), so release builds can embed them; leave unset to sign in via the Bibbly server.
  define: {
    __BIBBLY_GOOGLE_DESKTOP_CLIENT_ID__: JSON.stringify(process.env.BIBBLY_GOOGLE_DESKTOP_CLIENT_ID ?? ''),
    __BIBBLY_GOOGLE_DESKTOP_CLIENT_SECRET__: JSON.stringify(process.env.BIBBLY_GOOGLE_DESKTOP_CLIENT_SECRET ?? ''),
    __BIBBLY_MICROSOFT_CLIENT_ID__: JSON.stringify(process.env.BIBBLY_MICROSOFT_CLIENT_ID ?? ''),
  },
};

await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' });
