import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ERROR_CODES,
  ProtocolClientError,
  parseResponse,
  type JsonRpcError,
  type JsonRpcResponse,
} from '../../src/protocol/index.js';
import { ScriptedHost, flush, newScriptedSession, wire } from './support.js';

const HANDSHAKE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } };

function errorOf(response: JsonRpcResponse | undefined): JsonRpcError | null {
  return response !== undefined && 'error' in response ? response.error : null;
}

/** Send raw lines and collect what comes back, so malformed input can be tested at all. */
async function raw(lines: readonly (string | object)[]): Promise<JsonRpcResponse[]> {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  const { clientTransport } = wire(host);
  const responses: JsonRpcResponse[] = [];
  clientTransport.onMessage((line) => {
    const parsed = parseResponse(line);
    if (parsed !== null) responses.push(parsed);
  });
  for (const line of lines) clientTransport.send(typeof line === 'string' ? line : JSON.stringify(line));
  await flush();
  return responses;
}

test('a request before initialize is refused, with the code and not a message to match on', async () => {
  const [response] = await raw([{ jsonrpc: '2.0', id: 7, method: 'session.list', params: {} }]);
  assert.equal(errorOf(response)?.code, ERROR_CODES.notInitialized);
  assert.equal(response?.id, 7, 'the refusal still answers the id it was asked for');
});

test('an unknown method is refused and lists what exists', async () => {
  const responses = await raw([HANDSHAKE, { jsonrpc: '2.0', id: 2, method: 'turn.pause', params: {} }]);
  const error = errorOf(responses[1]);
  assert.equal(error?.code, ERROR_CODES.methodNotFound);
  const known = (error.data as { known: readonly string[] }).known;
  assert.ok(known.includes('turn.send'), `expected the method list, got ${JSON.stringify(known)}`);
});

test('params that do not match this method is invalidParams, not a host call', async () => {
  const responses = await raw([HANDSHAKE, { jsonrpc: '2.0', id: 2, method: 'turn.send', params: { sessionId: 's1' } }]);
  assert.equal(errorOf(responses[1])?.code, ERROR_CODES.invalidParams);
});

test('a params field this version does not define is refused rather than ignored', async () => {
  const responses = await raw([
    HANDSHAKE,
    { jsonrpc: '2.0', id: 2, method: 'session.open', params: { sessionId: 's1', resume: true } },
  ]);
  assert.equal(errorOf(responses[1])?.code, ERROR_CODES.invalidParams);
});

test('a body that is not JSON is a parse error against a null id', async () => {
  const [response] = await raw(['{not json']);
  assert.equal(errorOf(response)?.code, ERROR_CODES.parseError);
  assert.equal(response?.id, null);
});

test('a body that is JSON but not an object is an invalid request', async () => {
  const [response] = await raw(['[]']);
  assert.equal(errorOf(response)?.code, ERROR_CODES.invalidRequest);
});

test('a version mismatch is refused, and the refusal arrives before the connection closes', async () => {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  const { client } = wire(host, { client: 2 });

  await assert.rejects(client.initialize(), (error: unknown) => {
    assert.ok(error instanceof ProtocolClientError);
    assert.equal(error.code, ERROR_CODES.versionMismatch);
    assert.deepEqual(error.data, { supported: 1 });
    return true;
  });
  // The server stopped: refusing means stopping (ADR-055), and the client sees the end
  // of the connection instead of a server that pretends the handshake succeeded.
  await client.closed;
});

test('initialize twice is refused', async () => {
  const responses = await raw([HANDSHAKE, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 1 } }]);
  assert.equal(errorOf(responses[1])?.code, ERROR_CODES.invalidRequest);
});

test('opening a session that does not exist is noSuchSession', async () => {
  const host = new ScriptedHost();
  const { client } = wire(host);
  await client.initialize();
  await assert.rejects(client.openSession('nope'), (error: unknown) => {
    assert.ok(error instanceof ProtocolClientError);
    assert.equal(error.code, ERROR_CODES.noSuchSession);
    return true;
  });
});

test('an attachment over the limit is refused with the numbers, never clipped', async () => {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  host.attachments.set('img-1', { id: 'img-1', mediaType: 'image/png', byteLength: 2048, data: 'AAAA' });
  host.attachments.set('img-2', { id: 'img-2', mediaType: 'image/png', byteLength: 10, data: 'AAAA' });
  const { client } = wire(host);
  await client.initialize();

  await assert.rejects(client.readAttachment('img-1'), (error: unknown) => {
    assert.ok(error instanceof ProtocolClientError);
    assert.equal(error.code, ERROR_CODES.attachmentTooLarge);
    assert.deepEqual(error.data, { id: 'img-1', byteLength: 2048, limit: 1024 });
    return true;
  });

  // The caller's cap is applied too, so a client can ask for less than the host allows.
  await assert.rejects(client.readAttachment('img-2', 5), (error: unknown) => {
    assert.ok(error instanceof ProtocolClientError);
    assert.equal(error.code, ERROR_CODES.attachmentTooLarge);
    return true;
  });

  assert.deepEqual(await client.readAttachment('img-2'), {
    id: 'img-2',
    mediaType: 'image/png',
    byteLength: 10,
    data: 'AAAA',
  });
});

test('a host failure becomes one line and an internalError code', async () => {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  host.sendTurnFailure = new Error('boom\n    at somewhere (kernel.ts:1:1)');
  const { client } = wire(host);
  await client.initialize();

  await assert.rejects(client.sendTurn('s1', 'hi'), (error: unknown) => {
    assert.ok(error instanceof ProtocolClientError);
    assert.equal(error.code, ERROR_CODES.internalError);
    // A renderer cannot show a stack trace, so the protocol does not carry one.
    assert.equal(error.message, 'boom');
    return true;
  });
});

test('a client notification is ignored, not answered', async () => {
  const host = new ScriptedHost([newScriptedSession('s1')]);
  const { clientTransport } = wire(host);
  const seen: string[] = [];
  clientTransport.onMessage((line) => seen.push(line));

  clientTransport.send(JSON.stringify({ jsonrpc: '2.0', method: 'session.list', params: {} }));
  await flush();
  assert.deepEqual(seen, [], 'no response is owed to a notification');
});
