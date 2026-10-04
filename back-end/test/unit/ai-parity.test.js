/**
 * Parity of the Worker's extractor port and suggestion rule with the evaluated Python. Every record in
 * ``test/fixtures/ai-parity.json`` was produced by running the Python (``python -m evals.intake.online_parity``) on the
 * development split and authored synthetic inputs; ``evals/intake/test_online_parity.py`` fails when it is stale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VOCABULARY, buildBody, extract, parse, pyJson } from '../../src/modules/intake/ai-transport.js';
import { evaluate, norm } from '../../src/modules/intake/matcher.js';

const FIXTURES = JSON.parse(readFileSync(new URL('../fixtures/ai-parity.json', import.meta.url), 'utf8'));

test('the vocabulary is the evaluation vocabulary, in the same key order', () => {
  assert.equal(JSON.stringify(VOCABULARY), JSON.stringify(FIXTURES.vocabulary));
});

test('request bodies are byte-identical to vertex.build_body serialised by json.dumps(ensure_ascii=False)', () => {
  assert.ok(FIXTURES.bodies.length >= 10);
  for (const { message, language, as_of, body } of FIXTURES.bodies) {
    assert.equal(pyJson(buildBody(message, language, as_of)), body, message.slice(0, 40));
    assert.deepEqual(new TextEncoder().encode(pyJson(buildBody(message, language, as_of))), new TextEncoder().encode(body));
  }
});

test('parse accepts, normalises and refuses exactly what workers_ai.parse does', () => {
  for (const record of FIXTURES.parse) {
    if ('ok' in record) assert.equal(JSON.stringify(parse(record.content)), JSON.stringify(record.ok), record.content.slice(0, 60));
    else assert.throws(() => parse(record.content), undefined, record.content.slice(0, 60));
  }
});

test('the attempt loop matches vertex.extract on every authored HTTP exchange: kind, facts, calls and usage', async () => {
  for (const scenario of FIXTURES.scenarios) {
    const queue = [...scenario.responses];
    let requests = 0;
    const fetcher = async (url, init) => {
      requests += 1;
      assert.equal(init.redirect, 'manual');
      const { status, body } = queue.shift();
      return new Response(status === 204 ? null : body, { status, headers: { 'Content-Type': 'application/json' } });
    };
    const result = await extract({ url: 'https://vertex.test/x', message: 'No reconozco un cargo de 85.00 USD del 2026-06-10', language: 'es', token: 't', fetcher });
    assert.equal(result.kind, scenario.kind, scenario.name);
    assert.equal(requests, scenario.requests, scenario.name);
    assert.equal(result.usage.llm_calls, scenario.requests, scenario.name);
    assert.deepEqual([result.usage.known_input_tokens, result.usage.known_output_tokens, result.usage.usage_unavailable_calls],
      [scenario.usage.input_tokens, scenario.usage.output_tokens, scenario.usage.usage_unavailable_calls], scenario.name);
    assert.equal(JSON.stringify(result.extracted ?? null), JSON.stringify(scenario.extracted), scenario.name);
  }
});

test('the suggestion rule returns the candidates label_rules.evaluate returns, or refuses the same inputs', () => {
  let compared = 0;
  for (const { fixture, spec, result, error } of FIXTURES.policy) {
    const { records, customers } = FIXTURES[fixture];
    const customer = customers.find(c => c.customer_id === spec.customer_id);
    const own = records.filter(t => t.customer_id === spec.customer_id);
    const label = JSON.stringify(spec).slice(0, 160);
    if (error) { assert.throws(() => evaluate(spec, customer, own), undefined, label); continue; }
    assert.deepEqual(evaluate(spec, customer, own), { action: result.action, candidate_ids: result.candidate_ids }, label);
    compared += 1;
  }
  assert.ok(compared > 700, 'every development and synthetic case was compared');
});

test('names normalise as label_rules._norm does', () => {
  for (const { value, norm: expected } of FIXTURES.norm) assert.equal(norm(value), expected, JSON.stringify(value));
});
