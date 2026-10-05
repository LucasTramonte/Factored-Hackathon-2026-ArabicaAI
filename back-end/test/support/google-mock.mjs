/**
 * Google, mocked on loopback for the AI suggestion path in the local-D1 suites (no network, no credential). It runs as its
 * own process because run-local blocks while the suites run. STS verifies the Worker's JWT with the throwaway public key
 * and its claims, IAM Credentials checks the federated token, and Vertex checks the access token, then answers by a
 * marker in the customer's details: MOCK-TIMEOUT never answers, MOCK-PROVIDER is HTTP 500, MOCK-INVALID is invalid
 * output, FACTS={...} reads those stated facts, anything else states no usable fact. GET /__vertex lists the user turns
 * Vertex received, so tests can check what left the Worker. Listens on ``GOOGLE_MOCK_PORT``; prints ``PORT <n>`` once listening.
 */
import { createServer } from 'node:http';
import { importJWK, jwtVerify } from 'jose';
import { SUBJECT, audience } from '../../src/modules/intake/vertex-auth.js';

const vars = JSON.parse(process.env.GOOGLE_MOCK_VARS);
const publicKey = await importJWK(JSON.parse(process.env.GOOGLE_MOCK_PUBLIC_JWK), 'RS256');
const received = [];
const mock = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  try {
    if (request.method === 'GET' && request.url === '/__vertex') return send(200, received);
    if (request.url === '/v1/token') {
      const exchange = JSON.parse(text);
      const expected = audience(vars.VERTEX_PROJECT_NUMBER);
      await jwtVerify(exchange.subject_token, publicKey, { issuer: vars.VERTEX_WIF_ISSUER, subject: SUBJECT, audience: expected, maxTokenAge: 300 });
      if (exchange.audience !== expected || exchange.grant_type !== 'urn:ietf:params:oauth:grant-type:token-exchange') return send(400, { error: 'invalid_request' });
      return send(200, { access_token: 'mock-federated', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (request.url === `/v1/projects/-/serviceAccounts/${vars.VERTEX_SERVICE_ACCOUNT}:generateAccessToken`) {
      if (request.headers.authorization !== 'Bearer mock-federated') return send(403, { error: 'denied' });
      return send(200, { accessToken: 'mock-vertex', expireTime: new Date(Date.now() + 3600000).toISOString() });
    }
    // The location the Worker is configured with (wrangler.jsonc ``VERTEX_LOCATION``, ``us``), so the integration Worker's path is checked.
    if (request.url === `/v1/projects/${vars.VERTEX_PROJECT}/locations/${vars.VERTEX_LOCATION ?? 'global'}/endpoints/openapi/chat/completions`) {
      if (request.headers.authorization !== 'Bearer mock-vertex') return send(401, { error: 'unauthenticated' });
      const user = JSON.parse(JSON.parse(text).messages[1].content);
      received.push(user);
      if (received.length > 500) received.shift();
      if (JSON.parse(text).response_format?.json_schema?.name === 'support_reviewer') {
        const content = JSON.stringify({ summary: 'El cliente solicita una revisión.', missing_fields: ['merchant'], draft: '¿Puedes indicar el comercio?' });
        const answer = () => send(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 120, completion_tokens: 30 } });
        if (user.statement.includes('MOCK-DELAY')) return setTimeout(answer, 500);
        if (user.statement.includes('MOCK-PROVIDER')) return send(500, '');
        if (user.statement.includes('MOCK-INVALID')) return send(200, { choices: [{ finish_reason: 'stop', message: { content: 'bad' } }] });
        return answer();
      }
      if (JSON.parse(text).response_format?.json_schema?.name === 'support_customer') {
        const question = String(user.question);
        const content = JSON.stringify({ intent: question.includes('DETAILS') ? 'provide_details' : question.includes('HUMAN') ? 'human' : /refund|fraud|block|ignore/i.test(question) ? 'unsupported' : question.includes('NEXT') ? 'next_step' : 'status', field: question.includes('DETAILS') ? 'merchant' : null });
        const answer = () => send(200, { choices: [{ finish_reason:'stop', message:{role:'assistant',content} }],usage:{prompt_tokens:60,completion_tokens:10} });
        if (question.includes('MOCK-DELAY')) return setTimeout(answer,500);
        if (question.includes('MOCK-PROVIDER')) return send(500,'');
        if (question.includes('MOCK-INVALID')) return send(200,{choices:[{finish_reason:'stop',message:{content:'{"intent":"status","field":"amount"}'}}]});
        return answer();
      }
      const message = String(user.message);
      if (message.includes('MOCK-TIMEOUT')) return undefined; // never answers; the Worker's deadline abandons it
      if (message.includes('MOCK-PROVIDER')) return send(500, '');
      if (message.includes('MOCK-INVALID')) return send(200, { choices: [{ message: { content: 'not json' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
      const facts = /FACTS=(\{.*\})/.exec(message)?.[1];
      const extracted = { intent: 'report', stated_facts: facts ? JSON.parse(facts) : {}, invalid: null, demand: null, injection: false };
      return send(200, { choices: [{ message: { role: 'assistant', content: JSON.stringify(extracted) } }], usage: { prompt_tokens: 1840, completion_tokens: 84 } });
    }
    return send(404, { error: 'not found' });
  } catch {
    return send(403, { error: 'rejected' });
  }
});
mock.listen(Number(process.env.GOOGLE_MOCK_PORT), '127.0.0.1', () => console.log('PORT ' + mock.address().port));
process.on('SIGTERM', () => { mock.closeAllConnections(); mock.close(() => process.exit(0)); });
