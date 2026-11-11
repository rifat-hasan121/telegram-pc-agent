const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createActionHandlers,
  createPollingErrorLogger,
  createPasscodeVerifier,
  beginPcUnlock,
  handlePowerCallback,
  handlePendingUnlockMessage,
  isPcUnlockIntent,
  handleTextCommand,
  loadConfig,
  logProcessingError,
  readUserRules,
  sendTelegramReply,
  shellQuote
} = require('../index');

test('shellQuote safely escapes single quotes for shell commands', () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('static unlock passcode accepts a match and rate-limits incorrect attempts', () => {
  let timestamp = 1000;
  const verifier = createPasscodeVerifier('long-random-passcode', {
    now: () => timestamp,
    maxAttempts: 2
  });

  assert.equal(verifier.verify('incorrect'), 'invalid');
  assert.equal(verifier.verify('incorrect'), 'invalid');
  assert.equal(verifier.verify('long-random-passcode'), 'rate_limited');
  timestamp += 5 * 60 * 1000;
  assert.equal(verifier.verify('long-random-passcode'), 'accepted');
});

test('PC unlock intent supports Bengali and English', () => {
  assert.equal(isPcUnlockIntent('unlock pc long-random-passcode'), true);
  assert.equal(isPcUnlockIntent('পিসি আনলক করো পাসওয়ার্ড long-random-passcode'), true);
  assert.equal(isPcUnlockIntent('UNLOCK PC'), true);
});

test('unlock trigger sends prompt and stores both source message IDs per chat', async () => {
  const calls = [];
  const pendingUnlock = new Map();
  const bot = {
    sendMessage: async (...args) => {
      calls.push(['sendMessage', ...args]);
      return { message_id: 90 };
    }
  };

  await beginPcUnlock({
    bot,
    msg: { chat: { id: 456 }, message_id: 9, text: 'unlock pc' },
    pendingUnlock
  });

  assert.deepEqual(calls, [['sendMessage', 456, 'পিসি আনলক করতে পাসকোড দিন:']]);
  assert.equal(pendingUnlock.get(456).promptMsgId, 90);
  assert.equal(pendingUnlock.get(456).requestMsgId, 9);
  clearTimeout(pendingUnlock.get(456).timeout);
});

test('correct passcode deletes all three messages before local unlock', async () => {
  const calls = [];
  const pendingUnlock = new Map([[456, {
    promptMsgId: 90,
    requestMsgId: 9,
    timeout: setTimeout(() => {}, 60000)
  }]]);
  const bot = {
    deleteMessage: async (...args) => calls.push(['deleteMessage', ...args]),
    sendMessage: async (...args) => {
      calls.push(['sendMessage', ...args]);
      return { message_id: 91 };
    }
  };
  const handled = await handlePendingUnlockMessage({
    bot,
    msg: { chat: { id: 456 }, message_id: 100, text: ' long-random-passcode ' },
    pendingUnlock,
    verifier: createPasscodeVerifier('long-random-passcode'),
    unlockPc: async () => {
      calls.push(['unlock']);
      return 'পিসি আনলক করা হয়েছে।';
    }
  });

  assert.equal(handled, true);
  assert.equal(pendingUnlock.has(456), false);
  assert.deepEqual(calls, [
    ['deleteMessage', 456, 100],
    ['deleteMessage', 456, 90],
    ['deleteMessage', 456, 9],
    ['unlock'],
    ['sendMessage', 456, 'পিসি আনলক করা হয়েছে।']
  ]);
});

test('wrong passcode deletes pending messages and never unlocks', async () => {
  const calls = [];
  const pendingUnlock = new Map([[456, {
    promptMsgId: 90,
    requestMsgId: 9,
    timeout: setTimeout(() => {}, 60000)
  }]]);
  const bot = {
    deleteMessage: async (...args) => calls.push(['deleteMessage', ...args]),
    sendMessage: async (...args) => {
      calls.push(['sendMessage', ...args]);
      return { message_id: 91 };
    }
  };
  const handled = await handlePendingUnlockMessage({
    bot,
    msg: { chat: { id: 456 }, message_id: 100, text: 'wrong' },
    pendingUnlock,
    verifier: createPasscodeVerifier('long-random-passcode'),
    unlockPc: async () => { calls.push(['unlock']); }
  });

  assert.equal(handled, true);
  assert.equal(pendingUnlock.has(456), false);
  assert.deepEqual(calls, [
    ['deleteMessage', 456, 100],
    ['deleteMessage', 456, 90],
    ['deleteMessage', 456, 9],
    ['sendMessage', 456, 'ভুল পাসকোড।']
  ]);
});

test('pending unlock expires after its timeout and removes the trigger and prompt', async () => {
  const calls = [];
  const pendingUnlock = new Map();
  const bot = {
    sendMessage: async () => ({ message_id: 90 }),
    deleteMessage: async (...args) => calls.push(args)
  };
  await beginPcUnlock({
    bot,
    msg: { chat: { id: 456 }, message_id: 9 },
    pendingUnlock,
    timeoutMs: 5
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pendingUnlock.has(456), false);
  assert.deepEqual(calls, [[456, 90], [456, 9]]);
});

function fakeUnlockChild({ code = 0, stdout = '', stderr = '', error } = {}) {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  process.nextTick(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    if (error) child.emit('error', error);
    else child.emit('close', code);
  });
  return child;
}

test('unlock_pc runs non-interactive sudo and reports success', async () => {
  const calls = [];
  const handlers = createActionHandlers(
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (...args) => {
      calls.push(args);
      return fakeUnlockChild();
    }
  );

  const result = await handlers.unlock_pc();

  assert.deepEqual(calls, [[
    '/usr/bin/sudo',
    ['-n', '/usr/bin/loginctl', 'unlock-sessions'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ]]);
  assert.equal(result, 'পিসি আনলক করা হয়েছে।');
});

test('power_control creates an inline shutdown confirmation without running a command', async () => {
  const calls = [];
  const pendingPower = new Map();
  const bot = {
    sendMessage: async (...args) => {
      calls.push(['sendMessage', ...args]);
      return { message_id: 123 };
    }
  };
  const handlers = createActionHandlers(
    undefined, undefined, undefined, undefined, undefined,
    { bot, chatId: 456, pendingPower }
  );

  const result = await handlers.power_control({ action: 'shutdown' });

  assert.equal(result, null);
  assert.deepEqual(calls, [
    ['sendMessage', 456, 'আপনি কি নিশ্চিতভাবে পিসি বন্ধ করতে চান?', {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ হ্যাঁ, নিশ্চিত', callback_data: 'power_confirm' },
          { text: '❌ বাতিল', callback_data: 'power_cancel' }
        ]]
      }
    }]
  ]);
  assert.equal(pendingPower.get(456).action, 'shutdown');
  assert.equal(pendingPower.get(456).promptMsgId, 123);
  clearTimeout(pendingPower.get(456).timeout);
});

