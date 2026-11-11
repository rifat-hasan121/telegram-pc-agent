const test = require('node:test');
const assert = require('node:assert/strict');
const { createYoutubeController } = require('../youtube-control');

function fakeBrowser(pageList) {
  const calls = [];
  const page = (url) => ({
    url: () => url,
    keyboard: {
      press: async (key) => calls.push(['press', key]),
      type: async (text) => calls.push(['type', text])
    },
    locator: (selector) => locator(selector, calls),
    waitForFunction: async (...args) => calls.push(['waitForFunction', ...args]),
    calls
  });
  const pages = pageList.map(page);
  const browser = {
    contexts: () => [{ pages: () => pages }],
    close: async () => calls.push(['disconnect'])
  };
  return { browser, calls, pages };
}

function locator(selector, calls, behavior = {}) {
  return {
    first() { return this; },
    isVisible: async () => behavior.visible ?? true,
    count: async () => behavior.count ?? 1,
    click: async () => calls.push(['click', selector]),
    innerText: async () => behavior.text || '',
    scrollIntoViewIfNeeded: async () => calls.push(['scroll', selector]),
    waitFor: async (options) => calls.push(['waitFor', selector, options]),
    fill: async (value) => calls.push(['fill', selector, value])
  };
}

test('youtube_action returns a Bengali error when no watch tab is open', async () => {
  const { browser, calls } = fakeBrowser(['https://www.youtube.com/']);
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  const result = await controller.youtubeAction('play_pause');

  assert.match(result, /YouTube watch tab পাওয়া যায়নি/);
  assert.deepEqual(calls, [['disconnect']]);
});

test('youtube_action uses the required keyboard shortcuts on the open watch tab', async () => {
  const expected = [
    ['play_pause', 'k'],
    ['next', 'Shift+N'],
    ['mute', 'm']
  ];
  for (const [action, key] of expected) {
    const { browser, calls } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
    const controller = createYoutubeController({
      browserType: { connectOverCDP: async () => browser }
    });

    await controller.youtubeAction(action);

    assert.deepEqual(calls, [['press', key], ['disconnect']]);
  }
});

test('youtube_action clicks fullscreen and visible skip-ad controls', async () => {
  const { browser, calls } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const originalPage = browser.contexts()[0].pages()[0];
  originalPage.locator = (selector) => locator(selector, calls);
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  await controller.youtubeAction('fullscreen');
  await controller.youtubeAction('skip_ad');

  assert.deepEqual(calls, [
    ['click', '.ytp-fullscreen-button'],
    ['disconnect'],
    ['click', '.ytp-skip-ad-button, .ytp-ad-skip-button'],
    ['disconnect']
  ]);
});

test('youtube_action reports when there is no visible skip-ad button', async () => {
  const { browser } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.locator = (selector) => locator(selector, [], { visible: false });
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  assert.match(await controller.youtubeAction('skip_ad'), /দৃশ্যমান কোনো skip ad button নেই/);
});

test('youtube_action explains login is required only when the profile avatar is missing', async () => {
  const { browser } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.locator = (selector) => locator(selector, [], { visible: selector !== '#avatar-btn' });
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  assert.match(await controller.youtubeAction('like'), /YouTube-এ Like বা comment করার জন্য/);
});

test('youtube_action uses structural Like selectors regardless of interface language', async () => {
  const { browser, calls } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.locator = (selector) => locator(selector, calls, {
    visible: selector !== 'ytd-modal-with-title-and-button-renderer, tp-yt-paper-dialog'
  });
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  const result = await controller.youtubeAction('like');

  assert.equal(result, 'YouTube ভিডিওতে Like দেওয়া হয়েছে।');
  assert.deepEqual(calls, [
    ['click', '#above-the-fold like-button-view-model button, ytd-watch-metadata like-button-view-model button'],
    ['disconnect']
  ]);
});

test('youtube_action treats a visible sign-in popup after Like as login-required', async () => {
  const { browser } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.locator = (selector) => locator(selector, [], {
    visible: selector === '#avatar-btn'
      || selector.startsWith('#above-the-fold')
      || selector === 'ytd-modal-with-title-and-button-renderer, tp-yt-paper-dialog'
  });
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  assert.match(await controller.youtubeAction('like'), /YouTube-এ Like বা comment করার জন্য/);
});

test('youtube_action logs and rethrows actual Like click failures', async () => {
  const { browser } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.locator = (selector) => {
    const item = locator(selector, []);
    if (selector.startsWith('#above-the-fold')) {
      item.click = async () => { throw new Error('locator detached'); };
    }
    return item;
  };
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args);
  try {
    await assert.rejects(controller.youtubeAction('like'), /locator detached/);
    assert.deepEqual(logs, [['YouTube Like click failed:', 'locator detached']]);
  } finally {
    console.error = originalError;
  }
});

test('youtube_action posts only the supplied comment on the watch tab', async () => {
  const { browser, calls } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.locator = (selector) => locator(selector, calls);
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  const result = await controller.youtubeAction('comment', '  Great video!  ');

  assert.equal(result, 'YouTube-এ comment পোস্ট করা হয়েছে।');
  assert.deepEqual(calls.slice(0, 7), [
    ['scroll', '#comments'],
    ['waitFor', '#simplebox-placeholder', { state: 'visible', timeout: 10000 }],
    ['click', '#simplebox-placeholder'],
    ['waitFor', '#contenteditable-root', { state: 'visible', timeout: 10000 }],
    ['click', '#contenteditable-root'],
    ['type', 'Great video!'],
    ['waitFor', '#submit-button, #submit-button button', { state: 'visible', timeout: 10000 }]
  ]);
  assert.equal(calls[7][0], 'waitForFunction');
  assert.equal(typeof calls[7][1], 'function');
  assert.equal(calls[7][2], null);
  assert.deepEqual(calls[7][3], { timeout: 10000 });
  assert.deepEqual(calls.slice(8), [
    ['click', '#submit-button, #submit-button button'],
    ['disconnect']
  ]);
});

test('youtube_action comments only reports login when the profile avatar is missing', async () => {
  const { browser } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.locator = (selector) => locator(selector, [], {
    count: selector === '#avatar-btn' ? 0 : 1
  });
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  assert.match(await controller.youtubeAction('comment', 'Hello'), /YouTube-এ Like বা comment করার জন্য/);
});

test('youtube_action propagates comment box loading errors instead of reporting login', async () => {
  const { browser } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.locator = (selector) => {
    const item = locator(selector, []);
    if (selector === '#simplebox-placeholder') {
      item.waitFor = async () => { throw new Error('comment placeholder timed out'); };
    }
    return item;
  };
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  await assert.rejects(controller.youtubeAction('comment', 'Hello'), /comment placeholder timed out/);
});

test('youtube_action rejects invalid actions and comments', async () => {
  const controller = createYoutubeController();
  await assert.rejects(controller.youtubeAction('delete'), /Unsupported YouTube action/);
  await assert.rejects(controller.youtubeAction('comment', ' '), /comment must contain/);
  await assert.rejects(controller.youtubeAction('comment', 'x'.repeat(1001)), /comment must contain/);
});
