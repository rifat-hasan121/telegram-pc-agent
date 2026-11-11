const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBrowserAgent,
  ensureSafeNavigation,
  parseAgentAction,
  parseAllowedDomains,
  performAction,
  validateBrowseUrl
} = require('../browser-agent');

test('browser allowlist accepts explicit domains and rejects wildcards', () => {
  assert.deepEqual(parseAllowedDomains('example.com, youtube.com'), ['example.com', 'youtube.com']);
  assert.throws(() => parseAllowedDomains('*'), /exact hostnames/);
  assert.throws(() => parseAllowedDomains('https://example.com'), /exact hostnames/);
});

test('browse URLs allow only the configured site and safe web schemes', () => {
  const allowed = parseAllowedDomains(['example.com']);
  assert.equal(validateBrowseUrl('example.com/video', allowed), 'https://example.com/video');
  assert.equal(validateBrowseUrl('https://www.example.com', allowed), 'https://www.example.com/');
  assert.throws(() => validateBrowseUrl('https://other.example/video', allowed), /allowlist/);
  assert.throws(() => validateBrowseUrl('http://127.0.0.1', allowed), /allowlist/);
  assert.throws(() => validateBrowseUrl('file:///etc/passwd', allowed), /allowlist/);
});

test('browser actions must be valid JSON and use the supported shapes', () => {
  assert.deepEqual(parseAgentAction('{"action":"scroll"}'), { action: 'scroll' });
  assert.deepEqual(parseAgentAction('{"action":"click","index":5}'), { action: 'click', index: 5 });
  assert.deepEqual(parseAgentAction('{"action":"type","index":2,"text":"cats","pressEnter":true}'), {
    action: 'type',
    index: 2,
    text: 'cats',
    pressEnter: true
  });
  assert.throws(() => parseAgentAction('{"action":"click","index":-1}'), /unsupported action/);
  assert.throws(() => parseAgentAction('{"action":"delete"}'), /unsupported action/);
});

test('browser blocks navigation outside the allowlist', async () => {
  const outcomes = [];
  const route = {
    request: () => ({
      isNavigationRequest: () => true,
      url: () => 'https://outside.example/path'
    }),
    continue: async () => outcomes.push('continue'),
    abort: async () => outcomes.push('abort')
  };

  await ensureSafeNavigation(route, ['example.com']);
  assert.deepEqual(outcomes, ['abort']);
});

test('browser does not click arbitrary page buttons', async () => {
  let clicked = false;
  const page = {
    locator: () => ({
      evaluate: async (callback) => callback({
        isConnected: true,
        getAttribute: () => '0',
        tagName: 'BUTTON',
        innerText: 'Delete account',
        getAttribute: () => '0',
        hasAttribute: () => false
      }),
      click: async () => { clicked = true; }
    })
  };

  await assert.rejects(
    performAction(page, { action: 'click', index: 0 }, ['example.com']),
    /only website links and clearly labeled video playback/
  );
  assert.equal(clicked, false);
});

test('browser agent launches visibly, uses an eight-step JSON request, and keeps the browser open', async () => {
  const launchOptions = [];
  const navigations = [];
  const requests = [];
  const page = {
    route: async () => {},
    goto: async (...args) => navigations.push(args),
    waitForTimeout: async () => {},
    evaluate: async () => ({
      title: 'Example',
      url: 'https://example.com/',
      visibleText: 'A public example page',
      elements: [{ index: 0, tag: 'a', text: 'Video' }]
    }),
    title: async () => 'Example'
  };
  let browserClosed = false;
  const browser = {
    isConnected: () => true,
    newPage: async () => page,
    close: async () => { browserClosed = true; }
  };
  const browserType = {
    launch: async (options) => {
      launchOptions.push(options);
      return browser;
    }
  };
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          requests.push(request);
          return {
            choices: [{ message: { content: '{"action":"done","message":"Found the requested video."}' } }]
          };
        }
      }
    }
  };

  const browse = createBrowserAgent({
    openai,
    allowedDomains: ['example.com'],
    browserType,
    wait: async () => {}
  });
  const result = await browse('https://example.com', 'Find the most viewed video');

  assert.equal(result, 'Found the requested video.');
  assert.deepEqual(launchOptions, [{ headless: false }]);
  assert.equal(navigations[0][0], 'https://example.com/');
  assert.equal(requests[0].max_tokens, 1000);
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.equal(requests[0].messages[1].content.includes('Find the most viewed video'), true);
  assert.equal(requests[0].messages[1].content.includes('A public example page'), true);
  assert.equal(browserClosed, false);
});