test('power_control creates a restart confirmation prompt', async () => {
  const calls = [];
  const pendingPower = new Map();
  const bot = {
    sendMessage: async (...args) => {
      calls.push(['sendMessage', ...args]);
      return { message_id: 124 };
    }
  };
  const handlers = createActionHandlers(
    undefined, undefined, undefined, undefined, undefined,
    { bot, chatId: 456, pendingPower }
  );

  await handlers.power_control({ action: 'restart' });

  assert.equal(calls[0][1], 456);
  assert.equal(calls[0][2], 'আপনি কি নিশ্চিতভাবে পিসি রিস্টার্ট করতে চান?');
  assert.equal(pendingPower.get(456).action, 'restart');
  clearTimeout(pendingPower.get(456).timeout);
});

test('power callback authorizes, confirms, edits, waits, then runs shutdown', async () => {
  const calls = [];
  const pendingPower = new Map();
  const state = {
    action: 'shutdown',
    expiresAt: Date.now() + 30000,
    promptMsgId: 123,
    timeout: setTimeout(() => {}, 30000)
  };
  pendingPower.set(456, state);
  const bot = {
    answerCallbackQuery: async (...args) => calls.push(['answer', ...args]),
    editMessageText: async (...args) => calls.push(['edit', ...args])
  };

  await handlePowerCallback({
    bot,
    query: {
      id: 'callback-1',
      from: { id: 789 },
      data: 'power_confirm',
      message: { message_id: 123, chat: { id: 456 } }
    },
    allowedUserId: '789',
    pendingPower,
    wait: async (milliseconds) => calls.push(['wait', milliseconds]),
    runProgram: async (...args) => calls.push(['runProgram', ...args])
  });

  assert.equal(pendingPower.has(456), false);
  assert.deepEqual(calls, [
    ['answer', 'callback-1'],
    ['edit', 'পিসি বন্ধ করা হচ্ছে...', {
      chat_id: 456,
      message_id: 123,
      reply_markup: { inline_keyboard: [] }
    }],
    ['wait', 1500],
    ['runProgram', '/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'poweroff'], { timeout: 10000 }]
  ]);
});

test('power callback runs restart only after explicit confirmation', async () => {
  const calls = [];
  const pendingPower = new Map([[456, {
    action: 'restart',
    expiresAt: Date.now() + 30000,
    promptMsgId: 124,
    timeout: setTimeout(() => {}, 30000)
  }]]);
  const bot = {
    answerCallbackQuery: async (...args) => calls.push(['answer', ...args]),
    editMessageText: async (...args) => calls.push(['edit', ...args])
  };
  await handlePowerCallback({
    bot,
    query: {
      id: 'callback-restart',
      from: { id: 789 },
      data: 'power_confirm',
      message: { message_id: 124, chat: { id: 456 } }
    },
    allowedUserId: '789',
    pendingPower,
    wait: async (milliseconds) => calls.push(['wait', milliseconds]),
    runProgram: async (...args) => calls.push(['runProgram', ...args])
  });

  assert.deepEqual(calls, [
    ['answer', 'callback-restart'],
    ['edit', 'পিসি রিস্টার্ট করা হচ্ছে...', {
      chat_id: 456,
      message_id: 124,
      reply_markup: { inline_keyboard: [] }
    }],
    ['wait', 1500],
    ['runProgram', '/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'reboot'], { timeout: 10000 }]
  ]);
});

test('power callback cancellation clears state and does not run a command', async () => {
  const calls = [];
  const pendingPower = new Map([[456, {
    action: 'restart',
    expiresAt: Date.now() + 30000,
    promptMsgId: 124,
    timeout: setTimeout(() => {}, 30000)
  }]]);
  const bot = {
    answerCallbackQuery: async (...args) => calls.push(['answer', ...args]),
    editMessageText: async (...args) => calls.push(['edit', ...args])
  };

  await handlePowerCallback({
    bot,
    query: {
      id: 'callback-2',
      from: { id: 789 },
      data: 'power_cancel',
      message: { message_id: 124, chat: { id: 456 } }
    },
    allowedUserId: '789',
    pendingPower
  });

  assert.equal(pendingPower.has(456), false);
  assert.deepEqual(calls, [
    ['answer', 'callback-2'],
    ['edit', 'বাতিল করা হয়েছে।', {
      chat_id: 456,
      message_id: 124,
      reply_markup: { inline_keyboard: [] }
    }]
  ]);
});

test('power callback ignores unauthorized users before touching pending state', async () => {
  const calls = [];
  const pendingPower = new Map([[456, {
    action: 'shutdown',
    expiresAt: Date.now() + 30000,
    promptMsgId: 123,
    timeout: setTimeout(() => {}, 30000)
  }]]);
  const handled = await handlePowerCallback({
    bot: {
      answerCallbackQuery: async (...args) => calls.push(args),
      editMessageText: async (...args) => calls.push(args)
    },
    query: {
      id: 'callback-3',
      from: { id: 999 },
      data: 'power_confirm',
      message: { message_id: 123, chat: { id: 456 } }
    },
    allowedUserId: '789',
    pendingPower
  });
  clearTimeout(pendingPower.get(456).timeout);
  assert.equal(handled, false);
  assert.equal(pendingPower.has(456), true);
  assert.deepEqual(calls, []);
});

test('power callback expires stale confirmations without running a command', async () => {
  const calls = [];
  const pendingPower = new Map([[456, {
    action: 'restart',
    expiresAt: 1000,
    promptMsgId: 124,
    timeout: setTimeout(() => {}, 30000)
  }]]);
  const bot = {
    answerCallbackQuery: async (...args) => calls.push(['answer', ...args]),
    editMessageText: async (...args) => calls.push(['edit', ...args])
  };
  await handlePowerCallback({
    bot,
    query: {
      id: 'callback-4',
      from: { id: 789 },
      data: 'power_confirm',
      message: { message_id: 124, chat: { id: 456 } }
    },
    allowedUserId: '789',
    pendingPower,
    now: () => 1001
  });
  assert.equal(pendingPower.has(456), false);
  assert.deepEqual(calls, [
    ['answer', 'callback-4', { text: 'অনুরোধটির সময় শেষ হয়েছে।' }],
    ['edit', 'অনুরোধটির সময় শেষ হয়েছে।', {
      chat_id: 456,
      message_id: 124,
      reply_markup: { inline_keyboard: [] }
    }]
  ]);
});

test('unlock_pc does not run loginctl unlock-sessions without sudo', async () => {
  const calls = [];
  const handlers = createActionHandlers(
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (executable, args, options) => {
      calls.push([executable, args, options]);
      return fakeUnlockChild({
        code: 1,
        stderr: 'sudo: a password is required\n'
      });
    }
  );
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args);
  try {
    assert.equal(await handlers.unlock_pc(), 'পিসি আনলক করা যায়নি।');
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(calls.map(([executable, args]) => [executable, args]), [
    ['/usr/bin/sudo', ['-n', '/usr/bin/loginctl', 'unlock-sessions']],
    ['/usr/bin/loginctl', ['list-sessions', '--no-legend']]
  ]);
  assert.equal(logs[0][1].stderr, 'sudo: a password is required\n');
  assert.equal(logs[0][1].error, 'Process exited with code 1');
  assert.equal(logs.some(([, details]) => details.command === '/usr/bin/loginctl unlock-sessions'), false);
});

test('unlock_pc finds and unlocks the active graphical session when unlock-sessions fails', async () => {
  const calls = [];
  const uid = String(process.getuid());
  const outputs = [
    { code: 1, stderr: 'sudo denied\n' },
    { stdout: `7 ${uid} test-user seat0 tty2\n` },
    { stdout: 'Active=yes\nType=wayland\nSeat=seat0\n' },
    {}
  ];
  const handlers = createActionHandlers(
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (executable, args) => {
      calls.push([executable, args]);
      return fakeUnlockChild(outputs.shift());
    }
  );
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args);
  try {
    assert.equal(await handlers.unlock_pc(), 'পিসি আনলক করা হয়েছে।');
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(calls, [
    ['/usr/bin/sudo', ['-n', '/usr/bin/loginctl', 'unlock-sessions']],
    ['/usr/bin/loginctl', ['list-sessions', '--no-legend']],
    ['/usr/bin/loginctl', ['show-session', '7', '--property=Active', '--property=Type', '--property=Seat']],
    ['/usr/bin/sudo', ['-n', '/usr/bin/loginctl', 'unlock-session', '7']]
  ]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].stderr, 'sudo denied\n');
});

test('unlock_pc logs spawn errors and returns failure when no fallback succeeds', async () => {
  const handlers = createActionHandlers(
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => fakeUnlockChild({ error: new Error('spawn unavailable') })
  );
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args);
  try {
    assert.equal(await handlers.unlock_pc(), 'পিসি আনলক করা যায়নি।');
  } finally {
    console.error = originalError;
  }

  assert.ok(logs.length >= 2);
  assert.equal(logs[0][1].error, 'spawn unavailable');
});

