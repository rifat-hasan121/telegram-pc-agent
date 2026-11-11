const { chromium } = require('playwright');

const CDP_URL = 'http://localhost:9222';
const SIGN_IN_MESSAGE = 'YouTube-এ Like বা comment করার জন্য bot-এর Chrome profile-এ আগে YouTube-এ লগ ইন করুন।';

function createYoutubeController({ browserType = chromium } = {}) {
  async function youtubeAction(action, text) {
    const supportedActions = [
      'fullscreen',
      'fullscreen_on',
      'fullscreen_off',
      'play_pause',
      'next',
      'mute',
      'skip_ad',
      'like',
      'unlike',
      'comment'
    ];
    if (!supportedActions.includes(action)) {
      throw new Error('Unsupported YouTube action.');
    }

    if (action === 'comment' && (typeof text !== 'string' || !text.trim() || text.length > 1000)) {
      throw new Error('YouTube comment must contain 1–1000 characters.');
    }

    const browser = await browserType.connectOverCDP(CDP_URL);
    try {
      const pages = browser.contexts().flatMap((context) => context.pages());
      let page;
      for (const candidate of pages) {
        if ((await candidate.url()).includes('youtube.com/watch')) {
          page = candidate;
          break;
        }
      }

      if (!page) {
        return 'চালু থাকা YouTube watch tab পাওয়া যায়নি। আগে Chrome-এ একটি YouTube ভিডিও খুলুন।';
      }

      if (action === 'fullscreen' || action === 'fullscreen_on') {
        const isFs = await page.evaluate(() => !!document.fullscreenElement);
        if (!isFs) {
          await page.hover('#movie_player');
          await page.click('.ytp-fullscreen-button');
        }
        return 'YouTube ভিডিওটি fullscreen করা হয়েছে।';
      }

      if (action === 'fullscreen_off') {
        const isFs = await page.evaluate(() => !!document.fullscreenElement);
        if (isFs) {
          try {
            await page.evaluate(() => document.exitFullscreen());
          } catch (error) {
            console.error('YouTube fullscreen exit failed:', error.message);
          }
          const stillFullscreen = await page.evaluate(() => !!document.fullscreenElement);
          if (stillFullscreen) {
            await page.keyboard.press('Escape');
            await page.hover('#movie_player');
            await page.click('.ytp-fullscreen-button');
          }
        }
        return 'YouTube ভিডিওর fullscreen বন্ধ করা হয়েছে।';
      }

      if (action === 'play_pause') {
        await page.keyboard.press('k');
        return 'YouTube ভিডিওর play/pause অবস্থা বদলানো হয়েছে।';
      }

      if (action === 'next') {
        await page.keyboard.press('Shift+N');
        return 'YouTube-এর পরের ভিডিও চালানো হচ্ছে।';
      }

      if (action === 'mute') {
        await page.keyboard.press('m');
        return 'YouTube ভিডিওর mute অবস্থা বদলানো হয়েছে।';
      }

      if (action === 'skip_ad') {
        const skipButton = page.locator('.ytp-skip-ad-button, .ytp-ad-skip-button');
        if (!(await skipButton.first().isVisible().catch(() => false))) {
          return 'এ মুহূর্তে দৃশ্যমান কোনো skip ad button নেই।';
        }
        await skipButton.first().click();
        return 'YouTube বিজ্ঞাপনটি skip করা হয়েছে।';
      }

      if (action === 'like' || action === 'unlike') {
        const avatar = page.locator('#avatar-btn');
        if (!(await avatar.isVisible().catch(() => false))) {
          return SIGN_IN_MESSAGE;
        }
        const likeButton = page.locator(
          '#above-the-fold like-button-view-model button, ytd-watch-metadata like-button-view-model button'
        ).first();
        if (!(await likeButton.isVisible())) {
          return 'YouTube Like buttonটি খুঁজে পাওয়া যায়নি।';
        }
        const isLiked = await likeButton.getAttribute('aria-pressed') === 'true';
        if (action === 'like' && isLiked) {
          return 'ভিডিওটিতে আগে থেকেই Like দেওয়া আছে।';
        }
        if (action === 'unlike' && !isLiked) {
          return 'ভিডিওটিতে এখনো Like দেওয়া হয়নি।';
        }
        try {
          await likeButton.click();
        } catch (error) {
          console.error(`YouTube ${action === 'like' ? 'Like' : 'Unlike'} click failed:`, error.message);
          throw error;
        }
        const signInPopup = page.locator(
          'ytd-modal-with-title-and-button-renderer, tp-yt-paper-dialog'
        ).first();
        if (await signInPopup.isVisible().catch(() => false)) {
          return SIGN_IN_MESSAGE;
        }
        return action === 'like'
          ? 'YouTube ভিডিওতে Like দেওয়া হয়েছে।'
          : 'YouTube ভিডিও থেকে Like সরানো হয়েছে।';
      }

      const avatar = page.locator('#avatar-btn');
      if (await avatar.count() === 0) {
        return SIGN_IN_MESSAGE;
      }

      await page.locator('#comments').scrollIntoViewIfNeeded();
      const commentPlaceholder = page.locator('#simplebox-placeholder');
      await commentPlaceholder.waitFor({ state: 'visible', timeout: 10000 });
      await commentPlaceholder.click();
      const commentEditor = page.locator('#contenteditable-root');
      await commentEditor.waitFor({ state: 'visible', timeout: 10000 });
      await commentEditor.click();
      await page.keyboard.type(text.trim());
      const submitButton = page.locator('#submit-button, #submit-button button').first();
      await submitButton.waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForFunction(() => {
        const button = document.querySelector('#submit-button button')
          || document.querySelector('#submit-button');
        return button
          && !button.disabled
          && button.getAttribute('aria-disabled') !== 'true';
      }, null, { timeout: 10000 });
      await submitButton.click();
      return 'YouTube-এ comment পোস্ট করা হয়েছে।';
    } finally {
      await browser.close();
    }
  }

  return { youtubeAction };
}

module.exports = { createYoutubeController };
