const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright-core');

const POC_ROOT = path.resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: POC_ROOT,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });
  const started = Date.now();
  while (!/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/.test(output)) {
    if (Date.now() - started > 15000) throw new Error('Server did not start in time');
    await wait(100);
  }
  return { child, url: output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/)[0], logs: () => output };
}

async function readTerminal(page) {
  return page.evaluate(() => {
    const terminal = window.__devpilotTerm;
    if (!terminal) return '';
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  });
}

(async () => {
  const server = await startServer();
  let browser = null;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => document.getElementById('health-text')?.textContent.includes('backend ok'), null, { timeout: 15000 });
    console.log('PASS browser loaded the workspace and reached the backend health endpoint');

    const antigravityDisabled = await page.evaluate(() => {
      const option = [...document.querySelectorAll('#tool option')].find((item) => item.value === 'antigravity');
      return option ? option.disabled && option.textContent.includes('unverified') : false;
    });
    assert(antigravityDisabled, 'Antigravity should be listed as unverified and disabled');
    console.log('PASS Antigravity is listed but disabled as unverified');

    await page.selectOption('#tool', 'claude');
    await page.click('#start');

    await page.waitForFunction(() => {
      const terminal = window.__devpilotTerm;
      if (!terminal) return false;
      const buffer = terminal.buffer.active;
      for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        if (line && /trust this folder|accept edits|Try "/.test(line.translateToString(true))) return true;
      }
      return false;
    }, null, { timeout: 20000 });
    console.log('PASS browser terminal received real Claude Code output over the WebSocket');

    let text = await readTerminal(page);
    if (/trust this folder/i.test(text)) {
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await wait(1500);
    }

    await page.waitForFunction(() => {
      const terminal = window.__devpilotTerm;
      if (!terminal) return false;
      const buffer = terminal.buffer.active;
      for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        if (line && /accept edits|Try "/.test(line.translateToString(true))) return true;
      }
      return false;
    }, null, { timeout: 20000 });

    await page.keyboard.type('/status');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const terminal = window.__devpilotTerm;
      if (!terminal) return false;
      const buffer = terminal.buffer.active;
      let text = '';
      for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        if (line) text += `${line.translateToString(true)}\n`;
      }
      return /Version:/.test(text) && /Session ID:/.test(text);
    }, null, { timeout: 20000 });
    console.log('PASS keyboard input from xterm.js reached Claude Code and the /status panel rendered');

    const before = await page.evaluate(() => ({ cols: window.__devpilotTerm.cols, rows: window.__devpilotTerm.rows }));
    await page.setViewportSize({ width: 1000, height: 680 });
    await wait(800);
    const after = await page.evaluate(() => ({ cols: window.__devpilotTerm.cols, rows: window.__devpilotTerm.rows }));
    assert(after.cols !== before.cols || after.rows !== before.rows, 'Terminal did not resize with the browser viewport');
    console.log(`PASS browser resize changed the terminal grid (${before.cols}x${before.rows} -> ${after.cols}x${after.rows})`);

    await page.keyboard.press('Escape');
    await wait(400);
    await page.keyboard.type('/exit');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'exited', null, { timeout: 20000 });
    const exitDetail = await page.textContent('#pid');
    assert(/exit code 0/.test(exitDetail), `Unexpected exit detail: ${exitDetail}`);
    console.log('PASS browser session showed Claude Code exiting cleanly with code 0');

    assert(errors.length === 0, `Page errors: ${errors.join('; ')}`);
    console.log('\nAll P0 browser checks passed.');
  } catch (error) {
    console.error(`\nFAIL: ${error.message}`);
    const logs = server.logs().trim();
    if (logs) console.error(`Server log tail:\n${logs.slice(-1500)}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.child.kill();
  }
})();