test('play_youtube searches and opens the first video result, returning its exact title', async () => {
  const calls = [];
  const searches = [];
  const handlers = createActionHandlers(
    async (...args) => calls.push(args),
    async (query) => {
      searches.push(query);
      return {
        videos: [
          { title: 'First exact video title', url: 'https://www.youtube.com/watch?v=first' },
          { title: 'Second video', url: 'https://www.youtube.com/watch?v=second' }
        ]
      };
    },
    undefined,
    undefined,
    { openYoutubeUrl: async (url) => {
      calls.push(['openYoutubeUrl', url]);
      return 'Chrome-এ নতুন ট্যাব খোলা হয়েছে।';
    } }
  );

  const result = await handlers.play_youtube({ query: 'cats & dogs' });

  assert.deepEqual(searches, ['cats & dogs']);
  assert.deepEqual(calls[0], ['openYoutubeUrl', 'https://www.youtube.com/watch?v=first']);
  assert.equal(result, 'YouTube-এ “First exact video title” চালানো হচ্ছে। Chrome-এ নতুন ট্যাব খোলা হয়েছে।');
});

test('play_youtube reports an empty search result without opening a browser', async () => {
  const calls = [];
  const originalError = console.error;
  console.error = () => {};
  const handlers = createActionHandlers(
    async (...args) => calls.push(args),
    async () => ({ videos: [] })
  );

  try {
    await assert.rejects(handlers.play_youtube({ query: 'unknown video' }), /No YouTube video was found/);
    assert.equal(calls.length, 0);
  } finally {
    console.error = originalError;
  }
});

