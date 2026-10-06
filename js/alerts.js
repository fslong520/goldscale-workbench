/* 到价提醒：盯盘替身（自包含，跨页生效）
 *
 * 本文件末尾另挂一节「行为层共享件」：GSEvent（行为事件上报 8788/api/event）、
 * Behavior（今日可亏钱口径）、Cooldown（亏损冷却本机配置）。三者被持仓页/风控页共用，
 * 因本轮改动不许新增 js 文件、亦不许动 index.html，故与到价提醒同处这个全局已加载的模块。
 *
 * - 数据源：app.js 现价轮询（15 秒）末尾广播的 `gs:spot` 事件（detail = State.spot），
 *   本模块只监听该事件比对触发，不动轮询本身。
 * - 触发三重：页面顶部横幅（3 秒）＋ WebAudio 两声短哔（无音频文件，被拦则静默）
 *   ＋ 系统通知（首次触发才请求权限，被拒不纠缠）。
 * - 持久化：localStorage `gs_alerts`（上限 20 条，触发后自动出列）
 *   与 `gs_alerts_done`（最近触发 3 条）。刷新、切页都不丢。
 * - 挂载：app.js boot 尾调 Alerts.init()；行情页现价卡下挂 Alerts.renderWidget(host)。
 */
window.Alerts = {
  KEY: 'gs_alerts',
  DONE_KEY: 'gs_alerts_done',
  MAX: 20,
  DONE_MAX: 3,
  _host: null,
  _refs: null,
  _inited: false,
  _ac: null,

  /* ---------- 存储 ---------- */
  load() {
    try {
      const a = JSON.parse(localStorage.getItem(this.KEY) || '[]');
      return Array.isArray(a)
        ? a.filter((x) => x && typeof x.price === 'number' && isFinite(x.price))
        : [];
    } catch { return []; }
  },
  save(list) {
    try { localStorage.setItem(this.KEY, JSON.stringify(list.slice(0, this.MAX))); }
    catch { U.toast('提醒保存失败（本机存储已满）', 'warn'); }
  },
  done() {
    try {
      const a = JSON.parse(localStorage.getItem(this.DONE_KEY) || '[]');
      return Array.isArray(a) ? a.filter((x) => x && typeof x.price === 'number') : [];
    } catch { return []; }
  },
  saveDone(list) {
    try { localStorage.setItem(this.DONE_KEY, JSON.stringify(list.slice(0, this.DONE_MAX))); }
    catch { /* 超限静默 */ }
  },

  /* ---------- 生命周期 ---------- */
  /** 全局初始化（app.js boot 尾调用；跨页只一次） */
  init() {
    if (this._inited) return;
    this._inited = true;
    document.addEventListener('gs:spot', (e) => this.onSpot(e && e.detail));
    // 冷启动先比对一次：页面久留、还未轮询到新价时也不漏
    if (typeof State !== 'undefined' && State.spot) this.onSpot(State.spot);
  },

  onSpot(sp) {
    this.syncPrices(sp);
    return this.check(sp);
  },

  /** 比对触发：命中即出列 + 记入最近触发 */
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
    this.renderList();
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
    // 行为层上报：到价提醒命中（fire-and-forget，agentd 未就绪即静默）
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

  /* ---------- 小组件（行情页现价卡下挂载） ---------- */
  renderWidget(host) {
    if (!host || !host.isConnected) return;
    this.init();
    if (host === this._host && host.querySelector('.aw')) {
      this.syncPrices(typeof State !== 'undefined' ? State.spot : null);
      this.renderList();
      return;
    }
    this._host = host;

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
    const add = () => this.add(priceIn, dirSel, labelIn);
    addBtn.addEventListener('click', add);
    for (const el of [priceIn, labelIn]) {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    }

    const listHost = U.el('div', { class: 'aw-list' });
    const doneHost = U.el('div', { class: 'aw-done-host' });
    U.clear(host);
    host.appendChild(U.el('div', { class: 'aw' },
      U.el('div', { class: 'aw-add' }, priceIn, dirSel, labelIn, addBtn),
      U.el('div', { class: 'aw-tip dim', text: '到价即报：顶部横幅 ＋ 提示音 ＋ 系统通知（最多 20 条）' }),
      listHost,
      doneHost));
    this._refs = { listHost: listHost, doneHost: doneHost };
    this.renderList();
  },

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
    if (list.length >= this.MAX) return U.toast(`最多 ${this.MAX} 条提醒，先删几条`, 'warn');
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

  renderList() {
    const r = this._refs;
    if (!r || !r.listHost || !r.listHost.isConnected) return;
    const list = this.load();
    const sp = typeof State !== 'undefined' ? State.spot : null;
    const px = sp && typeof sp.price === 'number' ? sp.price : null;

    U.clear(r.listHost);
    if (!list.length) {
      r.listHost.appendChild(U.el('div', { class: 'aw-empty', text: '没有待触发的提醒：填目标价与方向，点「添加」' }));
    } else {
      for (const a of list) {
        const hitNow = px !== null && this.hit(a, px);
        r.listHost.appendChild(U.el('div', { class: 'aw-row', 'data-alert': a.id },
          U.el('span', { class: 'aw-label', title: a.label || '', text: a.label || '—' }),
          U.el('span', { class: 'aw-cond ' + (a.dir === 'below' ? 'down' : 'up'),
            text: (a.dir === 'below' ? '↓ ' : '↑ ') + U.px(a.price) }),
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
    if (!done.length) return;
    r.doneHost.appendChild(U.el('div', { class: 'aw-done' },
      U.el('div', { class: 'dim', text: '最近触发' }),
      done.map((d) => U.el('div', { class: 'aw-done-row' },
        U.el('span', { class: 'mono dim', text: U.hhmmss(Math.floor(d.ts / 1000)) }),
        U.el('span', { class: d.dir === 'below' ? 'down' : 'up', text: '已触发' }),
        U.el('span', { class: 'aw-done-t', text: (d.label ? d.label + ' · ' : '')
          + (d.dir === 'below' ? '下跌至 ' : '上穿 ') + U.px(d.price)
          + '（现价 ' + U.px(d.spot) + '）' })))));
  },

  /** 只刷新现价列与「未到/已到价」状态：不重建 DOM，用户正在输入的框不被清掉 */
  syncPrices(sp) {
    const r = this._refs;
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
  }
};

/* ================= 行为层共享件（跨页；见文件头说明） =================
 * 产品哲学：代码只守钱闸、事件上报，话术归 agent。此处只做「报实况」与「算钱」，
 * 不写任何劝诫文案（人话由教练侧生成）。
 */

/** 行为事件上报：POST 8788/api/event，fire-and-forget。
 *  agentd 未就绪（404/拒绝/跨域/超时）一律静默——上报失败绝不打扰操盘、绝不刷 console。 */
window.GSEvent = {
  BASE: 'http://127.0.0.1:8788',
  post(type, payload) {
    const t = String(type || '').trim();
    if (!t) return;
    try {
      fetch(this.BASE + '/api/event', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: t, payload: payload || {} })
      }).catch(() => {});
    } catch { /* 静默：对方不在线不是错误 */ }
  }
};

/** 今日可亏额度（与后端 risk::gate_check 同一口径）：
 *  预算 = 权益 × daily_loss_budget_pct/100；剩余额度 = 预算 + daily_pnl（pnl 为负即扣减），clamp ≥0。
 *  权益取 /api/stats 的 equity（无则回退 settings.equity）。字段缺失 → missing，0 或负 → off。
 *  三处展示（风控卡 / 开仓表单 / 总览卡）共用此函数，保证同屏同值。 */
window.Behavior = {
  todayBudget(stats, risk, fallbackEquity) {
    const raw = risk ? risk.daily_loss_budget_pct : undefined;
    if (typeof raw !== 'number' || !isFinite(raw)) return { ok: false, why: 'missing' };
    if (!(raw > 0)) return { ok: false, why: 'off', pct: raw };
    // 已实现盈亏是「已亏」的分子：拿不到就不知道今天亏了多少，
    // 宁可显示 -- 让人知道未到手，绝不拿 0 冒充（宁缺毋假）。
    if (!stats || typeof stats.daily_pnl !== 'number' || !isFinite(stats.daily_pnl)) {
      return { ok: false, why: 'nodata', pct: raw };
    }
    const eq = stats.equity > 0 ? stats.equity
      : (fallbackEquity > 0 ? fallbackEquity : null);
    if (eq === null) return { ok: false, why: 'nodata', pct: raw };
    const pnl = stats.daily_pnl;
    const budget = eq * raw / 100;
    const loss = pnl < 0 ? -pnl : 0;
    return {
      ok: true, pct: raw, equity: eq, budget: budget, loss: loss,
      remaining: Math.max(budget - loss, 0),
      over: loss >= budget            // 已达/超预算：与后端拦截线一致（loss >= budget 即拦）
    };
  },
  /** 「按本金 Y% · 今日已亏 $Z」副文案（三处统一） */
  budgetNote(b) {
    return '按本金 ' + U.fx(b.pct, 1) + '% · 今日已亏 ' + this.usd(b.loss);
  },
  /** 美元写法统一在此：符号前缀只此一处 */
  usd(n) { return "$" + U.fx(n, 2); }
};

/** 亏损冷却（纯前端、只存本机浏览器，不入服务端设置）：
 *  gs_cooldown_on 默认开；gs_cooldown_min 默认 15 分钟；gs_cooldown_ack 为会话级已确认标记。 */
window.Cooldown = {
  ON_KEY: 'gs_cooldown_on',
  MIN_KEY: 'gs_cooldown_min',
  ACK_KEY: 'gs_cooldown_ack',
  DEFAULT_MIN: 15,
  MIN_MIN: 1,
  MAX_MIN: 120,

  on() {
    try { return localStorage.getItem(this.ON_KEY) !== '0'; }   // 缺省即开
    catch { return true; }                                      // 存储被禁：按默认开（不做暗改）
  },
  setOn(v) {
    try { localStorage.setItem(this.ON_KEY, v ? '1' : '0'); } catch { /* 静默 */ }
  },
  min() {
    try {
      const v = parseFloat(localStorage.getItem(this.MIN_KEY));
      if (isFinite(v) && v > 0) return Math.min(Math.max(v, this.MIN_MIN), this.MAX_MIN);
    } catch { /* 静默 */ }
    return this.DEFAULT_MIN;
  },
  setMin(v) {
    const n = Math.min(Math.max(Math.round(parseFloat(v) || this.DEFAULT_MIN), this.MIN_MIN), this.MAX_MIN);
    try { localStorage.setItem(this.MIN_KEY, String(n)); } catch { /* 静默 */ }
    return n;
  },
  acked() {
    try { return sessionStorage.getItem(this.ACK_KEY) === '1'; } catch { return false; }
  },
  ack() {
    try { sessionStorage.setItem(this.ACK_KEY, '1'); } catch { /* 静默 */ }
  }
};
