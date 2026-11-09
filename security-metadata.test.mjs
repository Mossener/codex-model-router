import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

let security;
try { security = await import('./security-metadata.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

test('security metadata implementation is available', () => assert.equal(typeof security?.classifyError, 'function'));

if (security) {
  test('errors, unknown models and event names cannot persist attacker-controlled content', () => {
    const secret = 'sk-SYNTHETIC-private-value';
    const result = security.safeRequestEvent({ at: new Date().toISOString(), route: 'agentrouter', model: secret, accountId: secret,
      status: 429, ms: 4, bytes: 50, error: `Token rate limit exceeded ${secret}`, failed: `server_error ${secret}`,
      opened: `${secret}:12`, body: { password: secret }, usage: { totalTokens: 9, secret } }, new Set(['gpt-6.1-sol-ar']));
    assert.equal(result.error, 'rate_limit');
    assert.equal(result.failed, 'upstream_unavailable');
    assert.equal(result.model, 'unknown');
    assert.equal(result.opened, 'other:12');
    assert.equal(result.usage.totalTokens, 9);
    assert.equal(JSON.stringify(result).includes(secret), false);
  });

  test('diagnostics retain useful counts without request or response content', () => {
    const secret = 'SYNTHETIC_password_!';
    const result = security.safeDiagnostic({ at: new Date().toISOString(), route: 'agentrouter', status: 400, level: 2, bodyBytes: 100,
      body: { password: secret }, responseText: secret, failure: { message: secret }, error: `invalid_encrypted_content ${secret}` });
    assert.equal(result.error, 'encrypted_context');
    assert.equal(result.bodyBytes, 100);
    assert.equal(result.body, undefined);
    assert.equal(result.failure, undefined);
    assert.equal(JSON.stringify(result).includes(secret), false);
  });

  test('a connection failure is classified by the layer that actually broke', () => {
    const cases = {
      'proxy ECONNREFUSED 127.0.0.1:10808': 'proxy_unreachable',
      'proxy tunnel closed before CONNECT': 'proxy_unreachable',
      'getaddrinfo ENOTFOUND agentrouter.org': 'dns_failure',
      'Client network socket disconnected before secure TLS connection was established': 'tls_handshake',
      'ERR_SSL_WRONG_VERSION_NUMBER': 'tls_handshake',
      'connect ETIMEDOUT 8.214.160.125:443': 'connect_timeout',
      'ECONNRESET socket hang up agentrouter.org:443': 'transport_error',
    };
    for (const [text, category] of Object.entries(cases)) assert.equal(security.classifyError(text), category, text);
  });

  for (const stream of [false, true]) {
    test(`${stream ? 'stream failure' : 'HTTP refusal'} never saves the submitted or echoed credential`, async t => {
      const secret = 'sk-SYNTHETIC-only-for-this-test';
      const directory = mkdtempSync(join(tmpdir(), 'gateway-safe-diagnostics-'));
      const events = [];
      const upstream = http.createServer((req, res) => {
        req.resume();
        if (stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ type: secret, delta: secret })}\n\n`);
          res.end(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: secret, message: secret } } })}\n\n`);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `invalid encrypted content ${secret}` } }));
        }
      });
      upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
      process.env.CODEX_MODEL_GATEWAY_HINTS = join(directory, 'hints.json');
      const { createRouter } = await import('./router.mjs');
      const router = createRouter({ defaultBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, agentrouterBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, getClientToken: () => 'synthetic-client', getAgentrouterToken: () => 'synthetic-upstream',
        diagnosticsDirectory: directory, log: event => events.push(event), catalog: { models: [] } });
      router.listen(0, '127.0.0.1'); await once(router, 'listening');
      t.after(() => { router.closeAllConnections(); router.close(); upstream.closeAllConnections(); upstream.close(); });
      const reply = await fetch(`http://127.0.0.1:${router.address().port}/v1/responses`, { method: 'POST',
        headers: { Authorization: 'Bearer synthetic-client', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.1-sol-ar', input: secret }) });
      await reply.text();
      const diagnostic = readFileSync(join(directory, stream ? 'last-failed.json' : 'last-rejected.json'), 'utf8');
      assert.equal(diagnostic.includes(secret), false);
      assert.equal(JSON.stringify(events).includes(secret), false);
      assert.equal(JSON.parse(diagnostic).bodyBytes > 0, true);
    });
  }
}
