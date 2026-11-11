const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  CDP_BASE_URL,
  createChromeController,
  launchChrome
} = require('../chrome-cdp');

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    body: { cancel: async () => {} }
  };
}

test('closeTab closes every page tab matching title or URL case-insensitively', async () => {
  const calls = [];
  const tabs = [
    { type: 'page', id: 'tab-1', title: 'YouTube - Home', url: 'https://youtube.com' },
    { type: 'page', id: 'tab/2', title: 'Videos', url: 'https://m.youtube.com/watch' },
    { type: 'page', id: 'tab-3', title: 'Facebook', url: 'https://facebook.com' },
    { type: 'service_worker', id: 'worker', title: 'youtube', url: 'https://youtube.com' }
  ];
  const controller = createChromeController({
    fetchImpl: async (url, options = {}) => {
      calls.push([url, options.method || 'GET']);
      if (url === `${CDP_BASE_URL}/json`) {
        return jsonResponse(tabs);
      }
      return jsonResponse({}, 200);
    }
  });

  const reply = await controller.closeTab('YoUtUbE');

  assert.deepEqual(calls, [
    [`${CDP_BASE_URL}/json`, 'GET'],
    [`${CDP_BASE_URL}/json/close/tab-1`, 'GET'],
    [`${CDP_BASE_URL}/json/close/tab%2F2`, 'GET']
  ]);
  assert.equal(reply, '“YoUtUbE” মেলে এমন 2টি Chrome ট্যাব বন্ধ করা হয়েছে।');
});

test('closeTab reports when Chrome remote debugging is unavailable', async () => {
  const controller = createChromeController({
    fetchImpl: async () => { throw new TypeError('fetch failed'); }
  });

  const reply = await controller.closeTab('facebook');

  assert.match(reply, /Chrome-এ remote debugging চালু নেই/);
  assert.match(reply, /--remote-debugging-port=9222/);
});

test('openUrl uses a new CDP tab when Chrome debugging is reachable', async () => {
  const calls = [];
  const controller = createChromeController({
    fetchImpl: async (url, options = {}) => {
      calls.push([url, options.method || 'GET']);
      return url.endsWith('/json')
        ? jsonResponse([])
        : jsonResponse({ id: 'new-tab' });
    },
    launch: async () => assert.fail('Must not launch another Chrome')
  });
  const target = 'https://example.com/search?q=two words&ref=a';

  const reply = await controller.openUrl(target);

  assert.deepEqual(calls, [
    [`${CDP_BASE_URL}/json`, 'GET'],
    [`${CDP_BASE_URL}/json/new?${encodeURIComponent(target)}`, 'PUT']
  ]);
  assert.equal(reply, 'Chrome-এ নতুন ট্যাব খোলা হয়েছে।');
});

test('openUrl launches Chrome with an isolated profile if CDP is unavailable', async () => {
  const launches = [];
  const controller = createChromeController({
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
    launch: async (url) => launches.push(url)
  });

  const reply = await controller.openUrl('https://example.com');

  assert.deepEqual(launches, ['https://example.com']);
  assert.equal(reply, 'Chrome চালু করে পেজটি খোলা হয়েছে।');
});

test('openYoutubeUrl navigates an existing YouTube tab instead of creating another', async () => {
  const calls = [];
  const tabs = [
    { type: 'page', id: 'tab-1', title: 'Search', url: 'https://google.com' },
    { type: 'page', id: 'youtube-tab', title: 'YouTube', url: 'https://www.youtube.com/watch?v=old' }
  ];
  const page = {
    url: () => 'https://www.youtube.com/watch?v=old',
    goto: async (...args) => calls.push(['goto', ...args])
  };
  const browser = {
    contexts: () => [{ pages: () => [page] }],
    close: async () => calls.push(['disconnect'])
  };
  const controller = createChromeController({
    fetchImpl: async (url) => {
      calls.push(['fetch', url]);
      return jsonResponse(tabs);
    },
    browserType: {
      connectOverCDP: async (url) => {
        calls.push(['connectOverCDP', url]);
        return browser;
      }
    }
  });
  const target = 'https://www.youtube.com/watch?v=new';

  const reply = await controller.openYoutubeUrl(target);

  assert.deepEqual(calls, [
    ['fetch', `${CDP_BASE_URL}/json`],
    ['connectOverCDP', CDP_BASE_URL],
    ['goto', target, { waitUntil: 'domcontentloaded', timeout: 15000 }],
    ['disconnect']
  ]);
  assert.equal(reply, 'আগের YouTube ট্যাবেই ভিডিওটি খোলা হয়েছে।');
});

test('openYoutubeUrl opens a new tab only when no YouTube tab is listed', async () => {
  const calls = [];
  const controller = createChromeController({
    fetchImpl: async (url, options = {}) => {
      calls.push([url, options.method || 'GET']);
      return url.endsWith('/json')
        ? jsonResponse([{ type: 'page', id: 'tab-1', url: 'https://google.com' }])
        : jsonResponse({ id: 'new-tab' });
    },
    browserType: {
      connectOverCDP: async () => assert.fail('Must not connect to a YouTube tab')
    }
  });
  const target = 'https://www.youtube.com/watch?v=new';

  const reply = await controller.openYoutubeUrl(target);

  assert.deepEqual(calls, [
    [`${CDP_BASE_URL}/json`, 'GET'],
    [`${CDP_BASE_URL}/json`, 'GET'],
    [`${CDP_BASE_URL}/json/new?${encodeURIComponent(target)}`, 'PUT']
  ]);
  assert.equal(reply, 'Chrome-এ নতুন ট্যাব খোলা হয়েছে।');
});

