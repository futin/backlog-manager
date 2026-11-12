const { chromium } = require('/Users/andrejajevtic/.npm/_npx/53b5ca06f5b71ebd/node_modules/playwright');
const OUT = process.argv[2];
async function open(b) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { try { const k='backlog-manager.settings'; const s=JSON.parse(localStorage.getItem(k)||'{}'); s.theme='daylight'; localStorage.setItem(k, JSON.stringify(s)); } catch(e){} });
  const p = await ctx.newPage();
  await p.goto('http://localhost:5177/'); await p.waitForTimeout(1500);
  await p.getByRole('button', { name: /jira/i }).first().click(); await p.waitForTimeout(1500);
  if (!(await p.getByRole('button',{name:'My sprint tasks'}).count())) { await p.getByRole('button',{name:'Globals'}).click(); await p.waitForTimeout(400); await p.getByText('My sprint tasks').first().click(); }
  await p.waitForTimeout(2500);
  await p.getByText('TIMIFY-28028').first().click(); await p.waitForTimeout(2000);
  // Doorway 1: parent crumb + Parent fact become links.
  await p.evaluate(() => {
    const dlg = document.querySelector('[role=dialog]');
    const linkColor = getComputedStyle(dlg.querySelector('a:not(.jira-detail-out)')).color;
    const mk = (text) => { const a = document.createElement('a'); a.href = '#'; a.textContent = text; a.style.color = linkColor; a.style.textDecoration = 'underline'; a.style.textUnderlineOffset = '3px'; a.style.cursor = 'pointer'; return a; };
    const crumb = [...dlg.querySelectorAll('.jira-detail-crumbs span')].find(e => /in TIMIFY-27763/.test(e.textContent));
    crumb.textContent = '· in '; crumb.appendChild(mk('TIMIFY-27763 [BE] Booking sheets setting, field choice and sheet data'));
    const fact = [...dlg.querySelectorAll('*')].find(e => e.children.length === 0 && /^TIMIFY-27763 \[BE\]/.test(e.textContent));
    if (fact) { const t = fact.textContent; fact.textContent = ''; fact.appendChild(mk(t)); }
  });
  return p;
}
const dlgClip = async (p, h) => { const r = await p.locator('[role=dialog]').first().boundingBox(); return { x: r.x, y: r.y, width: r.width, height: h ?? r.height }; };
(async () => {
  const b = await chromium.launch();
  let p = await open(b);
  await p.screenshot({ path: OUT + '/1-crumb-link.png', clip: await dlgClip(p, 500) });

  // Menu A: a "Parent · KEY" section under the subtask's own rows (built-ins only).
  await p.locator('[role=dialog] .jira-run button.ui-split-more').click(); await p.waitForTimeout(400);
  await p.evaluate(() => {
    const m = document.querySelector('[aria-label="Run menu"]');
    const rule = m.querySelector('.jira-run-rule');
    const head = document.createElement('div'); head.className = 'jira-run-head'; head.textContent = 'Parent · TIMIFY-27763 · Story';
    m.insertBefore(head, rule);
    [...m.querySelectorAll('.jira-run-opt')].slice(0, 2).forEach((o) => { const c = o.cloneNode(true); c.classList.remove('jira-run-opt-default'); c.querySelector('.jira-run-mark')?.remove(); c.querySelector('.jira-run-sub').textContent = 'on TIMIFY-27763 — its branch, its card'; m.insertBefore(c, rule); });
  });
  const menuShot = async (name) => { const r = await p.locator('[aria-label="Run menu"]').boundingBox(); const d = await p.locator('[role=dialog]').first().boundingBox(); await p.screenshot({ path: OUT + '/' + name, clip: { x: d.x, y: d.y, width: d.width * 0.55, height: Math.min(900 - d.y, r.y + r.height - d.y + 20) } }); };
  await menuShot('2-menu-A-parent-section.png');
  await p.context().close();

  // Menu B: a "Run on" toggle at the menu's top; every row acts on the picked ticket.
  p = await open(b);
  await p.locator('[role=dialog] .jira-run button.ui-split-more').click(); await p.waitForTimeout(400);
  await p.evaluate(() => {
    const m = document.querySelector('[aria-label="Run menu"]');
    const wrap = document.createElement('div'); wrap.style.cssText = ''; wrap.style.padding = '8px 10px 4px';
    const lab = document.createElement('div'); lab.className = 'jira-run-head'; lab.textContent = 'Run on'; lab.style.padding = '0 0 6px';
    const seg = document.createElement('div'); seg.style.display = 'flex'; seg.style.gap = '4px'; seg.style.padding = '3px'; seg.style.borderRadius = '8px'; seg.style.background = 'var(--surface-2, #efefec)';
    const btn = (t, sub, on) => { const x = document.createElement('button'); x.type = 'button'; x.style.flex = '1'; x.style.border = '0'; x.style.borderRadius = '6px'; x.style.padding = '5px 6px'; x.style.font = 'inherit'; x.style.fontSize = '12px'; x.style.textAlign = 'left'; x.style.cursor = 'pointer'; x.style.background = on ? 'var(--surface, #fff)' : 'transparent'; x.style.boxShadow = on ? '0 1px 2px rgba(0,0,0,.12)' : 'none'; x.innerHTML = '<div style="font-weight:600">' + t + '</div><div style="opacity:.6;font-size:11px">' + sub + '</div>'; return x; };
    seg.append(btn('TIMIFY-28028', 'this sub-task', false), btn('TIMIFY-27763', 'parent story', true));
    wrap.append(lab, seg); m.prepend(wrap);
    m.querySelectorAll('.jira-run-sub').forEach((s) => { if (/Work the ticket/.test(s.textContent)) s.textContent = 'Work TIMIFY-27763 end to end'; });
  });
  await menuShot('3-menu-B-run-on-toggle.png');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);

  // Parent live: a line in the sub-task's Agent band, like the existing child-session line on a parent.
  await p.evaluate(() => {
    const t = document.querySelector('[role=dialog] .jira-detail-agent-text');
    const line = document.createElement('button'); line.type = 'button'; line.className = 'jira-detail-agent-child';
    line.innerHTML = '<i class="ui-stripe-dot" data-tone="ok" aria-hidden="true"></i><span>Parent TIMIFY-27763 · Running · 12m · microservice</span><span aria-hidden="true"> →</span>';
    t.appendChild(line);
  });
  await p.screenshot({ path: OUT + '/4-parent-live-line.png', clip: await dlgClip(p, 360) });
  await b.close();
})();
