import assert from 'node:assert/strict';
import test from 'node:test';

const {
  DEFAULT_GEMINI_EFFORTS,
  SKIP_THOUGHT_SIGNATURE,
  normalizeEffort,
  rememberThoughtSignature,
  thoughtSignatureFor,
  clearThoughtSignatures,
  textOf,
  toChatTools,
  toChatRequest,
  mapUsage,
  usageTotals,
  fromChatResponse,
  createStreamTranslator,
} = await import('./gemini.mjs');

const sse = value => `data: ${JSON.stringify(value)}\n\n`;

const chunk = delta => ({ id: 'c1', model: 'gemini-3.5-flash', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] });

test('normalizeEffort clamps to the levels a model advertises', () => {
  assert.equal(normalizeEffort('medium'), 'medium');
  assert.equal(normalizeEffort('MEDIUM'), 'medium');
  assert.equal(normalizeEffort('minimal', ['low', 'medium', 'high']), 'low');
  assert.equal(normalizeEffort('none', ['minimal', 'high']), 'minimal');
  assert.equal(normalizeEffort('xhigh', ['low', 'medium', 'high']), 'high');
  assert.equal(normalizeEffort('ultra'), 'high');
  assert.equal(normalizeEffort(undefined), 'medium');
  assert.equal(normalizeEffort('bogus', ['minimal', 'high']), 'minimal');
  assert.deepEqual(DEFAULT_GEMINI_EFFORTS, ['low', 'medium', 'high']);
});

test('textOf flattens every shape a tool output arrives in', () => {
  assert.equal(textOf('done'), 'done');
  assert.equal(textOf([{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }]), 'a\nb');
  assert.equal(textOf({ content: [{ type: 'input_text', text: 'c' }] }), 'c');
  assert.equal(textOf(null), '');
  assert.equal(textOf({ ok: true }), '{"ok":true}');
});

test('toChatTools turns custom tools into one-string functions', () => {
  const { tools, customTools } = toChatTools([
    { type: 'function', name: 'shell', description: 'run', parameters: { type: 'object', properties: { command: { type: 'array' } } } },
    { type: 'custom', name: 'apply_patch', description: 'patch', format: { type: 'grammar' } },
    { type: 'web_search' },
    null,
  ]);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].function.name, 'shell');
  assert.deepEqual(tools[0].function.parameters.properties.command, { type: 'array' });
  assert.equal(tools[1].function.name, 'apply_patch');
  assert.deepEqual(tools[1].function.parameters.required, ['input']);
  assert.ok(customTools.has('apply_patch'));
  assert.ok(!customTools.has('shell'));
});

