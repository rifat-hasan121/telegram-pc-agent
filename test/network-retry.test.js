const test = require('node:test');
const assert = require('node:assert/strict');
const { isTransientNetworkError, retryTransient } = require('../network-retry');

test('network retry detects OpenAI and Telegram connection failures', () => {
  assert.equal(isTransientNetworkError(new Error('Connection error.')), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error('EFATAL: AggregateError'), { code: 'EFATAL' })), true);
  assert.equal(isTransientNetworkError(new Error('Invalid API key')), false);
});

test('retryTransient retries transient failures and returns the successful result', async () => {
  let attempts = 0;
  const waits = [];

  const result = await retryTransient(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error('Connection error.');
    }
    return 'success';
  }, {
    attempts: 3,
    delayMs: 20,
    wait: async (delay) => waits.push(delay)
  });

  assert.equal(result, 'success');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [20, 40]);
});

test('retryTransient does not retry application errors or exceed the attempt cap', async () => {
  let validationCalls = 0;
  await assert.rejects(retryTransient(async () => {
    validationCalls += 1;
    throw new Error('Invalid API key');
  }, { wait: async () => assert.fail('Must not wait') }), /Invalid API key/);
  assert.equal(validationCalls, 1);

  let networkCalls = 0;
  await assert.rejects(retryTransient(async () => {
    networkCalls += 1;
    throw new Error('Connection error.');
  }, { attempts: 2, wait: async () => {} }), /Connection error/);
  assert.equal(networkCalls, 2);
});
