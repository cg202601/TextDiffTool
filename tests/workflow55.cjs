const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function silentWav() {
  const rate = 8000, size = rate * 40 * 2, b = Buffer.alloc(44 + size);
  b.write('RIFF'); b.writeUInt32LE(36 + size, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(size, 40); return b;
}

(async () => {
  const legacy = fs.readFileSync(path.resolve(__dirname, '../TextDiffTool_v5.1.html'));
  const browser = await chromium.launch({ headless: true });
  const timeout = setTimeout(() => browser.close(), 90000);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../TextDiffTool_v5.5.html')).href);
    assert.equal(await page.locator('#speed-source').inputValue(), 'left');
    assert.equal(await page.locator('#opt-custom').inputValue(), '啊,呀,呢,吧,嗯,哎,呃,哦');
    assert.equal(await page.evaluate(() => workflowReady), true);
    assert.equal(await page.locator('#review-details').isVisible(), false, 'workbench starts compact');
    assert.equal(await page.locator('#review-toggle').getAttribute('aria-expanded'), 'false');
    console.log('Checking per-row states, filtering, and unchanged accuracy');
    await page.evaluate(() => {
      document.getElementById('text-left').value = '第一句。\n第二句。\n第三句。';
      document.getElementById('text-right').value = '[00:00:00:00 --> 00:00:20:00] 第一句错。\n[00:00:20:00 --> 00:00:30:00] 第二句错。\n[00:00:30:00 --> 00:00:40:00] 第三句。';
      document.getElementById('opt-custom').value = '';
      document.getElementById('opt-digits').checked = false;
      document.getElementById('opt-punct').checked = false;
      onTextInput(); runCompare();
    });
    assert.equal(await page.locator('#diff-tbody tr:visible').count(), 2);
    assert.equal(await page.evaluate(() => reviewRecords.size), 2);
    const accuracy = await page.evaluate(() => lastStats.accuracy);
    await page.locator('#diff-tbody tr').nth(1).locator('.review-row select').selectOption('confirmed');
    assert.equal(await page.evaluate(() => lastStats.accuracy), accuracy);
    await page.locator('#review-filter').selectOption('open');
    assert.equal(await page.locator('#diff-tbody tr:visible').count(), 1);
    assert.equal(await page.locator('#diff-nav-total').textContent(), '1');
    await page.locator('#review-filter').selectOption('all');
    await page.locator('#opt-diff-only').uncheck();
    await page.locator('#diff-tbody tr').nth(2).locator('.review-row button').click();
    await page.locator('#note-dialog').getByRole('button', { name: '取消' }).click();
    assert.equal(await page.evaluate(() => reviewRecords.size), 2, 'canceling a note must not create a task');
    await page.locator('#opt-diff-only').check();
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('m');
    assert.equal(await page.locator('#note-dialog').evaluate(el => el.open), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#note-dialog').evaluate(el => el.open), false);

    console.log('Checking precise media annotation, edit, autosave, and resume');
    const audio = { name: '校对音频.wav', mimeType: 'audio/wav', buffer: silentWav() };
    await page.locator('#media-file-input').setInputFiles(audio);
    await page.waitForFunction(() => hasLoadedMedia());
    await page.evaluate(() => {
      document.getElementById('opt-auto-scroll').checked = false;
      document.getElementById('opt-diff-loop').checked = false;
      mediaState.element.currentTime = 12.5;
    });
    await page.waitForFunction(() => mediaState.currentPlayingRow?.cells[0].textContent === '1');
    await page.getByRole('button', { name: '＋ 标记当前问题', exact: true }).click();
    assert.equal(await page.locator('#note-time').textContent(), '00:00:12:12');
    const note = '这里人名读错了，请补录。<img src=x onerror="window.injected=true">';
    await page.locator('#note-text').fill(note);
    await page.locator('#note-status').selectOption('fix');
    await page.getByRole('button', { name: '保存备注', exact: true }).click();
    assert.equal(await page.locator('#review-list .review-note p').textContent(), note);
    assert.equal(await page.locator('#diff-tbody tr').first().locator('.review-row select').inputValue(), 'fix');
    await page.locator('#project-name').fill('广告口播校对');
    await page.locator('#review-toggle').click();
    assert.equal(await page.locator('#review-details').isVisible(), true);
    await page.waitForFunction(() => {
      const saved = JSON.parse(localStorage.getItem(PROJECT_KEY));
      return saved?.name === '广告口播校对' && saved.options['review-expanded'] && saved.records.some(record => record.notes.length);
    });
    await page.reload();
    assert.equal(await page.locator('#project-name').inputValue(), '广告口播校对');
    assert.equal(await page.locator('#review-details').isVisible(), true, 'expanded preference is restored');
    assert.equal(await page.locator('#review-list .review-note p').textContent(), note);
    assert.equal(await page.locator('#project-media-hint').isVisible(), true);
    await page.locator('#media-file-input').setInputFiles(audio);
    await page.waitForFunction(() => hasLoadedMedia() && Math.abs(mediaState.element.currentTime - 12.5) < .1);
    assert.equal(await page.evaluate(() => mediaState.element.paused), true);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.locator('#review-list').getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('#note-text').fill(note + ' 请慢一点。');
    await page.getByRole('button', { name: '保存备注', exact: true }).click();
    assert.equal(await page.locator('#review-list .review-note p').textContent(), note + ' 请慢一点。');
    // The last selected difference can also be resumed without audio attached.
    await page.evaluate(() => { syncDiffNavigationToRow(document.querySelectorAll('#diff-tbody tr')[1]); saveProjectLocally(); });

    console.log('Checking project download/import validation and reports');
    const projectDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '💾 另存项目', exact: true }).click();
    const projectFile = await projectDownload;
    const projectJson = fs.readFileSync(await projectFile.path(), 'utf8');
    const projectData = JSON.parse(projectJson);
    assert.equal(projectData.media.position, 12.5);
    assert.ok(projectData.selectedReviewKey);
    assert.ok(projectData.records.some(record => record.status === 'confirmed'));
    const invalid = { ...projectData, records: [{ status: '__proto__' }] };
    await page.locator('#project-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
    assert.equal(await page.locator('#project-name').inputValue(), '广告口播校对');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#project-file').setInputFiles({ name: 'project.textdiff.json', mimeType: 'application/json', buffer: Buffer.from(projectJson) });
    await page.waitForFunction(() => document.getElementById('project-save-status').textContent.includes('自动保存'));
    assert.equal(await page.locator('#review-list .review-note p').textContent(), note + ' 请慢一点。');
    assert.equal(await page.locator('#diff-tbody .active-diff-row .line-num').textContent(), '2');
    await page.locator('#review-filter').selectOption('fix');
    const reportDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '📄 导出报告', exact: true }).click();
    const reportFile = await reportDownload;
    const report = await browser.newPage();
    await report.setContent(fs.readFileSync(await reportFile.path(), 'utf8'));
    assert.equal((await report.locator('body').textContent()).includes(note), false);
    assert.equal((await report.locator('body').textContent()).includes('校对问题与处理进度'), false);
    assert.equal((await report.locator('body').textContent()).includes('需要修改'), false);
    assert.equal(await report.locator('.diff-table tbody tr').count(), 2, 'standard report ignores review status filter');
    assert.equal(await report.locator('#report-left').inputValue(), projectData.left);
    assert.equal(await report.locator('#report-right').inputValue(), projectData.right);
    assert.equal(await report.locator('.review-row').count(), 0);
    assert.equal(await report.evaluate(() => window.injected), undefined);
    assert.equal(await report.locator('.source-copy').count(), 2);
    const issuesDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '📄 导出问题清单', exact: true }).click();
    const issueHtml = fs.readFileSync(await (await issuesDownload).path(), 'utf8');
    assert.ok(issueHtml.includes('00:00:12:12'));
    const issues = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await issues.setContent(issueHtml);
    assert.equal(await issues.locator('.issue-card').count(), 1, 'only the marked problem is exported');
    assert.equal(await issues.locator('.issue-confirmed,.issue-resolved').count(), 0);
    assert.ok((await issues.locator('.issue-summary').first().textContent()).includes('共 1 项需跟进'));
    assert.equal(await issues.locator('.issue-index a').count(), 1);
    assert.equal(await issues.locator('.issue-fix .issue-actual').textContent(), '错');
    assert.equal(await issues.locator('.issue-confirmed mark').count(), 0);
    assert.equal(await issues.evaluate(() => window.injected), undefined);
    console.log('Checking actionable export selection with 100 unreviewed differences');
    const filtered = await page.evaluate(() => {
      const originalRecords = reviewRecords;
      const originalDownload = downloadProjectBlob;
      try {
        reviewRecords = new Map();
        for (let i = 0; i < 100; i++) reviewRecords.set('auto-' + i,
          { key: 'auto-' + i, status: 'pending', active: true, notes: [], source: '正常句', result: '不同句', line: String(i + 1), cueStart: i });
        let downloads = 0;
        downloadProjectBlob = () => downloads++;
        exportReviewList();
        const emptyCount = downloads;
        const add = (key, status, notes) => reviewRecords.set(key,
          { key, status, notes, source: '甲乙', result: '甲丙', line: key, cueStart: 1, active: true });
        const note = [{ id: 'note', time: 1, text: '请确认这里的读音' }];
        add('note', 'pending', note);
        add('fix', 'fix', []);
        add('confirmed', 'confirmed', note);
        add('resolved', 'resolved', note);
        return { keys: reviewExportRecords().map(record => record.key), html: buildReviewReportHtml(), emptyCount };
      } finally { reviewRecords = originalRecords; downloadProjectBlob = originalDownload; }
    });
    assert.deepEqual(filtered.keys, ['fix', 'note']);
    assert.equal(filtered.emptyCount, 0, 'no file is exported when there are only unreviewed automatic differences');
    const selection = await browser.newPage();
    await selection.setContent(filtered.html);
    assert.equal(await selection.locator('.issue-card').count(), 2);
    assert.equal(await selection.locator('.issue-group').count(), 2);
    assert.equal(await selection.locator('.issue-index a').count(), 2);
    assert.ok((await selection.locator('.issue-group').last().textContent()).includes('确认后再决定是否修改'));
    await selection.close();
    const noteCopy = issues.locator('.issue-fix .issue-copy');
    await issues.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async value => { window.copiedIssue = value; } } }));
    await noteCopy.click();
    const expectedCopy = '时间码：00:00:12:12\n备注：' + note + ' 请慢一点。';
    assert.equal(await issues.evaluate(() => window.copiedIssue), expectedCopy);
    assert.equal(await noteCopy.textContent(), '✓ 已复制时间和备注');
    for (const denied of [false, true]) {
      await issues.evaluate(denied => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
          value: denied ? { writeText: () => Promise.reject(new Error('Denied')) } : undefined });
        document.execCommand = command => {
          if (command !== 'copy') return false;
          const el = document.activeElement;
          window.copiedIssue = el.value.slice(el.selectionStart, el.selectionEnd); return true;
        };
      }, denied);
      await noteCopy.click();
      assert.equal(await issues.evaluate(() => window.copiedIssue), expectedCopy);
    }
    // Verify the real clipboard by pasting from a locally opened exported file.
    // This catches failures that mocked clipboard APIs cannot detect.
    const localIssuePath = path.join(os.tmpdir(), 'textdiff55-clipboard-check.html');
    fs.writeFileSync(localIssuePath, issueHtml);
    const realContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const realIssues = await realContext.newPage();
    await realIssues.goto(pathToFileURL(localIssuePath).href);
    await realIssues.evaluate(() => {
      const paste = document.createElement('textarea'); paste.id = 'paste-check'; document.body.appendChild(paste);
    });
    const realCopy = realIssues.locator('.issue-fix .issue-copy');
    for (const mode of ['native', 'unavailable', 'denied']) {
      const remark = '实际粘贴验证：' + mode + '，请补录人名。';
      await realIssues.evaluate(({ mode, remark }) => {
        document.querySelector('.issue-fix .issue-note-text').textContent = remark;
        if (mode === 'unavailable') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        if (mode === 'denied') Object.defineProperty(navigator, 'clipboard', { configurable: true,
          value: { writeText: () => Promise.reject(new Error('Denied')) } });
      }, { mode, remark });
      await realCopy.click();
      await realIssues.waitForFunction(() => document.querySelector('.issue-fix .issue-copy').textContent === '✓ 已复制时间和备注');
      await realIssues.locator('#paste-check').fill('');
      await realIssues.locator('#paste-check').focus();
      await realIssues.keyboard.press('Control+v');
      assert.equal(await realIssues.locator('#paste-check').inputValue(), '时间码：00:00:12:12\n备注：' + remark,
        'real clipboard paste: ' + mode);
    }
    await realContext.close();
    // Missing words and substitutions highlight the expected source as well.
    const marks = await page.evaluate(() => {
      const el = document.createElement('div');
      el.innerHTML = buildReviewDifferenceHtml({ line: '1', source: '甲乙丙', result: '甲丁', status: 'fix' });
      return { expected: Array.from(el.querySelectorAll('.issue-expected')).map(x => x.textContent).join(''),
        actual: Array.from(el.querySelectorAll('.issue-actual')).map(x => x.textContent).join('') };
    });
    assert.equal(marks.expected, '乙丙');
    assert.equal(marks.actual, '丁');
    await issues.screenshot({ path: path.join(os.tmpdir(), 'textdiff55-issues.png'), fullPage: true });
    await issues.setViewportSize({ width: 390, height: 844 });
    assert.equal(await issues.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#review-filter').selectOption('all');

    console.log('Checking modified draft retains unmatched notes');
    await page.locator('#text-right').fill(projectData.right.replace('第一句错', '第一句误'));
    assert.equal(await page.locator('#review-dirty').isVisible(), true);
    await page.getByRole('button', { name: '▶ 立即对比', exact: true }).click();
    assert.equal(await page.locator('#review-list .review-stale').count(), 1);
    assert.equal(await page.locator('#diff-tbody tr').first().locator('.review-row select').inputValue(), 'pending');
    assert.equal(await page.locator('#review-list .review-note p').textContent(), note + ' 请慢一点。');
    await page.locator('#diff-tbody tr').first().locator('.review-row select').selectOption('resolved');
    await page.locator('#review-filter').selectOption('resolved');
    assert.equal(await page.locator('#diff-tbody tr:visible').count(), 1);
    assert.equal(await page.locator('#diff-nav-total').textContent(), '1');
    await page.locator('#review-filter').selectOption('all');
    await page.locator('#opt-digits').check();
    assert.equal(await page.locator('#review-dirty').isVisible(), true);
    await page.getByRole('button', { name: '▶ 立即对比', exact: true }).click();
    // A storage quota failure must be visible and must not break file export.
    assert.equal(await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function() { throw new Error('quota'); };
      try { saveProjectLocally(); return document.getElementById('project-save-status').textContent.includes('保存失败'); }
      finally { Storage.prototype.setItem = original; }
    }), true);
    await page.evaluate(() => saveProjectLocally());
    await page.evaluate(() => setTheme('dark'));
    await page.locator('.review-desk').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), 'textdiff55-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(os.tmpdir(), 'textdiff55-mobile.png'), fullPage: true });
    assert.equal(await page.locator('.review-desk').evaluate(el => el.scrollWidth > el.clientWidth), false);
    console.log('Checking next/previous issue playback and return to the workbench');
    const navigation = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await navigation.goto(pathToFileURL(path.resolve(__dirname, '../TextDiffTool_v5.5.html')).href);
    await navigation.evaluate(() => {
      document.getElementById('text-left').value = Array.from({ length: 30 }, (_, i) => '第' + i + '句正文。').join('\n');
      document.getElementById('text-right').value = Array.from({ length: 30 }, (_, i) =>
        '[' + formatFrameTimecode(i, 25) + ' --> ' + formatFrameTimecode(i + 1, 25) + '] 第' + i + '句正文错。').join('\n');
      document.getElementById('opt-auto-scroll').checked = false;
      document.getElementById('opt-diff-loop').checked = false;
      runCompare();
      const rows = Array.from(document.querySelectorAll('#diff-tbody tr'));
      [2, 10, 15, 20, 5, 12].forEach(index => {
        const record = reviewRecords.get(rows[index].dataset.reviewKey);
        record.status = index === 5 ? 'confirmed' : index === 12 ? 'resolved' : index === 15 ? 'pending' : 'fix';
        record.notes = [{ id: 'note-' + index, time: index + .25, text: '问题' + (index + 1) }];
      });
      reviewRecords.get(rows[2].dataset.reviewKey).notes.push({ id: 'note-2b', time: 2.65, text: '同一行的第二个问题' });
      document.getElementById('review-expanded').checked = true;
      renderReviewDesk();
    });
    await navigation.locator('#media-file-input').setInputFiles(audio);
    await navigation.waitForFunction(() => hasLoadedMedia());
    const note11 = navigation.locator('#review-list .review-note').filter({ hasText: '问题11' }).locator('[data-issue-time]');
    await note11.click();
    await navigation.evaluate(() => mediaState.element.pause());
    const savedListScroll = await navigation.evaluate(() => reviewReturnScroll);
    assert.equal(await navigation.locator('#floating-mini-bar').evaluate(el => el.classList.contains('visible')), true);
    assert.ok((await navigation.locator('#review-playback-label').textContent()).includes('问题 3 / 5'));
    await navigation.locator('#review-return').click();
    await navigation.waitForFunction(() => document.querySelector('.review-desk').getBoundingClientRect().top >= -2);
    assert.equal(await navigation.locator('#review-list').evaluate(el => el.scrollTop), savedListScroll);
    assert.equal(await navigation.evaluate(() => mediaState.element.paused), true);
    await note11.click();
    await navigation.locator('#review-next').click();
    await navigation.evaluate(() => mediaState.element.pause());
    assert.equal(await navigation.evaluate(() => activeReviewTarget.time), 15.25, 'confirmed and resolved items are skipped');
    assert.equal(await navigation.locator('#diff-tbody .active-diff-row .line-num').textContent(), '16');
    await navigation.locator('#review-next').click();
    await navigation.evaluate(() => mediaState.element.pause());
    assert.equal(await navigation.evaluate(() => activeReviewTarget.time), 20.25);
    assert.equal(await navigation.locator('#review-next').isDisabled(), true);
    await navigation.locator('#review-prev').click();
    await navigation.evaluate(() => mediaState.element.pause());
    assert.equal(await navigation.evaluate(() => activeReviewTarget.time), 15.25);
    await navigation.locator('#review-return').click();
    assert.equal(await navigation.locator('#review-list .review-current').count(), 1);
    assert.ok(await navigation.locator('#review-list .review-current').evaluate(el => {
      const note = el.querySelector('[aria-current="true"]');
      const item = note.getBoundingClientRect(), list = el.parentElement.getBoundingClientRect();
      return item.top >= list.top && item.bottom <= list.bottom;
    }));
    await navigation.evaluate(() => {
      const record = reviewRecords.get(activeReviewTarget.key); record.status = 'resolved'; renderReviewDesk();
    });
    await navigation.locator('#review-next').click();
    await navigation.evaluate(() => mediaState.element.pause());
    assert.equal(await navigation.evaluate(() => activeReviewTarget.time), 20.25, 'next follows the completed issue instead of restarting');
    await navigation.locator('#review-prev').click();
    await navigation.evaluate(() => mediaState.element.pause());
    assert.equal(await navigation.evaluate(() => activeReviewTarget.time), 10.25);
    await navigation.locator('#review-prev').click();
    await navigation.evaluate(() => mediaState.element.pause());
    assert.equal(await navigation.evaluate(() => activeReviewTarget.time), 2.65, 'two notes in one row have distinct playback positions');
    console.log('Checking manual result-row selection updates the floating note');
    const resultRows = navigation.locator('#diff-tbody tr');
    await navigation.evaluate(() => {
      const rows = document.querySelectorAll('#diff-tbody tr');
      rows[10].setAttribute('data-cue-end', '12');
      rows[11].setAttribute('data-cue-start', '10');
    });
    await resultRows.nth(10).locator('td').nth(1).click();
    await navigation.evaluate(() => { mediaState.element.pause(); onMediaTimeUpdate(); });
    assert.equal(await navigation.evaluate(() => activeReviewTarget.noteId), 'note-10');
    assert.equal(await navigation.evaluate(() => mediaState.currentPlayingRow.cells[0].textContent), '11', 'explicit row selection wins when cue times overlap');
    assert.ok((await navigation.locator('#review-playback-label').textContent()).includes('问题11'));
    assert.ok(!(await navigation.locator('#review-playback-label').textContent()).includes('同一行的第二个问题'));
    await navigation.evaluate(() => {
      const rows = document.querySelectorAll('#diff-tbody tr');
      rows[10].setAttribute('data-cue-end', '11');
      rows[11].setAttribute('data-cue-start', '11');
    });
    await resultRows.nth(20).locator('.row-action-btn').first().click();
    await navigation.evaluate(() => mediaState.element.pause());
    assert.equal(await navigation.evaluate(() => activeReviewTarget.noteId), 'note-20');
    assert.ok((await navigation.locator('#review-playback-label').textContent()).includes('问题21'));
    await resultRows.nth(2).locator('.timecode-btn').click();
    await navigation.evaluate(() => mediaState.element.pause());
    assert.equal(await navigation.evaluate(() => activeReviewTarget.noteId), 'note-2');
    await navigation.evaluate(() => onMediaSeek(2.7));
    await navigation.waitForFunction(() => activeReviewTarget.noteId === 'note-2b');
    await resultRows.nth(2).locator('td').nth(1).click();
    await navigation.evaluate(() => mediaState.element.pause());
    assert.equal(await navigation.evaluate(() => activeReviewTarget.noteId), 'note-2b', 'pausing the current row uses its current note');
    await resultRows.nth(8).locator('td').nth(1).click();
    await navigation.evaluate(() => mediaState.element.pause());
    assert.ok((await navigation.locator('#review-playback-label').textContent()).includes('本行没有问题备注'));
    assert.ok(!(await navigation.locator('#review-playback-label').textContent()).includes('同一行的第二个问题'));
    await navigation.locator('#review-next').click();
    await navigation.evaluate(() => mediaState.element.pause());
    assert.equal(await navigation.evaluate(() => activeReviewTarget.noteId), 'note-10');
    await navigation.locator('#review-return').click();
    assert.equal(await navigation.locator('#review-list .review-current [aria-current="true"]').textContent(), '00:00:10:06');
    await navigation.setViewportSize({ width: 390, height: 844 });
    await navigation.evaluate(() => {
      document.querySelector('#diff-tbody .active-diff-row').scrollIntoView({ behavior: 'instant', block: 'center' });
      updateFloatingMiniBar();
    });
    await navigation.waitForFunction(() => getComputedStyle(document.getElementById('floating-mini-bar')).opacity === '1');
    assert.equal(await navigation.locator('#fmb-review-nav').isVisible(), true);
    assert.equal(await navigation.locator('#floating-mini-bar').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await navigation.locator('#floating-mini-bar').screenshot({ path: path.join(os.tmpdir(), 'textdiff55-problem-navigation.png'), animations: 'disabled' });
    await navigation.close();
    console.log('Checking compact workbench with 50 issues and independent scrolling');
    const layout = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await layout.goto(pathToFileURL(path.resolve(__dirname, '../TextDiffTool_v5.5.html')).href);
    await layout.evaluate(() => {
      reviewRecords = new Map();
      for (let i = 0; i < 50; i++) reviewRecords.set('layout-' + i, { key: 'layout-' + i, status: 'fix', active: true,
        source: '这是一句需要检查的原文，用于验证紧凑列表的排版。', result: '识别稿件', line: String(i + 1), cueStart: i * 10,
        notes: [{ id: 'note-' + i, time: i * 10 + 3.5, text: '这里有重音或停顿问题，请核对并重新录制。' }] });
      renderReviewDesk();
      setTheme('green');
    });
    assert.equal(await layout.locator('#review-details').isVisible(), false);
    const compactHeight = await layout.locator('.review-desk').evaluate(el => el.getBoundingClientRect().height);
    assert.ok(compactHeight < 180, 'compact desktop height: ' + compactHeight);
    await layout.locator('#review-toggle').click();
    assert.equal(await layout.locator('#review-list .review-card').count(), 50);
    const size = await layout.locator('#review-list').evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight }));
    assert.ok(size.height <= 320 && size.content > size.height);
    assert.ok(await layout.locator('.review-desk').evaluate(el => el.getBoundingClientRect().height) < 520);
    await layout.locator('#review-list').focus();
    await layout.keyboard.press('PageDown');
    await layout.waitForFunction(() => document.getElementById('review-list').scrollTop > 0);
    await layout.locator('.review-desk').screenshot({ path: path.join(os.tmpdir(), 'textdiff55-workbench-expanded.png'), animations: 'disabled' });
    await layout.locator('#review-toggle').click();
    await layout.locator('.review-desk').screenshot({ path: path.join(os.tmpdir(), 'textdiff55-workbench-collapsed.png'), animations: 'disabled' });
    assert.equal(await layout.locator('.review-desk').evaluate(el => el.getBoundingClientRect().height), compactHeight);
    await layout.setViewportSize({ width: 390, height: 844 });
    assert.equal(await layout.locator('.review-desk').evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.ok(await layout.locator('.review-desk').evaluate(el => el.getBoundingClientRect().height) < 300);
    await layout.locator('#review-toggle').click();
    assert.equal(await layout.locator('.review-desk').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await layout.close();
    assert.deepEqual(errors, []);
    assert.ok(fs.readFileSync(path.resolve(__dirname, '../TextDiffTool_v5.1.html')).equals(legacy), '5.1 unchanged');
    console.log('PASS: 5.5 notes, exact timestamp, statuses, filters, autosave/reload/media resume, project import/export, reports, unmatched notes, mobile layout; 5.1 unchanged.');
  } finally { clearTimeout(timeout); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
