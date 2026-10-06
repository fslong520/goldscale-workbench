/* 插件 · 到价提醒（原内建 js/alerts.js 的到价提醒部分整体迁移至此）
 * 契约：window.Pages.<目录名> = { key, title, render(view), destroy() }
 *
 * 迁移事实（与核心的分工）：
 * - 页面 = 完整提醒中心：添加表单（目标价/方向/备注，上限 20 条）＋ 待触发列表（备注·条件价·现价·状态·删除）
 *   ＋ 最近触发 3 条 ＋ 说明小字。设置从行情页现价卡下挪到本页。
 * - 触发检测在**顶层**：被 js/app.js 加载时即 document.addEventListener('gs:spot', …)（核心 15 秒
 *   现价轮询广播，本插件只监听不改定义），与页面是否打开无关——切页、停在别的页照常触发。
 *   顶层只注册一次（window.__gsAlertsLive 幂等闸，防重复加载重复监听）。
 * - 横幅 / 响铃 / 系统通知 / POST 8788/api/event alert_hit / localStorage 持久化：全部照旧平移。
 * - 样式自包含：.aw-* 与 .gs-banner*（原 css/main.css「到价提醒」段）在本文件内注入，
 *   核心 css 删掉后本页与横幅照旧；其余 class（chip/btn/note/stat/card/chip.on）是核心既有风格。
 * - 存储键沿用 gs_alerts / gs_alerts_done：升级不丢用户已登记的提醒。
 * - 事件上报走核心公共插座 window.GSEvent（js/behavior.js，被持仓页/风控页共用），插件只调用。
 */
window.Pages = window.Pages || {};

/* ---------- 样式自包含（原样搬自原 css/main.css「到价提醒」段） ---------- */
(function injectAlertsStyle() {
  if (document.getElementById('gsPriceAlertsStyle')) return;
  const css = `
/* ---------- 到价提醒（盯盘替身，提醒中心 + 全局触发横幅）---------- */
.aw-add {
  display: grid; grid-template-columns: minmax(0, 1fr) 70px auto;
  gap: 6px; align-items: center;
}
.aw-add input, .aw-add select { padding: 4px 7px; font-size: 12px; }
.aw-add .aw-price { grid-area: 1 / 1; }
.aw-add .aw-dir { grid-area: 1 / 2; }
.aw-add .btn { grid-area: 1 / 3; }
.aw-add .aw-label { grid-area: 2 / 1 / 3 / 4; }
.aw-tip { font-size: 11px; margin-top: 6px; line-height: 1.5; }
.aw-list { margin-top: 7px; }
.aw-row {
  display: grid; grid-template-columns: minmax(0, 1fr) 64px 60px 52px 14px;
  gap: 5px; align-items: center;
  padding: 5px 0; border-top: 1px solid var(--line); font-size: 12px;
}
.aw-row:first-child { border-top: none; padding-top: 0; }
.aw-row .aw-label {
  min-width: 0; color: var(--fg-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.aw-row .aw-cond, .aw-row .aw-px { font-family: var(--mono); white-space: nowrap; }
.aw-row .aw-st { text-align: right; }
.aw-row .aw-st .chip {
  padding: 1px 5px; font-size: 10px; line-height: 1.5;
  cursor: default; white-space: nowrap; display: inline-block;
}
.aw-del {
  background: none; border: none; padding: 1px 0;
  color: var(--fg-3); font-size: 12px; line-height: 1; cursor: pointer;
}
.aw-del:hover { color: var(--down); }
.aw-empty { padding: 8px 0 2px; font-size: 12px; color: var(--fg-3); }
.aw-done {
  margin-top: 8px; padding-top: 7px; border-top: 1px dashed var(--line-2);
  display: flex; flex-direction: column; gap: 3px; font-size: 11px;
}
.aw-done-row { display: grid; grid-template-columns: 46px 34px minmax(0, 1fr); gap: 7px; align-items: baseline; }
.aw-done-row .aw-done-t {
  min-width: 0; color: var(--fg-2);
  white-space: normal; overflow-wrap: anywhere;   /* 触发记录不截断，短列表允许换行 */
}

/* 触发横幅：顶部 3 秒，红绿按触发方向 */
.gs-banner-host {
  position: fixed; top: 56px; left: 50%; transform: translateX(-50%);
  z-index: 950; display: flex; flex-direction: column; gap: 7px; align-items: center;
  pointer-events: none;
}
.gs-banner {
  max-width: min(560px, 92vw); padding: 9px 16px; border-radius: 7px;
  font-size: 13px; border: 1px solid var(--line-2);
  background: var(--bg-3); color: var(--fg);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .5);
  animation: gs-banner-in .18s ease-out;
}
.gs-banner.up { border-color: var(--up); background: #0f2320; color: var(--up); }
.gs-banner.down { border-color: var(--down); background: #221313; color: var(--down); }
.gs-banner.out { opacity: 0; transform: translateY(-6px); transition: opacity .22s, transform .22s; }
@keyframes gs-banner-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}

/* ---- 本页新增（上面是原样搬；以下只为本插件页服务：行是窄栏小组件的放大版）---- */
/* 窄栏里 64/60px 够用，宽栏下五位数带千分位会顶穿列宽（实测「↑ 10,000.00」文字 72px > 列 64px，
   与现价只差 2px），故放宽数值列；列头与数据同一套栅格，保证逐列对齐 */
.aw-head {
  display: grid; grid-template-columns: minmax(0, 1fr) 92px 78px 56px 18px;
  gap: 10px; align-items: center;
  padding-bottom: 6px; font-size: 10px; color: var(--fg-3);
  border-bottom: 1px solid var(--line-2);
}
.aw-head .h-st { text-align: right; }
.aw-list .aw-row { grid-template-columns: minmax(0, 1fr) 92px 78px 56px 18px; gap: 10px; }
`;
  const s = document.createElement('style');
  s.id = 'gsPriceAlertsStyle';
  s.textContent = css;
  document.head.appendChild(s);
})();

