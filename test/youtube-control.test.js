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
    click: async (selector) => calls.push(['pageClick', selector]),
    hover: async (selector) => calls.push(['hover', selector]),
    evaluate: async (callback) => {
      calls.push(['evaluate', callback]);
      return false;
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
    getAttribute: async (name) => {
      calls.push(['getAttribute', selector, name]);
      return behavior.ariaPressed ?? 'false';
    },
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

test('youtube_action hovers over the player before turning fullscreen on', async () => {
  const { browser, calls } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const originalPage = browser.contexts()[0].pages()[0];
  originalPage.locator = (selector) => locator(selector, calls);
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  await controller.youtubeAction('fullscreen_on');

  assert.equal(calls[0][0], 'evaluate');
  assert.equal(typeof calls[0][1], 'function');
  assert.deepEqual(calls.slice(1), [
    ['hover', '#movie_player'],
    ['pageClick', '.ytp-fullscreen-button'],
    ['disconnect']
  ]);
});

test('youtube_action fullscreen alias turns fullscreen on only when needed', async () => {
  const { browser, calls } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.evaluate = async (callback) => {
    calls.push(['evaluate', callback]);
    return true;
  };
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  await controller.youtubeAction('fullscreen');

  assert.equal(calls[0][0], 'evaluate');
  assert.equal(typeof calls[0][1], 'function');
  assert.deepEqual(calls.slice(1), [['disconnect']]);
});

test('youtube_action exits active fullscreen with document.exitFullscreen', async () => {
  const { browser, calls } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  let stateChecks = 0;
  page.evaluate = async (callback) => {
    calls.push(['evaluate', callback]);
    stateChecks += 1;
    return stateChecks === 1;
  };
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  await controller.youtubeAction('fullscreen_off');

  assert.equal(calls[0][0], 'evaluate');
  assert.equal(typeof calls[0][1], 'function');
  assert.equal(calls[1][0], 'evaluate');
  assert.equal(typeof calls[1][1], 'function');
  assert.equal(calls[2][0], 'evaluate');
  assert.equal(typeof calls[2][1], 'function');
  assert.deepEqual(calls.slice(3), [['disconnect']]);
});

test('youtube_action falls back to Escape and the fullscreen button when exitFullscreen fails', async () => {
  const { browser, calls } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.evaluate = async (callback) => {
    calls.push(['evaluate', callback]);
    if (calls.filter(([kind]) => kind === 'evaluate').length === 1) return true;
    if (calls.filter(([kind]) => kind === 'evaluate').length === 2) {
      throw new Error('exitFullscreen rejected');
    }
    return true;
  };
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await controller.youtubeAction('fullscreen_off');
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(calls.slice(-4), [
    ['press', 'Escape'],
    ['hover', '#movie_player'],
    ['pageClick', '.ytp-fullscreen-button'],
    ['disconnect']
  ]);
});

test('youtube_action fullscreen off is a no-op when fullscreen is already inactive', async () => {
  const { browser, calls } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  await controller.youtubeAction('fullscreen_off');

  assert.equal(calls[0][0], 'evaluate');
  assert.deepEqual(calls.slice(1), [['disconnect']]);
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
    ['getAttribute', '#above-the-fold like-button-view-model button, ytd-watch-metadata like-button-view-model button', 'aria-pressed'],
    ['click', '#above-the-fold like-button-view-model button, ytd-watch-metadata like-button-view-model button'],
    ['disconnect']
  ]);
});

test('youtube_action does not click Like when the video is already liked', async () => {
  const { browser, calls } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.locator = (selector) => locator(selector, calls, {
    ariaPressed: selector.startsWith('#above-the-fold') ? 'true' : 'false'
  });
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  const result = await controller.youtubeAction('like');

  assert.equal(result, 'ভিডিওটিতে আগে থেকেই Like দেওয়া আছে।');
  assert.equal(calls.some(([type]) => type === 'click'), false);
  assert.deepEqual(calls.at(-1), ['disconnect']);
});

test('youtube_action unlikes a video only when its Like button is pressed', async () => {
  const { browser, calls } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.locator = (selector) => locator(selector, calls, {
    visible: selector !== 'ytd-modal-with-title-and-button-renderer, tp-yt-paper-dialog',
    ariaPressed: selector.startsWith('#above-the-fold') ? 'true' : 'false'
  });
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  const result = await controller.youtubeAction('unlike');

  assert.equal(result, 'YouTube ভিডিও থেকে Like সরানো হয়েছে।');
  assert.deepEqual(calls, [
    ['getAttribute', '#above-the-fold like-button-view-model button, ytd-watch-metadata like-button-view-model button', 'aria-pressed'],
    ['click', '#above-the-fold like-button-view-model button, ytd-watch-metadata like-button-view-model button'],
    ['disconnect']
  ]);
});

test('youtube_action does not click Unlike when the video is not liked', async () => {
  const { browser, calls } = fakeBrowser(['https://www.youtube.com/watch?v=video']);
  const page = browser.contexts()[0].pages()[0];
  page.locator = (selector) => locator(selector, calls, {
    ariaPressed: selector.startsWith('#above-the-fold') ? 'false' : 'false'
  });
  const controller = createYoutubeController({
    browserType: { connectOverCDP: async () => browser }
  });

  const result = await controller.youtubeAction('unlike');

  assert.equal(result, 'ভিডিওটিতে এখনো Like দেওয়া হয়নি।');
  assert.equal(calls.some(([type]) => type === 'click'), false);
  assert.deepEqual(calls.at(-1), ['disconnect']);
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
