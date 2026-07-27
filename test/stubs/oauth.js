// Stand-in for `@cloudflare/workers-oauth-provider`.
//
// The worker's default export is `new OAuthProvider(oauthConfig)`, and oauthConfig is
// not exported separately. Capturing the constructor argument is what gives the tests
// a handle on the real apiHandler — so the env → _kv / _allowImport wiring under test
// is the production code path, not a reimplementation of it.
export class OAuthProvider {
  constructor(opts) {
    this.opts = opts;
  }
}

export function getOAuthApi() {
  return {};
}
