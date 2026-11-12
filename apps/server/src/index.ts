#!/usr/bin/env node
import { Claude } from '@bibbly/core/claude';
import { startServer } from './server.js';

/**
 * Starts the rooms server. Translation uses Claude when credentials are
 * available (ANTHROPIC_API_KEY or an `ant auth login` profile); without them,
 * listeners still get live captions in the original language.
 */
const port = Number(process.env.PORT ?? 8787);
const model = process.env.BIBBLY_CLAUDE_MODEL;
const translationOff = process.env.BIBBLY_TRANSLATION === 'off';

let translator: Claude | null = null;
if (!translationOff) {
  try {
    translator = new Claude({ ...(model ? { model } : {}), fast: process.env.BIBBLY_FAST_MODE === '1' });
  } catch (err) {
    console.warn(`Translation is off: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const server = await startServer({ port, translator });
console.log(`Bibbly rooms server on http://localhost:${server.port} (translation ${translator ? `on, ${translator.model}` : 'off'})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void server.close().then(() => process.exit(0)); });