test('youtube_action delegates the action and optional comment text', async () => {
  const calls = [];
  const handlers = createActionHandlers(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      youtubeAction: async (...args) => {
        calls.push(args);
        return 'YouTube ভিডিওটি pause করা হয়েছে।';
      }
    }
  );

  const reply = await handlers.youtube_action({ action: 'play_pause' });
  await handlers.youtube_action({ action: 'comment', text: 'Great video!' });

  assert.deepEqual(calls, [
    ['play_pause', undefined],
    ['comment', 'Great video!']
  ]);
  assert.equal(reply, 'YouTube ভিডিওটি pause করা হয়েছে।');
});

test('browse_and_act passes the URL and goal to the browser agent', async () => {
  const calls = [];
  const handlers = createActionHandlers(
    async () => {},
    async () => ({ videos: [] }),
    async (...args) => {
      calls.push(args);
      return 'Found and played the requested video.';
    }
  );

  const reply = await handlers.browse_and_act({
    url: 'https://youtube.com',
    goal: 'Find the most viewed video and play it'
  });

  assert.deepEqual(calls, [['https://youtube.com', 'Find the most viewed video and play it']]);
  assert.equal(reply, 'Found and played the requested video.');
});

test('set_volume uses fixed pactl arguments and replies in Bengali', async () => {
  const calls = [];
  const handlers = createActionHandlers(
    async () => {},
    async () => ({ videos: [] }),
    undefined,
    async (...args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    }
  );

  const reply = await handlers.set_volume({ operation: 'set', percentage: 50 });

  assert.deepEqual(calls, [[
    'pactl',
    ['set-sink-volume', '@DEFAULT_SINK@', '50%'],
    { timeout: 10000 }
  ]]);
  assert.equal(reply, 'ভলিউম 50% সেট করা হয়েছে।');
});

