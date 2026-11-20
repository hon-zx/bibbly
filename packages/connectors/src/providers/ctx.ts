import type { AuthSource, Http } from '../http.js';
import type { Endpoints } from './registry.js';

/** What every provider client needs: an HTTP client, a token source and the endpoints. */
export interface ApiCtx {
  http: Http;
  auth: AuthSource;
  ep: Endpoints;
  now?: () => number;
}
