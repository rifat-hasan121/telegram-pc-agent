# Telegram PC Agent

Control an Ubuntu desktop from one authorized Telegram account using text commands. OpenRouter interprets each request and can select only the allowlisted actions implemented by this app.

## Requirements

- Node.js 20 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An OpenRouter API key
- Google Chrome (`google-chrome`) for CDP tab management
- Chromium installed for visible browsing (install with the command below)
- Ubuntu desktop utilities: `xdg-open`, `xdg-screensaver`, and `amixer` (usually provided by `alsa-utils`)

## Setup

```bash
cd telegram-pc-agent
npm install
cp .env.example .env
```

Set these values in `.env`:

- `TELEGRAM_BOT_TOKEN`: your Telegram bot token
- `ALLOWED_USER_ID`: your numeric Telegram user ID
- `OPENROUTER_API_KEY`: your OpenRouter API key
- `BROWSER_ALLOWED_DOMAINS`: comma-separated allowed hostnames; defaults to `youtube.com,xhamster.com,pornhub.com`. Use exact domains, not `*`.

Keep `.env` private; it is excluded from Git. Start the bot with:

```bash
npm start
```

The bot uses Telegram polling and must remain running to receive commands.
Transient OpenRouter and Telegram connection failures are retried up to three times with a short backoff. If they persist, check that the machine running the bot can reach both `api.telegram.org` and `openrouter.ai`, and inspect the terminal error; retries cannot bypass a firewall, proxy, DNS issue, or invalid credentials.

## Supported actions

- “Play [query] on YouTube” searches YouTube and opens the first video result in Chrome, replying with its title.
- “Like this video”, “skip the ad”, “pause/play”, “fullscreen”, “next video”, or “comment [text]” uses `youtube_action` on the currently open YouTube watch tab. You must be signed into YouTube in the bot’s Chrome profile for likes and comments.
- “Open [URL]” opens an HTTP or HTTPS URL in a new Chrome tab.
- “Close the [site] tab” (for example YouTube or Facebook) closes matching Chrome tabs by title or URL and confirms the count in Bengali.
- “Lock the screen” runs `xdg-screensaver lock`.
- “Mute/unmute volume” runs `amixer set Master toggle`.
- “Set volume to [0–100]%” or “increase/decrease volume by [0–100]%” uses fixed `pactl` arguments and replies with the resulting level in Bengali. Relative changes are clamped to 0–100%.
- Ask which applications are running for a Bengali summary of the top active processes, or request system stats for CPU, RAM, battery, and disk. These use fixed, read-only `run_bash` diagnostic actions and return command output to the AI for summarization.
- “স্ক্রিনশট দাও” or “take a screenshot” captures the desktop and sends it to the current authorized Telegram chat; the temporary image is removed afterward.
- “আমার [file] ফাইলটা পাঠাও” or “send file [path]” sends an existing file from the home directory (relative paths are resolved from the home directory) to the current Telegram chat.
- “Close the browser” closes the Chrome, Chromium, and Firefox processes directly.
- “Go to [URL] and [goal]” opens a visible Playwright browser and uses up to eight OpenRouter-guided steps to browse the configured domains.

Messages from any Telegram user other than `ALLOWED_USER_ID` are ignored. PC actions use fixed allowlisted commands; `run_bash` accepts only its predefined read-only diagnostics and does not execute arbitrary command strings. Site URLs are validated before they are passed to Chrome.

Chrome tab management uses the local DevTools endpoint at `http://localhost:9222`. If it is not running, opening a URL launches Chrome with a dedicated `~/.chrome-bot-profile` profile and remote debugging enabled. If CDP responds but cannot create a tab, the app logs the CDP error and falls back to `xdg-open`. To manage tabs in an existing Chrome profile, start Chrome with `--remote-debugging-port=9222`; newer Chrome versions may require remote debugging to use a non-default user-data directory.

YouTube lookup uses `yt-search`. The model is instructed to understand Bengali and English, play requested media without clarification, and answer general questions or list requests directly in Bengali without invoking a tool.

Website browsing launches Chromium visibly (`headless: false`) and leaves it open when the task finishes. The agent can inspect page text, follow allowlisted links, scroll, use public GET search forms, and play videos. It cannot submit other forms or click arbitrary buttons. Browser navigation is restricted to the configured hostnames, including redirects; page content is treated as untrusted and cannot override the user's goal.

Install the browser binary if needed:

```bash
npx playwright install chromium
```

Run the tests with `npm test`.