test('openYoutubeUrl launches Chrome when CDP is unavailable', async () => {
  const calls = [];
  const controller = createChromeController({
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
    launch: async (url) => calls.push(['launch', url])
  });

  const reply = await controller.openYoutubeUrl('https://www.youtube.com/watch?v=new');

  assert.deepEqual(calls, [['launch', 'https://www.youtube.com/watch?v=new']]);
  assert.equal(reply, 'Chrome চালু করে পেজটি খোলা হয়েছে।');
});

test('openUrl logs a failed CDP new-tab request and falls back to xdg-open', async () => {
  const calls = [];
  const originalError = console.error;
  console.error = (...args) => calls.push(['error', ...args]);
  try {
    const controller = createChromeController({
      fetchImpl: async (url, options = {}) => {
        calls.push(['fetch', url, options.method || 'GET']);
        return url.endsWith('/json')
          ? jsonResponse([])
          : jsonResponse({}, 500);
      },
      openWithXdg: async (url) => calls.push(['xdg-open', url])
    });

    const reply = await controller.openUrl('https://example.com');

    assert.deepEqual(calls, [
      ['fetch', `${CDP_BASE_URL}/json`, 'GET'],
      ['fetch', `${CDP_BASE_URL}/json/new?https%3A%2F%2Fexample.com`, 'PUT'],
      ['error', 'Chrome CDP new-tab request failed:', 'Chrome DevTools could not open a new tab (HTTP 500).'],
      ['xdg-open', 'https://example.com']
    ]);
    assert.match(reply, /xdg-open দিয়ে URL খোলা হয়েছে/);
  } finally {
    console.error = originalError;
  }
});

test('openUrl reports fallback failure instead of returning a success message', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const controller = createChromeController({
      fetchImpl: async (url) => url.endsWith('/json')
        ? jsonResponse([])
        : jsonResponse({}, 503),
      openWithXdg: async () => { throw new Error('xdg-open is missing'); }
    });

    await assert.rejects(controller.openUrl('https://example.com'), /Could not open URL with Chrome CDP or xdg-open: xdg-open is missing/);
  } finally {
    console.error = originalError;
  }
});

test('launchChrome uses a dedicated profile and detaches the browser process', async () => {
  const calls = [];
  const controller = new EventEmitter();
  controller.unref = () => { calls.push('unref'); };
  const expectedEnv = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':0',
    XDG_DATA_DIRS: '/usr/local/share:/usr/share'
  };
  delete expectedEnv.GTK_PATH;
  delete expectedEnv.GIO_MODULE_DIR;
  delete expectedEnv.GIO_EXTRA_MODULES;
  delete expectedEnv.LD_LIBRARY_PATH;
  delete expectedEnv.GSETTINGS_SCHEMA_DIR;
  let waited;
  await launchChrome('https://example.com', {
    homeDirectory: '/home/test-user',
    wait: async (milliseconds) => { waited = milliseconds; },
    spawnProcess: (command, args, options) => {
      calls.push([command, args, options]);
      process.nextTick(() => controller.emit('spawn'));
      return controller;
    }
  });

  assert.deepEqual(calls, [
    [
      'google-chrome',
      [
        '--remote-debugging-port=9222',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu-sandbox',
        '--user-data-dir=/home/test-user/.chrome-bot-profile',
        'https://example.com'
      ],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: expectedEnv
      }
    ],
    'unref'
  ]);
  assert.equal(waited, 1000);
});

test('launchChrome logs spawn errors and falls back to xdg-open', async () => {
  const controller = new EventEmitter();
  const calls = [];
  const originalError = console.error;
  console.error = (...args) => calls.push(['error', ...args]);
  try {
    await launchChrome('https://example.com', {
      spawnProcess: () => {
        process.nextTick(() => controller.emit('error', new Error('google-chrome not found')));
        return controller;
      },
      openWithXdg: async (url) => calls.push(['xdg-open', url])
    });

    assert.deepEqual(calls, [
      ['error', 'google-chrome launch failed:', 'google-chrome not found'],
      ['xdg-open', 'https://example.com']
    ]);
  } finally {
    console.error = originalError;
  }
});

test('launchChrome logs stderr and falls back if Chrome exits immediately with a non-zero code', async () => {
  const controller = new EventEmitter();
  const stderr = new EventEmitter();
  controller.stderr = stderr;
  controller.unref = () => {};
  const calls = [];
  const originalError = console.error;
  console.error = (...args) => calls.push(['error', ...args]);
  try {
    await launchChrome('https://example.com', {
      wait: async (milliseconds) => {
        assert.equal(milliseconds, 1000);
        stderr.emit('data', Buffer.from('Chrome failed to start'));
        controller.emit('exit', 1, null);
      },
      spawnProcess: () => {
        process.nextTick(() => controller.emit('spawn'));
        return controller;
      },
      openWithXdg: async (url) => calls.push(['xdg-open', url])
    });

    assert.deepEqual(calls, [
      ['error', 'google-chrome stderr:', 'Chrome failed to start'],
      ['error', 'google-chrome launch failed:', 'google-chrome exited with code 1.'],
      ['xdg-open', 'https://example.com']
    ]);
  } finally {
    console.error = originalError;
  }
});
