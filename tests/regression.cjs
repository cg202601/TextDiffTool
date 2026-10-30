const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const timeout = setTimeout(() => { console.error('Test timed out'); browser.close(); }, 45000);
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../TextDiffTool_v5.2.html')).href);
    const formats = [
      ['.txt', '[00:00:00:00 --> 00:00:20:00] 第一句。\n[00:00:20:00 --> 00:00:30:00] 第二句。'],
      ['.srt', '1\r\n00:00:00,000 --> 00:00:20,000\r\n第一句。\r\n\r\n2\r\n00:00:20,000 --> 00:00:30,000\r\n第二句。'],
      ['.vtt', 'WEBVTT\n\n00:00:00.000 --> 00:00:20.000\n第一句。\n\n00:00:20.000 --> 00:00:30.000\n第二句。'],
      ['.lrc', '[00:00.00]第一句。\n[00:20.00]第二句。'],
      ['.ass', 'Dialogue: 0,0:00:00.00,0:00:20.00,Default,,0,0,0,,第一句。\nDialogue: 0,0:00:20.00,0:00:30.00,Default,,0,0,0,,第二句。']
    ];
    for (const [ext, raw] of formats) {
      console.log('Checking', ext);
      const result = await page.evaluate(({ raw }) => {
        document.getElementById('text-left').value = '第一句。\n第二句。';
        document.getElementById('text-right').value = raw;
        document.getElementById('opt-digits').checked = false;
        document.getElementById('opt-punct').checked = false;
        document.getElementById('opt-custom').value = '';
        document.getElementById('opt-diff-only').checked = false;
        onTextInput(); runCompare(); runCompare();
        return { raw: document.getElementById('text-right').value,
          accuracy: lastStats.accuracy, rows: document.querySelectorAll('#diff-tbody tr').length,
          timed: document.querySelectorAll('#diff-tbody tr[data-cue-start]').length,
          history: getHistory()[0].right };
      }, { raw });
      assert.equal(result.raw, raw.replace(/\r\n/g, '\n'), ext + ': input preserved');
      assert.equal(result.history, result.raw, ext + ': history preserved');
      assert.equal(result.accuracy, 100, ext + ': timecodes ignored with all filters off');
      assert.equal(result.rows, 2);
      assert.equal(result.timed, 2);
      await page.evaluate(({ raw, ext }) => loadFile(new File([raw], 'sample' + ext), 'text-right'), { raw, ext });
      await page.waitForFunction(() => document.getElementById('file-info-right').textContent.includes('sample'));
      assert.equal(await page.locator('#text-right').inputValue(), raw.replace(/\r\n/g, '\n'));
      assert.equal(await page.evaluate(() => { runCompare(); return lastStats.accuracy; }), 100);
    }
    // Replacing subtitles with plain text must discard old timing information.
    assert.equal(await page.evaluate(() => {
      document.getElementById('text-right').value = '第一句。\n第二句。';
      runCompare(); return getCueRanges('right').length;
    }), 0);
    assert.equal(await page.evaluate(raw => {
      document.getElementById('text-left').value = raw;
      document.getElementById('text-right').value = raw;
      runCompare();
      return lastStats.accuracy === 100 && document.querySelectorAll('#diff-tbody tr').length === 2 &&
        document.getElementById('text-left').value === raw;
    }, formats[0][1]), true);

    // Export the actual download and reopen it as a standalone report.
    console.log('Checking standalone report');
    const source = '\n  原稿 <标签> & </textarea><script>window.injected=true</script>\n';
    const timedSource = '\n[00:00:00:00 --> 00:00:30:00] 实际稿件。\n';
    await page.evaluate(({ source, timedSource }) => {
      document.getElementById('text-left').value = source;
      document.getElementById('text-right').value = timedSource;
      runCompare();
    }, { source, timedSource });
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(() => exportHtmlReport());
    const download = await downloadPromise;
    const report = await browser.newPage();
    await report.setContent(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(await report.locator('#report-left').inputValue(), source);
    assert.equal(await report.locator('#report-right').inputValue(), timedSource);
    assert.equal(await report.evaluate(() => window.injected), undefined);
    // Both buttons copy complete source text, including whitespace and timecodes.
    await report.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async value => { window.copiedSource = value; } } });
    });
    for (const [id, expected] of [['report-left', source], ['report-right', timedSource]]) {
      const button = report.locator('[data-copy-source="' + id + '"]');
      await button.click();
      assert.equal(await report.evaluate(() => window.copiedSource), expected);
      assert.equal(await button.textContent(), '✓ 已复制');
    }
    // Clipboard access can be unavailable or denied in a locally opened report.
    for (const denied of [false, true]) {
      await report.evaluate(denied => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
          value: denied ? { writeText: () => Promise.reject(new Error('Denied')) } : undefined });
        document.execCommand = command => {
          if (command !== 'copy') return false;
          const el = document.activeElement;
          window.copiedSource = el.value.slice(el.selectionStart, el.selectionEnd);
          return true;
        };
      }, denied);
      await report.locator('[data-copy-source="report-right"]').click();
      assert.equal(await report.evaluate(() => window.copiedSource), timedSource);
      assert.equal(await report.locator('[data-copy-source="report-right"]').textContent(), '✓ 已复制');
    }
    await report.locator('#report-right').focus();
    await report.keyboard.press('Control+a');
    assert.equal(await report.locator('#report-right').evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), timedSource);
    await report.setViewportSize({ width: 390, height: 844 });
    assert.equal(await report.evaluate(() => document.querySelector('.sources').scrollWidth > document.querySelector('.sources').clientWidth), false);

    // Actual media pause and seek: copying must use the player clock, even in a long cue.
    console.log('Checking actual media playback');
    const result = await page.evaluate(async () => {
      const sampleRate = 8000, samples = sampleRate * 32;
      const buffer = new ArrayBuffer(44 + samples * 2), view = new DataView(buffer);
      function str(offset, value) { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); }
      str(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, samples * 2, true);
      loadMediaFile(new File([buffer], 'silence.wav', { type: 'audio/wav' }));
      await new Promise(resolve => mediaState.element.addEventListener('loadedmetadata', resolve, { once: true }));
      document.getElementById('opt-diff-loop').checked = false;
      document.getElementById('opt-auto-scroll').checked = false;
      mediaState.element.currentTime = 12.5;
      await new Promise(resolve => mediaState.element.addEventListener('seeked', resolve, { once: true }));
      await mediaState.element.play();
      mediaState.element.pause();
      let copied;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
      copyCurrentPlaybackTimecode();
      const expected = formatFrameTimecode(mediaState.element.currentTime, 25);
      return { copied, expected, label: document.getElementById('fmb-cur-tc').textContent,
        start: mediaState.currentPlayingRow?.getAttribute('data-cue-start') };
    });
    assert.equal(result.start, '0');
    assert.equal(result.copied, result.expected);
    assert.equal(result.label, result.expected);
    assert.ok(result.copied.startsWith('00:00:12:'));
    await page.evaluate(async () => {
      mediaState.element.currentTime = 18.5;
      await new Promise(resolve => mediaState.element.addEventListener('seeked', resolve, { once: true }));
      navigator.clipboard.writeText = async value => { window.lastCopiedTimecode = value; };
      document.activeElement.blur();
    });
    await page.keyboard.press('c');
    assert.equal(await page.evaluate(() => window.lastCopiedTimecode), '00:00:18:12');
    assert.equal(await page.locator('#fmb-cur-tc').textContent(), '00:00:18:12');
    assert.deepEqual(errors, []);
    assert.match(fs.readFileSync(path.resolve(__dirname, '../TextDiffTool_v5.2.html'), 'utf8'), /<title>[^<]*v5\.2/);
    assert.equal(await page.locator('.review-desk').count(), 0);
    console.log('PASS: subtitle paste/import/history, standalone report selection/escaping/mobile layout, real media pause/seek/copy, v5.2 version metadata and standalone basic edition.');
  } finally { clearTimeout(timeout); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