test('toChatRequest translates a Responses turn into a chat turn', () => {
  clearThoughtSignatures();
  const { payload, customTools, effort } = toChatRequest({
    model: 'gemini-3.5-flash',
    instructions: 'be terse',
    stream: true,
    max_output_tokens: 512,
    temperature: 0.2,
    tool_choice: { type: 'custom', name: 'apply_patch' },
    tools: [{ type: 'custom', name: 'apply_patch' }],
    reasoning: { effort: 'xhigh' },
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
      { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_1' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ],
  }, 'gemini-3.5-flash', { supportedEfforts: ['low', 'medium', 'high'] });

  assert.equal(payload.model, 'gemini-3.5-flash');
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.equal(payload.max_tokens, undefined, 'a Responses token ceiling must not truncate thinking');
  assert.equal(payload.temperature, 0.2);
  assert.equal(payload.reasoning_effort, 'high');
  assert.equal(effort, 'high');
  assert.deepEqual(payload.tool_choice, { type: 'function', function: { name: 'apply_patch' } });
  assert.equal(payload.tools.length, 1);
  assert.ok(customTools.has('apply_patch'));

  assert.deepEqual(payload.messages[0], { role: 'system', content: 'be terse' });
  assert.deepEqual(payload.messages[1], { role: 'user', content: 'hi' });
  const assistant = payload.messages[2];
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  assert.equal(assistant.tool_calls[0].function.name, 'shell');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"command":["ls"]}');
  assert.deepEqual(assistant.tool_calls[0].extra_content.google, { thought_signature: SKIP_THOUGHT_SIGNATURE });
  assert.deepEqual(payload.messages[3], { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' });
  assert.deepEqual(payload.messages[4], { role: 'assistant', content: 'done' });
});

test('a replayed call carries the signature the upstream handed back', () => {
  clearThoughtSignatures();
  assert.equal(thoughtSignatureFor('call_9'), SKIP_THOUGHT_SIGNATURE);
  rememberThoughtSignature('call_9', 'sig-abc');
  assert.equal(thoughtSignatureFor('call_9'), 'sig-abc');
  rememberThoughtSignature('call_9', undefined);
  rememberThoughtSignature(undefined, 'sig-xyz');
  assert.equal(thoughtSignatureFor('call_9'), 'sig-abc', 'a blank value must not evict the stored one');

  const { payload } = toChatRequest({
    input: [
      { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch', call_id: 'call_9' },
      { type: 'custom_tool_call_output', call_id: 'call_9', output: 'ok' },
    ],
  }, 'gemini-3.5-flash');
  assert.equal(payload.messages[0].tool_calls[0].extra_content.google.thought_signature, 'sig-abc');
  assert.equal(payload.messages[0].tool_calls[0].function.arguments, JSON.stringify({ input: '*** Begin Patch' }));
});

test('an empty effort list sends no thinking field at all', () => {
  const { payload, effort } = toChatRequest({ input: 'hi', reasoning: { effort: 'high' } }, 'gemma-4-31b-it', { supportedEfforts: [] });
  assert.equal(effort, null);
  assert.equal('reasoning_effort' in payload, false);
  assert.equal(payload.stream, true, 'a missing stream flag still streams, like the Responses API');
});

test('fromChatResponse rebuilds the Responses item list', () => {
  clearThoughtSignatures();
  const response = fromChatResponse({
    model: 'gemini-3.5-flash',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: 'working',
        reasoning_content: 'plan first',
        tool_calls: [
          { id: 'call_7', type: 'function', extra_content: { google: { thought_signature: 'sig-7' } }, function: { name: 'apply_patch', arguments: JSON.stringify({ input: 'patch' }) } },
          { id: 'call_8', type: 'function', function: { name: 'shell', arguments: '{"command":["ls"]}' } },
        ],
      },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } },
  }, { model: 'gemini-3.5-flash', customTools: new Set(['apply_patch']), id: 'resp_1' });

  assert.equal(response.object, 'response');
  assert.equal(response.id, 'resp_1');
  assert.equal(response.status, 'completed');
  assert.deepEqual(response.output.map(item => item.type), ['reasoning', 'message', 'custom_tool_call', 'function_call']);
  assert.equal(response.output[1].content[0].text, 'working');
  assert.equal(response.output[2].input, 'patch');
  assert.equal(response.output[2].call_id, 'call_7');
  assert.equal(response.output[3].arguments, '{"command":["ls"]}');
  assert.deepEqual(usageTotals(response.usage), { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedTokens: 40, reasoningTokens: 5 });
  assert.equal(thoughtSignatureFor('call_7'), 'sig-7');
  assert.equal(thoughtSignatureFor('call_8'), SKIP_THOUGHT_SIGNATURE);
});

test('fromChatResponse reports truncation and never returns an empty output', () => {
  const response = fromChatResponse({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }] }, { model: 'm' });
  assert.equal(response.status, 'incomplete');
  assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, 'message');
});

test('mapUsage accepts both token naming schemes', () => {
  assert.deepEqual(mapUsage({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }).output_tokens, 4);
  assert.deepEqual(mapUsage({ input_tokens: 3, output_tokens: 4, input_tokens_details: { cached_tokens: 1 } }).input_tokens_details, { cached_tokens: 1 });
  assert.equal(mapUsage(null).total_tokens, 0);
});

