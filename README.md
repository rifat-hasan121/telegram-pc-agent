# Telegram PC Agent

Control an Ubuntu desktop from one authorized Telegram account using text commands. OpenRouter interprets each request and can select only the allowlisted actions implemented by this app.

## Requirements

- Node.js 20 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An OpenRouter API key
- Google Chrome (`google-chrome`) for CDP tab management
- Chromium installed for visible browsing (install with the command below)
- Ubuntu desktop utilities: `xdg-open`, `loginctl` (provided by systemd), `gdbus`, and `amixer` (usually provided by `alsa-utils`)

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
- `UNLOCK_PASSCODE`: optional static remote-unlock passcode; leave empty to disable remote unlock
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
- “Lock the screen” calls the `lock_screen` tool, which runs `loginctl lock-sessions`.
- “পিসি বন্ধ করো” / “shutdown pc” and “পিসি রিস্টার্ট করো” / “restart pc” ask for explicit confirmation with Telegram buttons. The confirmation expires after 30 seconds; only confirming runs the corresponding fixed `systemctl poweroff` or `systemctl reboot` action after a 1.5-second delay.
- The `unlock_screen` AI tool is available to the authorized Telegram account and unlocks sessions with the existing GNOME idle-timer reset. This direct tool does not require `UNLOCK_PASSCODE`. The separate “unlock pc” / “পিসি আনলক করো” flow still uses the optional static `UNLOCK_PASSCODE` from `.env`: send the passcode as the next message within 60 seconds. Use a long, unique passphrase and never reuse your Ubuntu password. The bot intercepts that exchange before AI processing and attempts to delete the passcode, prompt, and trigger messages before checking; these messages are never sent to OpenRouter. Deletion is best-effort and does not prevent Telegram from processing a message or showing notifications. Static passcodes are less secure than TOTP if exposed; protect `.env`, your Telegram account, and the bot token. Leaving `UNLOCK_PASSCODE` empty disables only the passcode flow, not the AI tool.
- To permit the fixed unlock and power actions without a sudo password prompt, create a sudoers drop-in with `sudo visudo -f /etc/sudoers.d/telegram-pc-agent` and add `YOUR_LINUX_USER ALL=(root) NOPASSWD: /usr/bin/loginctl unlock-sessions, /usr/bin/loginctl unlock-session *, /usr/bin/systemctl poweroff, /usr/bin/systemctl reboot`. Replace `YOUR_LINUX_USER` with the account running the bot. This grants that account permission to unlock sessions, shut down, and restart through the bot. If a passcode-flow unlock request cannot be deleted from Telegram, it is rejected.
- “Mute/unmute volume” runs `amixer set Master toggle`.
- “Set volume to [0–100]%” or “increase/decrease volume by [0–100]%” uses fixed `pactl` arguments and replies with the resulting level in Bengali. Relative changes are clamped to 0–100%.
- Ask which applications are running for a Bengali summary of the top active processes, or request system stats for CPU, RAM, battery, and disk. These use fixed, read-only `run_bash` diagnostic actions and return command output to the AI for summarization.
- “স্ক্রিনশট দাও” or “take a screenshot” captures the desktop and sends it to the current authorized Telegram chat; the temporary image is removed afterward.
- “আমার [file] ফাইলটা পাঠাও” or “send file [path]” sends an existing file from the home directory (relative paths are resolved from the home directory) to the current Telegram chat.
- “Close the browser” closes the Chrome, Chromium, and Firefox processes directly.
- “Go to [URL] and [goal]” opens a visible Playwright browser and uses up to eight OpenRouter-guided steps to browse the configured domains.

Messages from any Telegram user other than `ALLOWED_USER_ID` are ignored. PC actions use fixed allowlisted commands; `run_bash` accepts only its predefined read-only diagnostics and does not execute arbitrary command strings. Site URLs are validated before they are passed to Chrome.

Chrome tab management uses the local DevTools endpoint at `http://localhost:9222`. If it is not running, opening a URL launches Chrome with a dedicated `~/.chrome-bot-profile` profile and remote debugging enabled. If CDP responds but cannot create a tab, the app logs the CDP error and falls back to `xdg-open`. To manage tabs in an existing Chrome profile, start Chrome with `--remote-debugging-port=9222`; newer Chrome versions may require remote debugging to use a non-default user-data directory.