test('set_volume bounds relative volume changes between zero and one hundred', async () => {
  const calls = [];
  const handlers = createActionHandlers(
    async () => {},
    async () => ({ videos: [] }),
    undefined,
    async (...args) => {
      calls.push(args);
      if (args[1][0] === 'get-sink-volume') {
        return { stdout: 'Volume: front-left: 65536 / 80% / 0.00 dB\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
  );

  const reply = await handlers.set_volume({ operation: 'increase', percentage: 50 });

  assert.deepEqual(calls.map(([program, args]) => [program, args]), [
    ['pactl', ['get-sink-volume', '@DEFAULT_SINK@']],
    ['pactl', ['set-sink-volume', '@DEFAULT_SINK@', '100%']]
  ]);
  assert.equal(reply, 'ভলিউম 100% বাড়ানো হয়েছে।');
  await assert.rejects(handlers.set_volume({ operation: 'set', percentage: 101 }), /integer from 0 to 100/);
  await assert.rejects(handlers.set_volume({ operation: 'reset', percentage: 50 }), /Unsupported volume operation/);
});

test('close_tab delegates the requested tab name to Chrome CDP', async () => {
  const calls = [];
  const handlers = createActionHandlers(
    async () => {},
    async () => ({ videos: [] }),
    undefined,
    undefined,
    { closeTab: async (tabName) => {
      calls.push(tabName);
      return '“youtube” মেলে এমন 1টি Chrome ট্যাব বন্ধ করা হয়েছে।';
    } }
  );

  const reply = await handlers.close_tab({ tabName: 'youtube' });

  assert.deepEqual(calls, ['youtube']);
  assert.equal(reply, '“youtube” মেলে এমন 1টি Chrome ট্যাব বন্ধ করা হয়েছে।');
});

test('close_browser closes only the known browser processes when requested completely', async () => {
  const calls = [];
  const handlers = createActionHandlers(
    async () => {},
    async () => ({ videos: [] }),
    undefined,
    async (...args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    }
  );

  const reply = await handlers.close_browser({ target: 'browser' });

  assert.deepEqual(calls.map(([program, args]) => [program, args]), [
    ['pkill', ['-x', 'chrome']],
    ['pkill', ['-x', 'chromium']],
    ['pkill', ['-x', 'firefox']]
  ]);
  assert.equal(reply, 'ব্রাউজার বন্ধ করা হয়েছে।');
  await assert.rejects(handlers.close_browser({ target: 'youtube_tab' }), /Unsupported browser close target/);
});

test('open_url rejects non-web protocols without running a command', async () => {
  const calls = [];
  const originalError = console.error;
  console.error = () => {};
  const handlers = createActionHandlers(async (...args) => calls.push(args));

  try {
    await assert.rejects(handlers.open_url({ url: 'file:///etc/passwd' }), /Only HTTP and HTTPS/);
    assert.equal(calls.length, 0);
  } finally {
    console.error = originalError;
  }
});

test('open_url opens a validated URL using the CDP controller', async () => {
  const calls = [];
  const handlers = createActionHandlers(
    async () => {},
    async () => ({ videos: [] }),
    undefined,
    undefined,
    { openUrl: async (url) => {
      calls.push(url);
      return 'Chrome-এ নতুন ট্যাব খোলা হয়েছে।';
    } }
  );

  const reply = await handlers.open_url({ url: 'https://example.com/a?q=hello%20world' });

  assert.deepEqual(calls, ['https://example.com/a?q=hello%20world']);
  assert.equal(reply, 'Chrome-এ নতুন ট্যাব খোলা হয়েছে।');
});

test('play_youtube logs browser opening errors and rethrows them for Telegram', async () => {
  const calls = [];
  const originalError = console.error;
  console.error = (...args) => calls.push(args);
  try {
    const handlers = createActionHandlers(
      async () => {},
      async () => ({
        videos: [{ title: 'Result', url: 'https://www.youtube.com/watch?v=video' }]
      }),
      undefined,
      undefined,
      { openYoutubeUrl: async () => { throw new Error('Chrome could not open tab'); } }
    );

    await assert.rejects(handlers.play_youtube({ query: 'music' }), /Chrome could not open tab/);
    assert.deepEqual(calls, [['play_youtube failed:', 'Chrome could not open tab']]);
  } finally {
    console.error = originalError;
  }
});

test('open_url logs failures and rethrows the original message for Telegram', async () => {
  const calls = [];
  const originalError = console.error;
  console.error = (...args) => calls.push(args);
  try {
    const handlers = createActionHandlers(
      async () => {},
      async () => ({ videos: [] }),
      undefined,
      undefined,
      { openUrl: async () => { throw new Error('Chrome could not open tab'); } }
    );

    await assert.rejects(handlers.open_url({ url: 'https://example.com' }), /Chrome could not open tab/);
    assert.deepEqual(calls, [['open_url failed:', 'Chrome could not open tab']]);
  } finally {
    console.error = originalError;
  }
});

test('polling error logger logs EFATAL only once and logs the error message', () => {
  const logged = [];
  const logError = createPollingErrorLogger((...args) => logged.push(args));

  logError({ code: 'EFATAL', message: 'Network dropped' });
  logError({ code: 'EFATAL', message: 'Network dropped again' });
  logError({ code: 'ETELEGRAM', message: 'Telegram API returned an error' });

  assert.deepEqual(logged, [
    ['Telegram polling error:', 'Network dropped'],
    ['Telegram polling error:', 'Telegram API returned an error']
  ]);
});

test('sendTelegramReply retries transient Telegram errors and then succeeds', async () => {
  let attempts = 0;
  await sendTelegramReply({
    sendMessage: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('EFATAL: AggregateError');
        error.code = 'EFATAL';
        throw error;
      }
      return true;
    }
  }, 123, 'উত্তর');

  assert.equal(attempts, 3);
});

test('system_command allows only lock and mute commands', async () => {
  const calls = [];
  const handlers = createActionHandlers(async (...args) => calls.push(args));

  await handlers.system_command({ action: 'lock_screen' });
  await handlers.system_command({ action: 'volume_mute' });
  await assert.rejects(handlers.system_command({ action: 'reboot' }), /Unsupported system action/);

  assert.deepEqual(calls.map(([command]) => command), [
    'xdg-screensaver lock',
    'amixer set Master toggle'
  ]);
});

test('run_bash runs only fixed read-only diagnostics and returns stdout and stderr', async () => {
  const calls = [];
  const handlers = createActionHandlers(async (...args) => {
    calls.push(args);
    return { stdout: 'running apps', stderr: 'diagnostic warning' };
  });

  const result = await handlers.run_bash({ action: 'list_running_apps' });

  assert.deepEqual(calls, [[
    `ps -u "$USER" -o comm= --sort=-%mem | awk '!seen[$0]++' | head -n 25`,
    { timeout: 15000 }
  ]]);
  assert.deepEqual(result, {
    stdout: 'running apps',
    stderr: 'diagnostic warning',
    exitCode: 0
  });
  await assert.rejects(
    handlers.run_bash({ action: 'echo unsafe' }),
    /Unsupported read-only diagnostic action/
  );
  assert.equal(calls.length, 1);
});

test('run_bash system stats uses a fixed command and includes command errors', async () => {
  const calls = [];
  const handlers = createActionHandlers(async (...args) => {
    calls.push(args);
    const error = new Error('partial diagnostics');
    error.stdout = 'CPU: 2%';
    error.stderr = 'upower unavailable';
    error.code = 1;
    throw error;
  });

  const result = await handlers.run_bash({ action: 'system_stats' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].timeout, 15000);
  assert.match(calls[0][0], /top -bn1/);
  assert.match(calls[0][0], /free -h/);
  assert.match(calls[0][0], /upower/);
  assert.match(calls[0][0], /df -h \//);
  assert.deepEqual(result, {
    stdout: 'CPU: 2%',
    stderr: 'upower unavailable',
    exitCode: 1
  });
});

test('take_screenshot captures with desktop environment, sends the image, and removes the temporary file', async () => {
  const calls = [];
  const removed = [];
  const bot = {
    sendPhoto: async (...args) => calls.push(['sendPhoto', ...args])
  };
  const handlers = createActionHandlers(
    async (...args) => {
      calls.push(['exec', ...args]);
      return { stdout: '', stderr: '' };
    },
    undefined,
    undefined,
    undefined,
    undefined,
    { bot, chatId: 456 },
    {
      existsSync: (filePath) => filePath === '/tmp/screenshot_1234.png',
      unlinkSync: (filePath) => removed.push(filePath)
    },
    '/home/test-user',
    () => 1234
  );

  const reply = await handlers.take_screenshot({});

  assert.equal(calls[0][0], 'exec');
  assert.equal(calls[0][1], 'gnome-screenshot -f "/tmp/screenshot_1234.png"');
  assert.equal(calls[0][2].timeout, 15000);
  assert.equal(calls[0][2].env.DISPLAY, process.env.DISPLAY);
  assert.equal(calls[0][2].env.WAYLAND_DISPLAY, process.env.WAYLAND_DISPLAY);
  assert.deepEqual(calls[1], ['sendPhoto', 456, '/tmp/screenshot_1234.png']);
  assert.deepEqual(removed, ['/tmp/screenshot_1234.png']);
  assert.equal(reply, 'স্ক্রিনশটটি Telegram-এ পাঠানো হয়েছে।');
});

test('take_screenshot removes the temporary file when Telegram photo delivery fails', async () => {
  const removed = [];
  const handlers = createActionHandlers(
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    { bot: { sendPhoto: async () => { throw new Error('Telegram upload failed'); } }, chatId: 456 },
    {
      existsSync: () => true,
      unlinkSync: (filePath) => removed.push(filePath)
    },
    '/home/test-user',
    () => 1234
  );

  await assert.rejects(handlers.take_screenshot({}), /Telegram upload failed/);
  assert.deepEqual(removed, ['/tmp/screenshot_1234.png']);
});

test('take_screenshot removes a partial temporary file when capture fails', async () => {
  const removed = [];
  const handlers = createActionHandlers(
    async () => { throw new Error('gnome-screenshot failed'); },
    undefined,
    undefined,
    undefined,
    undefined,
    { bot: { sendPhoto: async () => assert.fail('Must not send a failed capture') }, chatId: 456 },
    {
      existsSync: () => true,
      unlinkSync: (filePath) => removed.push(filePath)
    },
    '/home/test-user',
    () => 1234
  );

  await assert.rejects(handlers.take_screenshot({}), /gnome-screenshot failed/);
  assert.deepEqual(removed, ['/tmp/screenshot_1234.png']);
});

test('send_file resolves home paths, sends existing files, and reports missing paths in Bengali', async () => {
  const calls = [];
  const handlers = createActionHandlers(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      bot: { sendDocument: async (...args) => calls.push(args) },
      chatId: 456
    },
    {
      existsSync: (filePath) => filePath === '/home/test-user/Downloads/test.pdf',
      statSync: () => ({ isFile: () => true })
    },
    '/home/test-user'
  );

  const reply = await handlers.send_file({ filePath: '~/Downloads/test.pdf' });
  assert.deepEqual(calls, [[456, '/home/test-user/Downloads/test.pdf']]);
  assert.equal(reply, 'ফাইলটি Telegram-এ পাঠানো হয়েছে।');

  const missing = await handlers.send_file({ filePath: 'Documents/missing.pdf' });
  assert.match(missing, /ফাইলটি পাওয়া যায়নি/);
  assert.match(missing, /\/home\/test-user\/Documents\/missing\.pdf/);
  assert.equal(calls.length, 1);
});

test('save_rule appends a normalized rule to rules.txt', async () => {
  const calls = [];
  const handlers = createActionHandlers(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      appendFileSync: (...args) => calls.push(args)
    },
    undefined,
    undefined,
    '/project/rules.txt'
  );

  const reply = await handlers.save_rule({ rule: 'Always reply in Bengali\nand be concise' });

  assert.deepEqual(calls, [['/project/rules.txt', '- Always reply in Bengali and be concise\n', 'utf8']]);
  assert.equal(reply, 'নিয়মটি ভবিষ্যতের জন্য সংরক্ষণ করা হয়েছে।');
  await assert.rejects(handlers.save_rule({ rule: '  ' }), /Invalid rule/);
  await assert.rejects(handlers.save_rule({ rule: 'x'.repeat(1001) }), /Invalid rule/);
});

