#!/usr/bin/env node
import { Claude } from '@bibbly/core/claude';
import { brokerOptionsFromEnv } from './oauth-broker.js';
import { startServer } from './server.js';

/**
 * Starts the Bibbly server: rooms (live captions shared by link) and the
 * sign-in broker for connected apps (its environment variables are listed in
 * oauth-broker.ts). Translation uses Claude when credentials are available
 * (ANTHROPIC_API_KEY or an `ant auth login` profile); without them, listeners
 * still get live captions in the original language.
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

const server = await startServer({ port, translator, oauth: brokerOptionsFromEnv(process.env) });
const apps = server.broker?.configured() ?? [];
console.log(`Bibbly server on http://localhost:${server.port} (translation ${translator ? `on, ${translator.model}` : 'off'}; connected apps: ${apps.length ? apps.join(', ') : 'none set up'})`);
if (apps.length) console.log(`OAuth redirect URIs: ${server.broker!.redirectUri(apps[0]!).replace(apps[0]!, '<provider>')}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void server.close().then(() => process.exit(0)); });