(function mountPriceAlerts() {
  'use strict';

  const KEY = 'gs_alerts';            // 与迁移前同名，升级不丢已登记提醒
  const DONE_KEY = 'gs_alerts_done';  // 最近触发留档
  const MAX = 20;
  const DONE_MAX = 3;

  /* ---------- 提醒内核：存储 / 比对 / 触发三重 / 列表渲染（后台与页面共用） ---------- */
  const A = {
    refs: null,     // 页面打开时才有：{ statHost, listHost, doneHost, countChip }
    _ac: null,      // WebAudio 惰性单例

    /* ---------- 存储 ---------- */
    load() {
      try {
        const a = JSON.parse(localStorage.getItem(KEY) || '[]');
        return Array.isArray(a)
          ? a.filter((x) => x && typeof x.price === 'number' && isFinite(x.price))
          : [];
      } catch { return []; }
    },
    save(list) {
      try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); }
      catch { U.toast('提醒保存失败（本机存储已满）', 'warn'); }
    },
    done() {
      try {
        const a = JSON.parse(localStorage.getItem(DONE_KEY) || '[]');
        return Array.isArray(a) ? a.filter((x) => x && typeof x.price === 'number') : [];
      } catch { return []; }
    },
    saveDone(list) {
      try { localStorage.setItem(DONE_KEY, JSON.stringify(list.slice(0, DONE_MAX))); }
      catch { /* 超限静默 */ }
    },

    /* ---------- 比对与触发 ---------- */
    onSpot(sp) {
      this.syncPrices(sp);
      return this.check(sp);
    },

    /** 比对触发：命中即出列 + 记入最近触发；返回命中条数 */
    check(sp) {
      if (!sp || typeof sp.price !== 'number' || !isFinite(sp.price)) return 0;
      const list = this.load();
      if (!list.length) return 0;
      const hit = list.filter((a) => this.hit(a, sp.price));
      if (!hit.length) return 0;

      this.save(list.filter((a) => !this.hit(a, sp.price)));
      const done = this.done();
      for (const a of hit) {
        done.unshift({ label: a.label || '', price: a.price, dir: a.dir, ts: Date.now(), spot: sp.price });
        this.fire(a, sp.price);
      }
      this.saveDone(done);
      this.renderList();     // 页面开着就地刷新；没开则为空操作
      return hit.length;
    },

    /** 触发判据：上穿=现价≥目标；下跌=现价≤目标（不做「必须穿越」的苛刻判据，到价即报） */
    hit(a, price) { return a.dir === 'below' ? price <= a.price : price >= a.price; },

    /* ---------- 触发三重 ---------- */
    fire(a, price) {
      const up = a.dir !== 'below';
      const text = `${up ? '上穿' : '下跌'} ${U.px(a.price)} 已触发（现价 ${U.px(price)}）`
        + (a.label ? ` · ${a.label}` : '');
      this.banner('到价提醒：' + text, up ? 'up' : 'down');
      this.beep();
      this.notify(up ? '到价提醒 · 上穿' : '到价提醒 · 下跌', text);
      // 行为层上报（核心公共插座 GSEvent → POST 8788/api/event）：fire-and-forget，agentd 未就绪即静默
      window.GSEvent?.post?.('alert_hit', {
        price: a.price, spot: price, dir: a.dir, label: a.label || ''
      });
    },

    /** 顶部横幅：3 秒自动消失，多条排队不互相顶掉 */
    banner(text, kind) {
      let host = document.getElementById('alertBannerHost');
      if (!host) {
        host = U.el('div', { id: 'alertBannerHost', class: 'gs-banner-host' });
        document.body.appendChild(host);
      }
      const b = U.el('div', { class: 'gs-banner ' + (kind || ''), text: text });
      host.appendChild(b);
      setTimeout(() => {
        b.classList.add('out');
        setTimeout(() => b.remove(), 240);
      }, 3000);
    },

    /** 两声短哔：WebAudio 现场合成，不引音频文件；被浏览器拦就静默 */
    beep() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!this._ac) this._ac = new AC();
        const ac = this._ac;
        if (ac.state === 'suspended') ac.resume().catch(() => {});
        const t0 = ac.currentTime;
        for (const off of [0, 0.19]) {
          const o = ac.createOscillator();
          const g = ac.createGain();
          o.type = 'sine';
          o.frequency.value = 880;
          g.gain.setValueAtTime(0.0001, t0 + off);
          g.gain.exponentialRampToValueAtTime(0.2, t0 + off + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.12);
          o.connect(g);
          g.connect(ac.destination);
          o.start(t0 + off);
          o.stop(t0 + off + 0.15);
        }
      } catch { /* 静音浏览器/无音频设备：静默 */ }
    },

    /** 系统通知：首次触发才请求权限；被拒/不可用不纠缠 */
    notify(title, body) {
      try {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission === 'granted') {
          new Notification(title, { body: body });
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission().then((p) => {
            if (p === 'granted') { try { new Notification(title, { body: body }); } catch { /* 静默 */ } }
          }).catch(() => {});
        }
      } catch { /* 通知不可用：静默 */ }
    },

    /* ---------- 表单动作（页面调用） ---------- */
    add(priceIn, dirSel, labelIn) {
      const price = Number(priceIn.value);
      if (!priceIn.value || !isFinite(price) || price <= 0) {
        U.toast('请填目标价（数字）', 'warn');
        priceIn.focus();
        return;
      }
      const dir = dirSel.value === 'below' ? 'below' : 'above';
      const p = Math.round(price * 100) / 100;
      const list = this.load();
      if (list.length >= MAX) return U.toast(`最多 ${MAX} 条提醒，先删几条`, 'warn');
      if (list.some((a) => a.price === p && a.dir === dir)) {
        return U.toast('同样条件的提醒已在列表里', 'warn');
      }
      list.push({
        id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        price: p, dir: dir, label: String(labelIn.value || '').trim().slice(0, 20), ts: Date.now()
      });
      this.save(list);
      priceIn.value = '';
      labelIn.value = '';
      this.renderList();
      // 立即比对一次：已经到价的不装没看见（落在列表里也会被 banner 揭出来）
      const sp = typeof State !== 'undefined' ? State.spot : null;
      const fired = sp ? this.onSpot(sp) : 0;
      if (!fired) U.toast(`已加提醒：${dir === 'below' ? '下跌至' : '上穿'} ${U.px(p)}`, 'ok');
    },

    remove(id) {
      this.save(this.load().filter((a) => a.id !== id));
      this.renderList();
      U.toast('已删除该提醒');
    },

    /* ---------- 渲染（页面没开则为空操作） ---------- */
    paintStats() {
      const r = this.refs;
      if (!r || !r.statHost || !r.statHost.isConnected) return;
      const list = this.load();
      const done = this.done();
      const sp = typeof State !== 'undefined' ? State.spot : null;
      const px = sp && typeof sp.price === 'number' && isFinite(sp.price) ? sp.price : null;
      const near = px === null ? 0 : list.filter((a) => this.hit(a, px)).length;
      // 距离现价最近的一条：让人一眼知道「下一个可能是谁」（没有就不编，显示 —）
      const next = px === null ? null : list.reduce((best, a) => {
        const d = Math.abs(a.price - px);
        return best === null || d < best.d ? { a: a, d: d } : best;
      }, null);

      U.clear(r.statHost);
      r.statHost.appendChild(U.stat('待触发', list.length + ' / ' + MAX,
        near ? '其中 ' + near + ' 条已到价' : '到价即出列', 'mono'));
      r.statHost.appendChild(U.stat('现价 XAU/USD', px === null ? '--' : U.px(px),
        sp && sp.t ? '更新于 ' + U.ago(sp.t) : '等待 15 秒轮询', 'mono'));
      r.statHost.appendChild(U.stat('最近待触发', next === null ? '--' : U.px(next.a.price),
        next === null ? '暂无待触发' : (next.a.dir === 'below' ? '下跌至 · 距现价 ' : '上穿 · 距现价 ')
          + U.fx(next.d, 2), 'mono'));
      r.statHost.appendChild(U.stat('最近触发', String(done.length),
        '留档最近 ' + DONE_MAX + ' 条', 'mono'));
    },

    renderList() {
      const r = this.refs;
      if (!r || !r.listHost || !r.listHost.isConnected) return;
      const list = this.load();
      const sp = typeof State !== 'undefined' ? State.spot : null;
      const px = sp && typeof sp.price === 'number' ? sp.price : null;

      if (r.countChip) {
        r.countChip.textContent = list.length ? list.length + ' / ' + MAX : '暂无';
      }
      U.clear(r.listHost);
      if (!list.length) {
        r.listHost.appendChild(U.el('div', {
          class: 'aw-empty', text: '没有待触发的提醒：在右侧填目标价与方向，点「添加」'
        }));
      } else {
        // 列头：行被放大到宽栏后，没有列头就得靠猜哪列是目标价、哪列是现价
        r.listHost.appendChild(U.el('div', { class: 'aw-head' },
          U.el('span', { text: '备注' }),
          U.el('span', { text: '条件价' }),
          U.el('span', { text: '现价' }),
          U.el('span', { class: 'h-st', text: '状态' }),
          U.el('span', { text: '' })));
        for (const a of list) {
          const hitNow = px !== null && this.hit(a, px);
          r.listHost.appendChild(U.el('div', { class: 'aw-row', 'data-alert': a.id },
            U.el('span', { class: 'aw-label', title: a.label || '', text: a.label || '—' }),
            U.el('span', {
              class: 'aw-cond ' + (a.dir === 'below' ? 'down' : 'up'),
              title: a.dir === 'below' ? '下跌至该价即报' : '上穿该价即报',
              text: (a.dir === 'below' ? '↓ ' : '↑ ') + U.px(a.price)
            }),
            U.el('span', { class: 'aw-px', 'data-px': '1', text: px !== null ? U.px(px) : '--' }),
            U.el('span', { class: 'aw-st' },
              U.el('span', { class: 'chip' + (hitNow ? ' on' : ''), text: hitNow ? '已到价' : '未到' })),
            U.el('button', {
              class: 'aw-del', title: '删除这条提醒', text: '✕',
              onclick: () => this.remove(a.id)
            })));
        }
      }

      U.clear(r.doneHost);
      const done = this.done();
      if (!done.length) {
        r.doneHost.appendChild(U.el('div', {
          class: 'aw-empty', text: '还没有触发记录：到价后这里留档最近 ' + DONE_MAX + ' 条'
        }));
        this.paintStats();
        return;
      }
      r.doneHost.appendChild(U.el('div', {
        class: 'aw-done', style: 'margin-top:0;padding-top:0;border-top:none'
      }, done.map((d) => U.el('div', { class: 'aw-done-row' },
        U.el('span', { class: 'mono dim', text: U.hhmmss(Math.floor(d.ts / 1000)) }),
        U.el('span', { class: d.dir === 'below' ? 'down' : 'up', text: '已触发' }),
        U.el('span', { class: 'aw-done-t', text: (d.label ? d.label + ' · ' : '')
          + (d.dir === 'below' ? '下跌至 ' : '上穿 ') + U.px(d.price)
          + '（现价 ' + U.px(d.spot) + '）' })))));
      this.paintStats();
    },

    /** 只刷新现价列与「未到/已到价」状态：不重建 DOM，用户正在输入的框不被清掉 */
    syncPrices(sp) {
      const r = this.refs;
      if (!r || !r.listHost || !r.listHost.isConnected) return;
      const px = sp && typeof sp.price === 'number' && isFinite(sp.price) ? sp.price : null;
      const list = this.load();
      for (const row of r.listHost.querySelectorAll('.aw-row')) {
        const a = list.find((x) => x.id === row.getAttribute('data-alert'));
        const cell = row.querySelector('[data-px]');
        if (cell) cell.textContent = px !== null ? U.px(px) : '--';
        const chip = row.querySelector('.aw-st .chip');
        if (a && chip) {
          const hitNow = px !== null && this.hit(a, px);
          chip.textContent = hitNow ? '已到价' : '未到';
          chip.classList.toggle('on', hitNow);
        }
      }
      this.paintStats();
    }
  };

  /* ---------- 顶层常驻：被加载即监听（页面开关无关），只注册一次 ---------- */
  let live;
  if (window.__gsAlertsLive) {
    live = window.__gsAlertsLive;       // 本文件重复加载：复用既有实例，不重复注册监听
  } else {
    live = window.__gsAlertsLive = A;
    document.addEventListener('gs:spot', (e) => live.onSpot(e && e.detail));
    // 冷启动先比对一次：页面久留、还未轮询到新价时也不漏
    if (typeof State !== 'undefined' && State.spot) live.onSpot(State.spot);
  }

  /* ---------- 页面：提醒中心（原行情页小组件的完整版） ---------- */
  window.Pages['price-alerts'] = {
    key: 'price-alerts',
    title: '到价提醒',

    render(view) {
      U.clear(view);
      const page = U.el('div', { class: 'page' });

      const statHost = U.el('div', { class: 'stats' });

      /* 添加表单：与迁移前的行情页小组件同构（判据、上限、去重一律照旧） */
      const priceIn = U.el('input', {
        type: 'number', step: '0.1', class: 'aw-price', placeholder: '目标价', title: '到价即提醒'
      });
      const dirSel = U.el('select', { class: 'aw-dir', title: '触发方向' }, [
        U.el('option', { value: 'above', text: '上穿' }),
        U.el('option', { value: 'below', text: '下跌' })
      ]);
      const labelIn = U.el('input', {
        type: 'text', class: 'aw-label', maxlength: '20', placeholder: '备注（可选）'
      });
      const addBtn = U.el('button', { class: 'btn sm gold', text: '添加' });
      const add = () => live.add(priceIn, dirSel, labelIn);
      addBtn.addEventListener('click', add);
      for (const el of [priceIn, labelIn]) {
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      }
      const addCard = U.card('添加提醒', U.el('div', {},
        U.el('div', { class: 'aw-add' }, priceIn, dirSel, labelIn, addBtn),
        U.el('div', { class: 'aw-tip dim', text: '到价即报：顶部横幅 ＋ 提示音 ＋ 系统通知（最多 ' + MAX + ' 条）' })));

      const countChip = U.el('span', { class: 'chip' });
      const listHost = U.el('div', { class: 'aw-list' });
      const listCard = U.card('待触发提醒', listHost, [countChip]);

      const doneHost = U.el('div', {});
      const doneCard = U.card('最近触发', doneHost);

      const tipCard = U.card('说明', U.el('div', {},
        U.el('div', { class: 'aw-tip dim' },
          '触发即报：顶部横幅（3 秒）＋ 两声提示音 ＋ 系统通知（首次触发才申请通知权限，被拒不纠缠）。'),
        U.el('div', { class: 'aw-tip dim' },
          '后台常驻：本插件被加载后即监听核心的 gs:spot 现价广播（15 秒一次），'
          + '切到行情、持仓等其它页面照常触发，不必停在本页。'),
        U.el('div', { class: 'aw-tip dim' },
          '判据：上穿＝现价 ≥ 目标价；下跌＝现价 ≤ 目标价（到价即报，不等真正穿越）。'),
        U.el('div', { class: 'aw-tip dim' },
          '存在本机浏览器（localStorage，键 ' + KEY + '）：刷新与切页都不丢，触发过的自动出列并留档最近 '
          + DONE_MAX + ' 条。')));

      page.appendChild(statHost);
      page.appendChild(U.el('div', { class: 'g-main' },
        listCard,
        U.el('div', { style: 'display:flex;flex-direction:column;gap:11px' },
          addCard, doneCard, tipCard)));
      view.appendChild(page);

      live.refs = { statHost: statHost, listHost: listHost, doneHost: doneHost, countChip: countChip };
      live.renderList();
      priceIn.focus();
    },

    /* 切页：只摘掉页面引用（后台监听与触发三重照常，跨页提醒不因切页而停） */
    destroy() {
      live.refs = null;
    }
  };
})();