test('readUserRules reads existing memory and returns empty text when no rules file exists', () => {
  const calls = [];
  const fileSystem = {
    existsSync: (filePath) => filePath === '/project/rules.txt',
    readFileSync: (...args) => {
      calls.push(args);
      return '- Reply in Bengali\n- Keep answers short\n';
    }
  };

  assert.equal(readUserRules('/project/rules.txt', fileSystem), '- Reply in Bengali\n- Keep answers short');
  assert.deepEqual(calls, [['/project/rules.txt', 'utf8']]);
  assert.equal(readUserRules('/project/missing.txt', fileSystem), '');
});

test('loadConfig requires the three configured values and a numeric user id', () => {
  assert.deepEqual(loadConfig({
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    ALLOWED_USER_ID: '12345',
    OPENROUTER_API_KEY: 'router-key'
  }), {
    telegramToken: 'telegram-token',
    allowedUserId: '12345',
    openRouterApiKey: 'router-key',
    unlockPasscode: '',
    browserAllowedDomains: ['youtube.com', 'xhamster.com', 'pornhub.com']
  });
  assert.throws(() => loadConfig({}), /Set TELEGRAM_BOT_TOKEN/);
  assert.equal(loadConfig({
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    ALLOWED_USER_ID: '12345',
    OPENROUTER_API_KEY: 'router-key',
    UNLOCK_PASSCODE: 'static-passcode'
  }).unlockPasscode, 'static-passcode');
});

