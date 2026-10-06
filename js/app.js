/* 应用外壳：路由、顶栏行情、轮询、插件层动态加载 */

// 路由表：内置页在前；plugins/index.json 登记的插件页在启动时追加到尾部
const PAGES = [PageWatch, PageSignal, PagePositions, PageReview, PageStrategy, PageRisk, PageSettings];

/* 插件层取文件：带超时，失败由调用方处理（本地静态目录，正常为毫秒级） */
async function fetchPluginURL(url, kind) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return kind === 'json' ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const App = {
  current: null,
  spotTimer: null,
  posTimer: null,

  async boot() {
    // 导航
    const nav = document.getElementById('nav');
    U.clear(nav);
    for (const p of PAGES) {
      nav.appendChild(U.el('div', {
        class: 'nav-item', text: p.title,
        onclick: () => this.go(p.key)
      }));
    }

    // 插件层：登记在 plugins/index.json 的页面在此挂载。
    // 插件层是外挂层——注册表/清单/脚本任何异常都只跳过该插件，绝不阻塞启动、不动内置页。
    try {
      await this.loadPlugins();
    } catch (e) {
      console.warn('[plugins] 插件层异常，已整体忽略：', e.message);
    }

    await this.reloadSettings();
    await this.refreshSpot();
    // 默认落点：优先带 home:true 的页面（如总览插件）；插件缺失时退回内置「行情」
    const home = PAGES.find((p) => p.home) || PAGES.find((p) => p.key === 'watch') || PAGES[0];
    this.go(home.key);

    // 现价轮询：15 秒
    this.spotTimer = setInterval(() => this.refreshSpot(), 15000);
    // 持仓价格刷新：10 秒
    this.posTimer = setInterval(() => {
      if (this.current === PagePositions) this.current.renderList?.();
    }, 10000);
    // 到价提醒（js/alerts.js）：全局挂载，监听下面的 gs:spot 广播比对触发，跨页生效
    try { window.Alerts?.init?.(); }
    catch (e) { console.warn('[alerts] 初始化失败，已忽略：', e.message); }
    // 教练动态（行为层）：顶栏「询问 AI」左侧的入口与下拉面板；挂不上也不影响启动
    try { window.Coach?.mount?.(); }
    catch (e) { console.warn('[coach] 入口挂载失败，已忽略：', e.message); }
  },

  /* ---------- 插件层 ----------
   * 浏览器不能列目录，故清单走静态注册表 plugins/index.json（agent 加插件时登记）。
   * 每项：index.js（导出 window.Pages.<name>）与 manifest.json（核 title/order）合并后入路由表。
   */
  async loadPlugins() {
    let reg;
    try {
      reg = await fetchPluginURL('plugins/index.json', 'json');
    } catch (e) {
      console.warn('[plugins] 注册表 plugins/index.json 读取失败，本次不加载插件：', e.message);
      return;
    }
    const list = Array.isArray(reg && reg.plugins) ? reg.plugins : [];
    if (!list.length) return;

    const ok = [];
    for (const item of list) {
      try {
        const page = await this.loadPlugin(item);   // 串行：单个抛错只丢自己
        if (page) ok.push(page);
      } catch (e) {
        console.warn('[plugins] 加载失败，已跳过：' + ((item && item.name) || '(无名)'), e.message);
      }
    }
    if (!ok.length) return;

    // order 决定插件之间的先后；插件一律排在内置页之后，nav 项顺序须与 PAGES 一一对应
    ok.sort((a, b) => a.order - b.order);
    const nav = document.getElementById('nav');
    for (const page of ok) {
      PAGES.push(page);
      nav.appendChild(U.el('div', {
        class: 'nav-item', text: page.title,
        onclick: () => this.go(page.key)
      }));
    }
    console.log('[plugins] 已加载 ' + ok.length + ' 个：' + ok.map((p) => p.key).join(', '));
  },

  async loadPlugin(item) {
    const name = String((item && item.name) || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      console.warn('[plugins] 非法插件名，已跳过：', name || '(空)');
      return null;
    }

    const text = await fetchPluginURL(`plugins/${name}/index.js`, 'text');
    // 防呆：非空且含 window.Pages，否则不执行
    if (!text || !text.trim() || !text.includes('window.Pages')) {
      console.warn(`[plugins] ${name}/index.js 不合契约（须导出 window.Pages），已跳过`);
      return null;
    }
    new Function(text)();   // 内联执行：串行可控，语法/运行错在此抛出，被上层接住

    const page = window.Pages && window.Pages[name];
    if (!page || typeof page.render !== 'function') {
      console.warn(`[plugins] ${name} 未注册 window.Pages.${name} 或缺少 render()，已跳过`);
      return null;
    }

    // manifest 只用来核 title/order；缺失时回退注册表，再回退目录名
    let man = null;
    try {
      man = await fetchPluginURL(`plugins/${name}/manifest.json`, 'json');
    } catch (e) {
      console.warn(`[plugins] ${name}/manifest.json 读取失败，回退注册表信息：`, e.message);
    }
    const order = [man && man.order, item && item.order]
      .map(Number).find((n) => Number.isFinite(n));

    page.key = name;                                        // 路由键以目录名为准，防手写错
    page.title = (man && man.title) || (item && item.title) || name;
    page.order = order === undefined ? 900 : order;
    page.plugin = true;
    return page;
  },

  async reloadSettings() {
    try {
      State.settings = await API.settings();
    } catch (e) {
      State.settings = State.settings || {};
      U.toast('设置读取失败：' + e.message, 'err');
    }
  },

  async refreshSpot() {
    try {
      const sp = await API.spot();
      State.spot = sp;
      State.spotState = sp.fresh ? 'live' : 'stale';
      State.lastSpot = sp.t;
      this.renderQuote();
      // 广播最新现价：到价提醒（js/alerts.js）订阅 gs:spot 比对触发（仅成功路径）
      document.dispatchEvent(new CustomEvent('gs:spot', { detail: sp }));
    } catch (e) {
      State.spotState = 'err';
      this.renderQuote(e.message);
    }
    // 广播给当前页：顶栏与该页现货卡同用 State.spot，防同屏数字打架
    this.current?.onSpot?.();
  },

  renderQuote(err) {
    const host = document.getElementById('quoteStrip');
    U.clear(host);
    const sp = State.spot;

    const dotCls = State.spotState === 'live' ? 'live' : State.spotState === 'stale' ? 'stale' : 'err';
    host.appendChild(U.el('div', { class: 'qs' },
      U.el('span', { class: 'qs-label' },
        U.el('span', { class: 'dot ' + dotCls }),
        err ? '行情异常' : State.spotState === 'stale' ? '数据陈旧' : 'XAU/USD'),
      U.el('span', {
        class: 'qs-value mono',
        text: sp ? U.px(sp.price) : '--'
      })));

    if (sp && sp.prev_close) {
      const chg = sp.price - sp.prev_close;
      host.appendChild(U.el('div', { class: 'qs' },
        U.el('span', { class: 'qs-label', text: '较上次' }),
        U.el('span', { class: 'qs-value ' + U.cls(chg), text: U.signed(chg) })));
    }

    const st = State.stats;
    if (st) {
      host.appendChild(U.el('div', { class: 'qs' },
        U.el('span', { class: 'qs-label', text: '权益' }),
        U.el('span', { class: 'qs-value', text: U.fx(st.equity, 2) })));
      host.appendChild(U.el('div', { class: 'qs' },
        U.el('span', { class: 'qs-label', text: '浮动' }),
        U.el('span', { class: 'qs-value ' + U.cls(st.floating), text: U.money(st.floating) })));
    }
  },

  async refreshPositions() {
    try {
      const [ps, st] = await Promise.all([API.positions(), API.stats()]);
      State.positions = ps;
      State.stats = st;
      this.renderQuote();
    } catch { /* 忽略 */ }
  },

  go(key, opts) {
    const page = PAGES.find((p) => p.key === key) || PAGES[0];

    // 清理上一个
    if (this.current && this.current !== page) {
      this.current.destroy?.();
    }

    // 高亮导航
    U.$$('.nav-item').forEach((n, i) => {
      n.classList.toggle('active', PAGES[i] === page);
    });

    const view = U.clear(document.getElementById('view'));
    this.current = page;
    page.render(view, opts || {});
    page.tick?.(view);
    view.scrollTop = 0;
  }
};