YouTube lookup uses `yt-search`. The model is instructed to understand Bengali and English, tolerate common phonetic typos, and use recent per-chat conversation context for follow-up requests. It plays requested media without unnecessary clarification and answers general questions or list requests directly in Bengali without invoking a tool.

Website browsing launches Chromium visibly (`headless: false`) and leaves it open when the task finishes. The agent can inspect page text, follow allowlisted links, scroll, use public GET search forms, and play videos. It cannot submit other forms or click arbitrary buttons. Browser navigation is restricted to the configured hostnames, including redirects; page content is treated as untrusted and cannot override the user's goal.

Install the browser binary if needed:

```bash
npx playwright install chromium
```

Run the tests with `npm test`.


# 🤖 Telegram PC Agent

উবুন্টু পিসিকে (Wayland) টেলিগ্রাম বটের মাধ্যমে রিমোটলি কন্ট্রোল করার জন্য একটি Node.js অটোমেশন এজেন্ট।

## ✨ প্রধান ফিচারসমূহ
* **🎬 YouTube কন্ট্রোল:** ভিডিও প্লে/পজ, ফরোয়ার্ড/রিওয়াইন্ড, থিয়েটার মোড, ফুলস্ক্রিন অন/অফ এবং লাইক/আনলাইক।
* **🔒 স্ক্রিন লক ও আনলক:** লক টুলের পাশাপাশি AI-নির্বাচিত আনলক টুল এবং ঐচ্ছিক `UNLOCK_PASSCODE`-ভিত্তিক আলাদা আনলক ফ্লো।
* **⚡ পাওয়ার ম্যানেজমেন্ট:** ৩০ সেকেন্ডের কনফার্মেশন বাটনসহ পিসি শাটডাউন ও রিস্টার্ট।
* **🔄 অটো-স্টার্ট:** `systemd` ইউজার সার্ভিসের মাধ্যমে পিসি অন হওয়ার সাথে সাথেই ব্যাকগ্রাউন্ডে চালু থাকা।

---

## ⚙️ সেটআপ ও পারমিশন

### ১. এনভায়রনমেন্ট ভেরিয়েবল (`.env`)
প্রজেক্টের রুটে `.env` ফাইলে আপনার টোকেন ও রিমোট আনলক পাসকোড সেট করুন:
```env
UNLOCK_PASSCODE=your_passcode_here
```

### ২. `sudoers` পারমিশন (পাসওয়ার্ড ছাড়া কমান্ড চালানোর জন্য)
টার্মিনালে নিচের কমান্ডগুলো চালিয়ে রিমোট আনলক এবং পাওয়ার কন্ট্রোলের পারমিশন দিন:
```bash
echo "$USER ALL=(ALL) NOPASSWD: /usr/bin/loginctl unlock-sessions" | sudo tee /etc/sudoers.d/telegram-unlock
echo "$USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl poweroff, /usr/bin/systemctl reboot" | sudo tee /etc/sudoers.d/telegram-power
```

---

## 🛠️ Telegram Bot Service Management (`systemd`)

পিসির ব্যাকগ্রাউন্ডে চলা টেলিগ্রাম বটটি কন্ট্রোল করার জন্য নিচের কমান্ডগুলো ব্যবহার করুন:

### 📊 ১. বটের স্ট্যাটাস চেক করা
বটটি বর্তমানে `active (running)` অবস্থায় আছে কি না তা দেখতে:
```bash
systemctl --user status telegram-bot.service
```

### 📜 ২. লাইভ লগ দেখা (Troubleshooting)
কোনো এরর হচ্ছে কি না বা বটের লাইভ অ্যাক্টিভিটি দেখতে:
```bash
journalctl --user -u telegram-bot.service -f
```
*(লগ দেখা থেকে বের হতে `Ctrl + C` চাপুন)*

### 🔄 ৩. বট রিস্টার্ট করা
কোডে কোনো পরিবর্তন করার পর নতুন কোড লোড করতে:
```bash
systemctl --user restart telegram-bot.service
```

### 🛑 ৪. বট সাময়িকভাবে বন্ধ বা চালু করা
* **বন্ধ করতে:**
  ```bash
  systemctl --user stop telegram-bot.service
  ```
* **চালু করতে:**
  ```bash
  systemctl --user start telegram-bot.service
  ```