test('logProcessingError includes useful diagnostics without dumping the error object', () => {
  const originalError = console.error;
  let logged;
  console.error = (...args) => { logged = args; };
  try {
    const error = new Error('Invalid API key');
    error.status = 401;
    error.code = 'auth_error';
    error.apiKey = 'must-not-be-logged';

    logProcessingError('OpenRouter request', error);

    assert.equal(logged[0], 'Authorized message OpenRouter request failed:');
    assert.deepEqual(logged[1], {
      name: 'Error',
      message: 'Invalid API key',
      status: 401,
      code: 'auth_error'
    });
    assert.doesNotMatch(JSON.stringify(logged), /must-not-be-logged/);
  } finally {
    console.error = originalError;
  }
});

test('handleTextCommand executes the model-selected allowlisted tool', async () => {
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          assert.equal(request.model, 'google/gemini-2.5-flash');
          assert.equal(request.max_tokens, 1000);
          assert.equal(request.tools.length, 13);
          const powerTool = request.tools.find((tool) => tool.function.name === 'power_control');
          assert.deepEqual(powerTool.function.parameters.properties.action.enum, ['shutdown', 'restart']);
          assert.equal(request.messages[0].role, 'system');
          assert.match(request.messages[0].content, /both Bengali and English/);
          assert.match(request.messages[0].content, /do not ask any clarifying questions/);
          assert.match(request.messages[0].content, /requests for information or lists directly/);
          assert.match(request.messages[0].content, /call browse_and_act/);
          assert.match(request.messages[0].content, /call close_tab/);
          assert.match(request.messages[0].content, /run_bash with action "list_running_apps"/);
          assert.match(request.messages[0].content, /never request arbitrary shell commands/);
          assert.match(request.messages[0].content, /"স্ক্রিনশট পাঠাও".*call take_screenshot/);
          assert.match(request.messages[0].content, /"আমার X ফাইলটা পাঠাও".*call send_file/);
          assert.match(request.messages[0].content, /"মনে রাখো".*call save_rule/);
          assert.match(request.messages[0].content, /Use youtube_action for actions on the currently open YouTube video/);
          assert.match(request.messages[0].content, /"ফুল স্কিন করো".*"fullscreen_on"/);
          assert.match(request.messages[0].content, /"ফুল স্কিন অফ করো".*"fullscreen_off"/);
          assert.match(request.messages[0].content, /"লাইক তুলে নাও".*"unlike"/);
          assert.match(request.messages[0].content, /Never ask for or process an Ubuntu password or PC unlock passcode/);
          assert.match(request.messages[0].content, /"পিসি বন্ধ করো".*"shutdown"/);
          assert.match(request.messages[0].content, /"পিসি রিস্টার্ট করো".*"restart"/);
          assert.match(request.messages[0].content, /authorized user presses the confirmation button/);
          assert.match(request.messages[0].content, /ইউটিউব ট্যাব close করে দাও/);
          return {
            choices: [{
              message: {
                tool_calls: [{
                  function: { name: 'system_command', arguments: '{"action":"lock_screen"}' }
                }]
              }
            }]
          };
        }
      }
    }
  };
  const calls = [];
  const handlers = createActionHandlers(async (command) => calls.push(command));

  const reply = await handleTextCommand(openai, 'Lock my screen', handlers);

  assert.deepEqual(calls, ['xdg-screensaver lock']);
  assert.equal(reply, 'Locked the screen.');
});