test('the stream translator closes a text turn with usage', () => {
  const events = [];
  const translator = createStreamTranslator({
    model: 'gemini-3.5-flash',
    responseId: 'resp_s1',
    customTools: new Set(),
    emit: (type, payload) => events.push({ type, payload }),
    onUsage: usage => events.push({ type: 'usage', payload: usage }),
  });
  translator.created();
  translator.push(sse(chunk({ role: 'assistant', content: 'hel' })));
  translator.push(sse(chunk({ content: 'lo' })));
  translator.push(sse({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  translator.push(sse({ id: 'c1', choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }));
  translator.push('data: [DONE]\n\n');
  translator.close();

  const types = events.map(event => event.type);
  assert.equal(types[0], 'response.created');
  assert.ok(types.includes('response.output_text.delta'));
  assert.equal(types.at(-2), 'response.completed');
  assert.equal(types.at(-1), 'usage');

  const deltas = events.filter(event => event.type === 'response.output_text.delta').map(event => event.payload.delta);
  assert.deepEqual(deltas, ['hel', 'lo']);
  const completed = events.find(event => event.type === 'response.completed').payload.response;
  assert.equal(completed.id, 'resp_s1');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.output.length, 1);
  assert.equal(completed.output[0].content[0].text, 'hello');
  assert.equal(completed.usage.input_tokens, 9);
  assert.equal(translator.isFinished(), true);
});

test('the stream translator captures a signature sent on its own delta', () => {
  clearThoughtSignatures();
  const events = [];
  const translator = createStreamTranslator({
    model: 'gemini-3.5-flash',
    responseId: 'resp_s2',
    customTools: new Set(['apply_patch']),
    emit: (type, payload) => events.push({ type, payload }),
  });
  translator.created();
  translator.push(sse(chunk({ extra_content: { google: { thought_signature: 'sig-stream' } } })));
  translator.push(sse(chunk({ tool_calls: [{ index: 0, id: 'call_5', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"p"}' } }] })));
  translator.push(sse({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  translator.close();

  const done = events.filter(event => event.type === 'response.output_item.done').map(event => event.payload.item);
  assert.equal(done.length, 1);
  assert.equal(done[0].type, 'custom_tool_call');
  assert.equal(done[0].call_id, 'call_5');
  assert.equal(done[0].input, 'p');
  assert.equal(thoughtSignatureFor('call_5'), 'sig-stream');
  const completed = events.find(event => event.type === 'response.completed').payload.response;
  assert.equal(completed.output[0].type, 'custom_tool_call');
});

test('the stream translator surfaces an upstream error chunk as a failed response', () => {
  const events = [];
  const translator = createStreamTranslator({
    model: 'gemini-3.5-flash',
    responseId: 'resp_s3',
    customTools: new Set(),
    emit: (type, payload) => events.push({ type, payload }),
  });
  translator.created();
  translator.push(`data: ${JSON.stringify({ error: { message: 'quota exceeded' } })}\n\n`);
  assert.equal(translator.isFinished(), true);
  const failed = events.find(event => event.type === 'response.failed');
  assert.equal(failed.payload.response.error.message, 'quota exceeded');
  assert.equal(failed.payload.response.status, 'failed');
});

test('the stream translator ignores an unfinished tail without losing the text', () => {
  const events = [];
  const translator = createStreamTranslator({
    model: 'gemini-3.5-flash',
    responseId: 'resp_s4',
    customTools: new Set(),
    emit: (type, payload) => events.push({ type, payload }),
  });
  translator.created();
  translator.push(sse(chunk({ content: 'partial' })));
  translator.push('data: {"choices":[{"delta":{"content":" tail"');
  translator.close();
  const completed = events.find(event => event.type === 'response.completed').payload.response;
  assert.equal(completed.output[0].content[0].text, 'partial');
  assert.equal(translator.isFinished(), true);
});