window.addEventListener('DOMContentLoaded', () => {
  App.boot().catch((e) => {
    document.getElementById('view').innerHTML =
      '<div class="note err" style="margin:20px">启动失败：' + U.esc(e.message) + '</div>';
  });
});

/* ---------- 教练动态（行为层 · 顶栏入口）----------
 * 后端 agentd：GET /api/coach?since=<ms> → {ok,data:{items:[{ts,type,text}]}}。
 * 本模块只拉取与展示，不生成任何话术（话术归教练侧）；拿不到就明说离线。
 * 省请求：面板关着不轮询；打开即刻拉一次，此后每 30 秒一次；关闭即停。
 * 全部异常静默降级成「离线灰点」——绝不弹错、绝不刷 console。
 */
const COACH_TYPES = {
  loss_closed: { cls: 'down', label: '亏损平仓' },
  streak_win: { cls: 'up', label: '连胜' },
  alert_hit: { cls: 'gold', label: '到价提醒' },
  plan_created: { cls: 'blue', label: '交易计划' }
};

window.Coach = {
  BASE: 'http://127.0.0.1:8788',
  POLL_MS: 30000,
  TIMEOUT_MS: 4000,
  MAX: 50,

  _mounted: false,
  _open: false,
  _items: [],
  _since: 0,
  _timer: null,
  _busy: false,
  _flash: null,
  _state: 'idle',       // idle | loading | online | offline
  _painted: '',
  _refs: null,

  /** 运行时把入口插到顶栏「询问 AI」左侧（index.html 不动） */
  mount() {
    if (this._mounted) return;
    const bar = document.querySelector('.topbar');
    if (!bar) return;

    const dot = U.el('span', { class: 'coach-dot idle' });
    const btn = U.el('button', {
      class: 'btn sm coach-btn', id: 'coachBtn', type: 'button',
      title: '教练动态：按你的实盘记录给的提醒'
    }, '教练', dot);
    const status = U.el('span', { class: 'coach-st dim', text: '未连接' });
    const list = U.el('div', { class: 'coach-list' });
    const panel = U.el('div', { class: 'coach-panel' },
      U.el('div', { class: 'coach-head' },
        U.el('span', { text: '教练动态' }), status,
        U.el('button', { class: 'btn sm', text: '刷新', onclick: () => this.pull() })),
      list);
    const wrap = U.el('div', { class: 'coach-wrap', id: 'coachWrap' }, btn, panel);

    const ask = document.getElementById('askAiBtn');
    if (ask && ask.parentNode === bar) bar.insertBefore(wrap, ask);
    else bar.appendChild(wrap);

    btn.addEventListener('click', () => this.toggle());
    document.addEventListener('click', (e) => {
      if (this._open && !wrap.contains(e.target)) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._open) this.close();
    });

    this._refs = { btn, dot, status, list, panel, wrap };
    this._mounted = true;
    this.paintStatus();
    this.renderList();
  },

  toggle() { this._open ? this.close() : this.open(); },

  open() {
    if (!this._mounted) return;
    this._open = true;
    this._refs.panel.classList.add('on');
    this._refs.btn.classList.add('on');
    this.unflash();                                  // 人已看见，不必再闪
    this.pull();                                     // 打开即刻拉一次
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => this.pull(), this.POLL_MS);
  },

  close() {
    this._open = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }   // 关闭即停，省请求
    if (this._refs) {
      this._refs.panel.classList.remove('on');
      this._refs.btn.classList.remove('on');
    }
  },

  async pull() {
    if (this._busy) return;
    this._busy = true;
    if (this._state !== 'online') this.setState('loading');
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), this.TIMEOUT_MS);
    try {
      const res = await fetch(this.BASE + '/api/coach?since=' + this._since,
        { cache: 'no-store', signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (!j || j.ok !== true) throw new Error((j && j.error) || '响应异常');
      this.accept(j.data && j.data.items);
      this.setState('online');
    } catch {
      this.setState('offline');                      // 端点未上线/网络断：灰点，不报错
    } finally {
      clearTimeout(to);
      this._busy = false;
    }
  },

  /** 收条目：去重、倒序、封顶；面板关着且确有新条目才闪金边 */
  accept(items) {
    const arr = Array.isArray(items) ? items : [];
    let added = 0;
    for (const it of arr) {
      const ts = this.normTs(it && it.ts);
      const text = String((it && it.text) || '').trim();
      if (!ts || !text) continue;
      if (this._items.some((x) => x.ts === ts && x.text === text)) continue;
      this._items.push({ ts: ts, type: String((it && it.type) || '').trim() || 'event', text: text });
      if (ts > this._since) this._since = ts;
      added++;
    }
    if (!added) return;
    this._items.sort((a, b) => b.ts - a.ts);         // 新的在上
    if (this._items.length > this.MAX) this._items.length = this.MAX;
    if (!this._open) this.flash();
    this.renderList(true);
  },

  /** ts 防呆：契约是毫秒；对面若给秒级，自动 ×1000 */
  normTs(ts) {
    const n = Number(ts);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n < 1e11 ? n * 1000 : n);
  },

  setState(s) {
    if (this._state !== s) { this._state = s; this.paintStatus(); }
    this.renderList();
  },

  paintStatus() {
    const r = this._refs;
    if (!r) return;
    const s = this._state;
    r.dot.className = 'coach-dot ' + (s === 'online' ? 'online'
      : s === 'loading' ? 'loading' : s === 'offline' ? 'offline' : 'idle');
    r.status.textContent = (s === 'online' ? '在线' : s === 'loading' ? '拉取中…'
      : s === 'offline' ? '离线' : '未连接')
      + (s === 'online' && this._items.length ? ' · ' + this._items.length + ' 条' : '');
  },

  /** 只在内容或在线态变化时重建列表：轮询不打断用户滚动 */
  renderList(force) {
    const r = this._refs;
    if (!r) return;
    const key = this._items.length + '|' + this._state
      + '|' + (this._items[0] ? this._items[0].ts : 0);
    if (!force && key === this._painted) return;
    this._painted = key;

    U.clear(r.list);
    if (!this._items.length) {
      const online = this._state === 'online';
      // idle/loading 未定论：别抢在第一次拉取前就喊离线
      const pending = this._state === 'idle' || this._state === 'loading';
      r.list.appendChild(U.el('div', { class: 'coach-empty' },
        U.el('div', { text: online ? '教练在线，暂无动态'
          : pending ? '正在连接教练…' : '教练离线：本地服务未就绪' }),
        U.el('div', { class: 'dim', style: 'margin-top:4px;font-size:11px',
          text: online ? '你平仓、触发提醒时，教练会在这里说话。'
            : pending ? '' : '服务恢复后自动重连，无需操作。' })));
      return;
    }
    for (const it of this._items) {
      const t = COACH_TYPES[it.type] || { cls: 'dim', label: it.type };
      r.list.appendChild(U.el('div', { class: 'coach-row' },
        U.el('span', { class: 'coach-t', text: U.hhmmss(Math.floor(it.ts / 1000)).slice(0, 5) }),
        U.el('span', { class: 'coach-d ' + t.cls, title: t.label }),
        U.el('span', { class: 'coach-txt', text: it.text })));
    }
  },

  /** 新条目闪一下金边（1.5 秒） */
  flash() {
    const b = this._refs && this._refs.btn;
    if (!b) return;
    b.classList.add('flash');
    if (this._flash) clearTimeout(this._flash);
    this._flash = setTimeout(() => { b.classList.remove('flash'); this._flash = null; }, 1500);
  },

  unflash() {
    if (this._flash) { clearTimeout(this._flash); this._flash = null; }
    if (this._refs) this._refs.btn.classList.remove('flash');
  }
};