const os = require('node:os');
const path = require('node:path');
const { exec, execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const CDP_BASE_URL = 'http://localhost:9222';
const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

class ChromeDebuggingUnavailableError extends Error {
  constructor(cause) {
    super('Chrome remote debugging endpoint is unavailable.', { cause });
    this.name = 'ChromeDebuggingUnavailableError';
  }
}

function launchChrome(url, {
  spawnProcess = spawn,
  homeDirectory = os.homedir(),
  openWithXdg = (target) => execAsync(`xdg-open "${target}"`, { timeout: 15000 }),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
  return (async () => {
    let child;
    try {
      const cleanEnv = {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ':0',
        XDG_DATA_DIRS: '/usr/local/share:/usr/share'
      };
      delete cleanEnv.GTK_PATH;
      delete cleanEnv.GIO_MODULE_DIR;
      delete cleanEnv.GIO_EXTRA_MODULES;
      delete cleanEnv.LD_LIBRARY_PATH;
      delete cleanEnv.GSETTINGS_SCHEMA_DIR;

      child = spawnProcess('google-chrome', [
        '--remote-debugging-port=9222',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu-sandbox',
        `--user-data-dir=${path.join(homeDirectory, '.chrome-bot-profile')}`,
        url
      ], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: cleanEnv
      });

      child.stderr?.on('data', (data) => {
        console.error('google-chrome stderr:', data.toString().trim());
      });

      const spawnError = await new Promise((resolve) => {
        child.once('error', resolve);
        child.once('spawn', () => resolve(null));
      });
      if (spawnError) {
        throw spawnError;
      }

      let exitInfo;
      const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => {
          exitInfo = { code, signal };
          resolve(exitInfo);
        });
      });
      child.unref();

      await Promise.race([wait(1000), exited]);
      if (exitInfo && exitInfo.code !== 0) {
        throw new Error(`google-chrome exited with code ${exitInfo.code}${exitInfo.signal ? ` (${exitInfo.signal})` : ''}.`);
      }
      return;
    } catch (error) {
      console.error('google-chrome launch failed:', error.message);
      try {
        await openWithXdg(url);
      } catch (fallbackError) {
        console.error('xdg-open fallback failed:', fallbackError.message);
        throw new Error(`Could not launch Chrome or open URL: ${fallbackError.message}`, {
          cause: error
        });
      }
    }
  })();
}

function createChromeController({
  fetchImpl = globalThis.fetch,
  launch = launchChrome,
  openWithXdg = (url) => execFileAsync('xdg-open', [url], { timeout: 15000 }),
  baseUrl = CDP_BASE_URL
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Node.js fetch is required for Chrome DevTools Protocol.');
  }

  async function getTabs() {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/json`, {
        signal: AbortSignal.timeout(5000)
      });
    } catch (error) {
      throw new ChromeDebuggingUnavailableError(error);
    }
    if (!response.ok) {
      throw new Error(`Chrome DevTools returned HTTP ${response.status} while listing tabs.`);
    }
    const tabs = await response.json();
    if (!Array.isArray(tabs)) {
      throw new Error('Chrome DevTools returned an invalid tab list.');
    }
    return tabs;
  }

  async function openUrl(url) {
    try {
      await getTabs();
    } catch (error) {
      if (!(error instanceof ChromeDebuggingUnavailableError)) {
        throw error;
      }
      await launch(url);
      return 'Chrome চালু করে পেজটি খোলা হয়েছে।';
    }

    try {
      const response = await fetchImpl(
        `${baseUrl}/json/new?${encodeURIComponent(url)}`,
        { method: 'PUT', signal: AbortSignal.timeout(5000) }
      );
      if (!response.ok) {
        throw new Error(`Chrome DevTools could not open a new tab (HTTP ${response.status}).`);
      }
      await response.body?.cancel();
      return 'Chrome-এ নতুন ট্যাব খোলা হয়েছে।';
    } catch (cdpError) {
      console.error('Chrome CDP new-tab request failed:', cdpError.message);
      try {
        await openWithXdg(url);
        return 'Chrome CDP দিয়ে ট্যাব খোলা যায়নি; xdg-open দিয়ে URL খোলা হয়েছে।';
      } catch (xdgError) {
        throw new Error(`Could not open URL with Chrome CDP or xdg-open: ${xdgError.message}`, {
          cause: cdpError
        });
      }
    }
  }

  async function closeTab(tabName) {
    const name = typeof tabName === 'string' ? tabName.trim() : '';
    if (!name || name.length > 200) {
      throw new Error('A tab name of 1–200 characters is required.');
    }

    let tabs;
    try {
      tabs = await getTabs();
    } catch (error) {
      if (error instanceof ChromeDebuggingUnavailableError) {
        return 'Chrome-এ remote debugging চালু নেই। Chrome-কে `--remote-debugging-port=9222` দিয়ে চালু করুন, তারপর আবার চেষ্টা করুন।';
      }
      throw error;
    }

    const needle = name.toLocaleLowerCase();
    const matchingTabs = tabs.filter((tab) => {
      if (tab.type !== 'page' || typeof tab.id !== 'string') {
        return false;
      }
      return `${tab.title || ''}\n${tab.url || ''}`.toLocaleLowerCase().includes(needle);
    });

    if (matchingTabs.length === 0) {
      return `“${name}” মেলে এমন কোনো Chrome ট্যাব পাওয়া যায়নি।`;
    }

    let closed = 0;
    for (const tab of matchingTabs) {
      const response = await fetchImpl(
        `${baseUrl}/json/close/${encodeURIComponent(tab.id)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!response.ok) {
        throw new Error(`Chrome DevTools could not close a matching tab (HTTP ${response.status}).`);
      }
      await response.body?.cancel();
      closed += 1;
    }

    return `“${name}” মেলে এমন ${closed}টি Chrome ট্যাব বন্ধ করা হয়েছে।`;
  }

  return { closeTab, getTabs, openUrl };
}

module.exports = {
  CDP_BASE_URL,
  ChromeDebuggingUnavailableError,
  createChromeController,
  launchChrome
};