test('handleTextCommand passes diagnostic stdout and stderr to the model for Bengali summary', async () => {
  const requests = [];
  const toolCall = {
    id: 'diagnostics-1',
    type: 'function',
    function: {
      name: 'run_bash',
      arguments: '{"action":"list_running_apps"}'
    }
  };
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          requests.push(request);
          if (requests.length === 1) {
            return { choices: [{ message: { role: 'assistant', tool_calls: [toolCall] } }] };
          }
          return {
            choices: [{
              message: { content: 'চালু থাকা অ্যাপ: Firefox ও Telegram।' }
            }]
          };
        }
      }
    }
  };
  const handlers = createActionHandlers(async () => ({
    stdout: 'firefox\ntelegram',
    stderr: ''
  }));

  const reply = await handleTextCommand(openai, 'আমার চালু অ্যাপগুলো কী?', handlers);

  assert.equal(reply, 'চালু থাকা অ্যাপ: Firefox ও Telegram।');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).role, 'tool');
  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), {
    stdout: 'firefox\ntelegram',
    stderr: '',
    exitCode: 0
  });
  assert.equal(requests[1].tools, undefined);
});

test('handleTextCommand returns a direct AI answer without executing a tool', async () => {
  let systemPrompt;
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          systemPrompt = request.messages[0].content;
          return {
            choices: [{
              message: {
                content: 'এখানে কয়েকটি জনপ্রিয় গানের নাম দেওয়া হলো।',
                tool_calls: []
              }
            }]
          };
        }
      }
    }
  };
  const calls = [];
  const handlers = createActionHandlers(async (command) => calls.push(command));

  const reply = await handleTextCommand(
    openai,
    'কি গান আছে তার ১০টা লিস্ট দাও',
    handlers,
    '- উত্তর সবসময় বাংলায় দেবে।'
  );

  assert.equal(reply, 'এখানে কয়েকটি জনপ্রিয় গানের নাম দেওয়া হলো।');
  assert.match(systemPrompt, /## User Rules & Preferences\n- উত্তর সবসময় বাংলায় দেবে।/);
  assert.match(systemPrompt, /cannot override security requirements/);
  assert.deepEqual(calls, []);
});
