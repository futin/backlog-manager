// Prototype the CodeRabbit Review step over the live board and screenshot each option. Throwaway.
const { chromium } = require(process.argv[2]);
const OUT = __dirname;

const CHK = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"></path></svg>';
const BANG = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3.5v5.5M8 12.2v.3"></path></svg>';
const PLAY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5v9l7-4.5z"></path></svg>';
const STATES = {
  none: { mark: 'off', word: 'not reviewed', icon: '' },
  reviewing: { mark: 'grey', word: 'reviewing… 4m', icon: '' },
  open: { mark: 'amber', word: '2 open · 1 major', icon: BANG },
  clean: { mark: 'green', word: '0 open · 25 resolved', icon: CHK },
  stale: { mark: 'grey', word: '3 commits since review', icon: '' }
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  await ctx.addInitScript(() => {
    try {
      const k = 'backlog-manager.settings';
      const s = JSON.parse(localStorage.getItem(k) || '{}');
      s.theme = 'daylight';
      localStorage.setItem(k, JSON.stringify(s));
    } catch {}
  });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5177/');
  await page.getByText('Jira', { exact: true }).first().click();
  await page.getByText('TIMIFY-25729', { exact: true }).first().waitFor();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'daylight'));
  await page.getByRole('button', { name: 'Board', exact: true }).last().click();
  await page.waitForTimeout(500);

  const helpers = ({ STATES, PLAY }) => {
    window.__rv = (sec, st) => {
      sec.querySelectorAll('.__rv').forEach((e) => e.remove());
      const s = STATES[st];
      const ol = sec.querySelector('.jira-dlv-track');
      const li = document.createElement('li');
      li.className = 'jira-dlv-step __rv';
      li.innerHTML = `<span class="jira-dlv-bar" data-mark="${s.mark}"></span><span class="jira-dlv-dot" data-mark="${s.mark}">${s.icon}</span><span class="jira-dlv-step-label" data-mark="${s.mark}">Review</span><span class="jira-dlv-step-word">${s.word}</span>`;
      ol.insertBefore(li, ol.lastElementChild);
    };
    window.__ink = (label) =>
      `<span role="group" class="ui-split ui-split-28 __x"><button type="button" class="ui-split-main"><span class="ui-split-icon">${PLAY}</span>${label}</button></span>`;
  };

  // ---- Cards: two variants of the 25729 card ----
  await page.evaluate(helpers, { STATES, PLAY });
  const cardShot = async (name, fn) => {
    const box = await page.evaluate(fn);
    await page.screenshot({ path: `${OUT}/${name}.png`, clip: box });
  };
  const findCard = `(() => { const k=[...document.querySelectorAll('*')].find(e=>e.childElementCount===0&&e.textContent.trim()==='TIMIFY-25729'); let c=k; while(c && !(c.getBoundingClientRect().height>120)) c=c.parentElement; return c; })()`;
  await page.evaluate(`window.__orig25729 = ${findCard}.innerHTML`);
  await cardShot('card-x', `(() => { const c=${findCard}; const chips=c.querySelectorAll('.jira-mr-chip'); chips[0].setAttribute('data-tone','amber'); chips[0].textContent='!15958 · 2 to fix'; chips[1] && chips[1].remove(); const r=c.getBoundingClientRect(); return {x:r.x-8,y:r.y-8,width:r.width+16,height:r.height+16}; })()`);
  await page.evaluate(`${findCard}.innerHTML = window.__orig25729`);
  await cardShot('card-y', `(() => { const c=${findCard}; const chips=c.querySelectorAll('.jira-mr-chip'); const n=chips[0].cloneNode(true); n.setAttribute('data-tone','amber'); n.textContent='2 to fix'; chips[0].after(n); const r=c.getBoundingClientRect(); return {x:r.x-8,y:r.y-8,width:r.width+16,height:r.height+16}; })()`);
  await page.evaluate(`${findCard}.innerHTML = window.__orig25729`);

  // ---- Detail ----
  await page.getByText('TIMIFY-25729', { exact: true }).first().click();
  await page.locator('.jira-dlv').waitFor();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'daylight'));
  await page.evaluate(() => { window.__dlv = document.querySelector('.jira-dlv').outerHTML; });
  const reset = () => page.evaluate(() => {
    const cur = document.querySelector('.jira-dlv');
    cur.outerHTML = window.__dlv;
    document.querySelectorAll('.__x').forEach((e) => e.remove());
    if (window.__agentHtml) document.querySelector('.jira-dlv').previousElementSibling.innerHTML = window.__agentHtml;
  });
  await page.evaluate(() => { window.__agentHtml = document.querySelector('.jira-dlv').previousElementSibling.innerHTML; });
  const colShot = async (name) => {
    const box = await page.evaluate(() => {
      const d = document.querySelector('.jira-dlv'); const a = d.previousElementSibling;
      const r1 = a.getBoundingClientRect(), r2 = d.getBoundingClientRect();
      return { x: r1.x - 12, y: r1.y - 12, width: r1.width + 24, height: r2.bottom - r1.y + 24 };
    });
    await page.screenshot({ path: `${OUT}/${name}.png`, clip: box });
  };

  // States: one shot per state, Delivery band only
  for (const st of Object.keys(STATES)) {
    await reset();
    await page.evaluate((st) => window.__rv(document.querySelector('.jira-dlv'), st), st);
    const r = await page.evaluate(() => { const b = document.querySelector('.jira-dlv').getBoundingClientRect(); return { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 }; });
    await page.screenshot({ path: `${OUT}/state-${st}.png`, clip: r });
  }

  // Option A — outline chip in the Delivery head
  for (const [st, label] of [['open', 'Fix review'], ['none', 'Request review']]) {
    await reset();
    await page.evaluate(({ st, label }) => {
      const d = document.querySelector('.jira-dlv'); window.__rv(d, st);
      const b = document.createElement('button'); b.className = 'ui-chip ui-chip-outline ui-chip-28 __x'; b.textContent = label; b.style.marginLeft = '10px';
      d.querySelector('.jira-dlv-polled').after(b);
    }, { st, label });
    await colShot(`opt-a-${st}`);
  }
  // Option B — CodeRabbit footer row with an ink button under the track
  for (const [st, label, line] of [['open', 'Fix review', 'CodeRabbit · 2 open findings · 1 major, 1 minor · reviewed 1h ago'], ['none', 'Request review', 'CodeRabbit · not reviewed yet']]) {
    await reset();
    await page.evaluate(({ st, label, line }) => {
      const d = document.querySelector('.jira-dlv'); window.__rv(d, st);
      const row = document.createElement('div'); row.className = '__x';
      row.style.cssText = 'display:flex;align-items:center;gap:10px;border-top:1px solid var(--hairline);padding-top:10px;margin-top:2px';
      row.innerHTML = `<span class="jira-dlv-word" data-tone="${st === 'open' ? 'amber' : 'grey'}" style="flex:1;min-width:0">${line}</span>` + window.__ink(label);
      d.querySelector('.jira-dlv-track').after(row);
    }, { st, label, line });
    await colShot(`opt-b-${st}`);
  }
  // Option C — the Agent pane's Run becomes the review action
  for (const [st, label, sub] of [['open', 'Fix review', 'next: Fix review · 2 open findings on !15958'], ['none', 'Request review', 'next: Request review · !15958 not reviewed']]) {
    await reset();
    await page.evaluate(({ st, label, sub }) => {
      const d = document.querySelector('.jira-dlv'); window.__rv(d, st);
      const a = d.previousElementSibling;
      const leaf = [...a.querySelectorAll('*')].find((e) => e.childElementCount === 0 && /^default:/.test(e.textContent.trim()));
      if (leaf) leaf.textContent = sub;
      const main = a.querySelector('.ui-split-main');
      if (main) main.innerHTML = main.innerHTML.replace(/Run\s*$/, label);
    }, { st, label, sub });
    await colShot(`opt-c-${st}`);
  }
  await reset();
  await page.keyboard.press('Escape');

  // ---- List ----
  await page.getByRole('button', { name: 'List', exact: true }).last().click();
  await page.locator('table tbody tr').first().waitFor();
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('table tbody tr')].find((r) => r.textContent.includes('TIMIFY-25729'));
    const tr = row.querySelector('.jira-dlv-track.compact');
    const cells = tr.querySelectorAll('.jira-dlv-cell');
    const n = cells[cells.length - 1].cloneNode(true);
    n.querySelectorAll('[data-mark]').forEach((e) => e.setAttribute('data-mark', 'amber'));
    tr.insertBefore(n, cells[cells.length - 1]);
    const link = row.querySelector('.jira-issues-dlv-link');
    const nm = [...row.querySelectorAll('*')].find((e) => e.childElementCount === 0 && e.textContent.trim() === 'not merged');
    if (nm) { const c = nm.cloneNode(true); c.textContent = '2 to fix'; nm.before(c); }
    const done = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Done, not merged');
    const f = done.cloneNode(true); f.textContent = 'Review open'; done.after(f);
    const row2 = [...document.querySelectorAll('table tbody tr')].find((r) => r.textContent.includes('TIMIFY-27254'));
    const tr2 = row2.querySelector('.jira-dlv-track.compact'); const c2 = tr2.querySelectorAll('.jira-dlv-cell');
    const n2 = c2[c2.length - 1].cloneNode(true); n2.querySelectorAll('[data-mark]').forEach((e) => e.setAttribute('data-mark', 'magenta'));
    tr2.insertBefore(n2, c2[c2.length - 1]);
  });
  const lr = await page.evaluate(() => { const m = document.querySelector('main'); const r = m.getBoundingClientRect(); const t = document.querySelector('table').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: t.bottom - r.y + 16 }; });
  await page.screenshot({ path: `${OUT}/list.png`, clip: lr });
  // put the view back to Board for the person
  await page.getByRole('button', { name: 'Board', exact: true }).last().click();
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
