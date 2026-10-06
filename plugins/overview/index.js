/* 插件 · 总览（驾驶舱首页）
 * 契约：window.Pages.<目录名> = { key, title, home, render(view), destroy() }
 * home: true 让 js/app.js 启动时默认停留本页（插件缺失时自动退回「行情」）。
 * 数据全部来自现成 /api 接口：/api/spot、/api/stats、/api/positions、/api/ai/log、/api/settings。
 * 宁缺毋假：拿不到就 '--' 或空态，绝不编造；无值不冒充有值。
 * 加/改插件三步：① 建 plugins/<name>/ 两文件 ② 登记 plugins/index.json ③ node --check 自检
 */
window.Pages = window.Pages || {};

window.Pages.overview = {
  key: 'overview',
  title: '总览',
  home: true,
  _timer: null,

  render(view) {
    U.clear(view);
    const page = U.el('div', { class: 'page' });

    // 各卡片的数据挂载点：刷新时只重绘 body，避免整页闪动
    const spotHost = U.el('div', {});
    const acctHost = U.el('div', { class: 'stats' });
    const stratHost = U.el('div', {});
    const tradeHost = U.el('div', {});
    const quickHost = U.el('div', { class: 'btns', style: 'margin-top:2px' });
    this.h = { spotHost, acctHost, stratHost, tradeHost, quickHost };

    const refreshBtn = U.el('button', { class: 'btn sm gold', text: '刷新' });
    refreshBtn.addEventListener('click', () => this.load(refreshBtn));

    // ① 实时现货：全宽
    page.appendChild(U.card('实时现货', spotHost,
      [U.el('span', { class: 'chip', text: '15s 自动刷新' }), refreshBtn]));

    // ② / ③ 账户概览 + 生效策略与最新 AI 研判
    page.appendChild(U.el('div', { class: 'g2' },
      U.card('模拟盘账户', acctHost,
        U.el('button', { class: 'btn sm', text: '持仓页', onclick: () => App.go('positions') })),
      U.card('生效策略 · 最新研判', stratHost,
        U.el('button', { class: 'btn sm', text: '信号页', onclick: () => App.go('signal') }))));

    // ④ / ⑤ 最近平仓 + 功能快捷入口
    page.appendChild(U.el('div', { class: 'g2' },
      U.card('最近平仓', tradeHost,
        U.el('button', { class: 'btn sm', text: '复盘页', onclick: () => App.go('review') })),
      U.card('快捷入口', quickHost)));

    view.appendChild(page);

    this.renderQuick();
    this._loading = true;
    this.renderLoading();          // 先出占位骨架，避免空白
    this.load(refreshBtn);

    // 自动刷新；destroy 清掉，切页即停
    this._timer = setInterval(() => this.load(null, true), 15000);
  },

  /** 占位骨架：全部显示读取中，绝不用假数据撑场 */
  renderLoading() {
    const { spotHost, acctHost, stratHost, tradeHost } = this.h || {};
    if (!spotHost) return;
    U.clear(spotHost);
    spotHost.appendChild(this._statRow([['现货金价 (XAU/USD)', '--'], ['现货银价 (XAG/USD)', '--'], ['金银比', '--']]));
    U.clear(acctHost);
    acctHost.append(
      U.stat('权益', '--', '读取中…', 'dim'),
      U.stat('今日盈亏', '--', '读取中…', 'dim'),
      U.stat('今日可亏', '--', '读取中…', 'dim'),
      U.stat('持仓笔数', '--', '读取中…', 'dim'),
      U.stat('浮动盈亏', '--', '读取中…', 'dim'));
    U.clear(stratHost);
    stratHost.appendChild(U.el('div', { class: 'empty-tip', text: '读取中…' }));
    U.clear(tradeHost);
    tradeHost.appendChild(U.el('div', { class: 'empty-tip', text: '读取中…' }));
  },

  _statRow(items) {
    return U.el('div', { class: 'stats' },
      items.map(([l, v]) => U.stat(l, v, null, 'dim')));
  },

  async load(btn, silent = false) {
    if (btn) btn.disabled = true;
    try {
      // 生效策略取最新设置（不缓存，保证在策略页切换后回本页立即准确）
      let s = State.settings;
      try { s = await API.settings(); State.settings = s; } catch { /* 保留旧值 */ }
      s = s || {};
      const list = s.strategies || [];
      const act = list.find((x) => x.id === s.active_strategy) || list[0] || null;

      const tasks = [
        ['stats', API.stats()],
        ['pos', API.positions()],
        ['log', API.req('/api/ai/log?limit=1' + (act ? `&sid=${encodeURIComponent(act.id)}` : ''))]
      ];
      const settled = await Promise.all(tasks.map(async ([k, pr]) => {
        try { return [k, { v: await pr }]; }
        catch (e) { return [k, { e: e.message }]; }
      }));
      const R = Object.fromEntries(settled);
      const todayClosed = this.todayClosed(R.pos);

      this.renderSpot();                 // 现货不单独取，统一读 State.spot（与顶栏同源）
      this.renderAcct(R.stats, todayClosed, s);
      this.renderStrategy(act, R.log);
      this.renderTrades(R.pos, todayClosed);
    } finally {
      this._loading = false;
      if (btn) btn.disabled = false;
    }
  },

  /* ---------- ① 实时现货 ----------
   * 唯一数据源 State.spot / State.spotState（由 App.refreshSpot 维护），
   * 与顶栏 quoteStrip 同一次取数、同 prev_close 字段——同屏绝不再打架。
   * App.refreshSpot 完成后回调本页 onSpot()，实现两处同步刷新。 */
  renderSpot() {
    const { spotHost } = this.h || {};
    if (!spotHost || !spotHost.isConnected) return;
    U.clear(spotHost);

    const sp = State.spot;
    const failed = State.spotState === 'err';
    if (!sp || failed) {
      spotHost.appendChild(this._statRow([
        ['现货金价 (XAU/USD)', '--'], ['现货银价 (XAG/USD)', '--'], ['金银比', '--']]));
      spotHost.appendChild(U.el('div', { class: 'note', style: 'margin-top:9px' },
        U.el('span', { class: 'down', text: failed ? '现货读取失败' : '正在获取…' })));
      return;
    }

    const live = State.spotState === 'live';
    const chg = (sp.price !== null && sp.price !== undefined && sp.prev_close)
      ? sp.price - sp.prev_close : null;

    const g = U.stat('现货金价 (XAU/USD)', U.px(sp.price),
      chg === null ? (sp.source ? '来源 ' + sp.source : '') : '较上次 ' + U.signed(chg),
      chg === null ? 'mono' : 'mono ' + U.cls(chg));
    const row = U.el('div', { class: 'stats' },
      g,
      U.stat('现货银价 (XAG/USD)', U.px(sp.silver),
        sp.silver === null || sp.silver === undefined ? '上游未提供' : '美元/盎司', 'mono'),
      U.stat('金银比', sp.gold_silver_ratio === null || sp.gold_silver_ratio === undefined
        ? '--' : U.fx(sp.gold_silver_ratio, 2), '金价 / 银价', 'mono'));
    spotHost.appendChild(row);

    spotHost.appendChild(U.el('div', { class: 'note', style: 'margin-top:9px' },
      U.el('span', { class: live ? 'up' : 'down', text: live ? '● 数据正常' : '● 数据陈旧' }),
      U.el('span', { style: 'margin-left:12px' },
        '更新时间 ' + (sp.t ? U.full(sp.t) : '--') + (sp.t ? '（' + U.ago(sp.t) + '）' : '')),
      U.el('span', { style: 'margin-left:12px', class: 'dim' },
        '来源 ' + (sp.source || '--'))));
  },

  /** App.refreshSpot 广播：顶栏更新后同步重绘现货卡，保证同屏同值 */
  onSpot() {
    if (this.h) this.renderSpot();
  },

  /* ---------- ② 账户概览 ---------- */
  renderAcct(r, todayClosed, s) {
    const { acctHost } = this.h || {};
    if (!acctHost || !acctHost.isConnected) return;
    U.clear(acctHost);
    if (!r || r.e || !r.v) {
      acctHost.appendChild(U.el('div', { class: 'note err', text: '账户读取失败：' + (r && r.e ? r.e : '无数据') }));
      return;
    }
    const st = r.v;
    // 交易笔数一律取「今日已平仓数」，与「最近平仓」卡同源同口径（均出自 /api/positions）
    const cnt = todayClosed === null ? '今日盈亏' : `今日平仓 ${todayClosed} 笔`;
    acctHost.append(
      U.stat('权益', U.fx(st.equity, 2), '余额 ' + U.fx(st.balance, 2)),
      U.stat('今日盈亏', U.money(st.daily_pnl), cnt, U.cls(st.daily_pnl)),
      this.budgetStat(st, s),
      U.stat('持仓笔数', String(st.open_count),
        st.open_count > 0 ? '有持仓' : '空仓', st.open_count > 0 ? '' : 'dim'),
      U.stat('浮动盈亏', U.money(st.floating), null, U.cls(st.floating)));
  },

  /** 今日可亏（钱口径，与风控页、开仓表单同式）：剩余额度 > 0 绿、= 0 红。
   *  字段缺失、0=关、无数据一律 '--' 加原因，绝不编数。 */
  budgetStat(st, s) {
    const b = window.Behavior?.todayBudget?.(st, s && s.risk, s && s.equity);
    if (!b || !b.ok) {
      const why = b ? b.why : 'nodata';
      return U.stat('今日可亏', '--',
        why === 'off' ? '未启用每日亏损预算'
          : why === 'missing' ? '服务端未提供该字段' : '暂无数据', 'dim');
    }
    return U.stat('今日可亏', U.fx(b.remaining, 2), window.Behavior.budgetNote(b),
      b.remaining > 0 ? 'up' : 'down');
  },

  /** 今日已平仓笔数：与「最近平仓」同一份 /api/positions，取本地日历日。
   *  入参为 {e}/{v} 信封；不可用时返回 null，调用方显示中性文案、不放数字。 */
  todayClosed(r) {
    if (!r || r.e || !Array.isArray(r.v)) return null;
    const p2 = (x) => String(x).padStart(2, '0');
    const key = (ts) => {
      const d = new Date(ts * 1000);
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    };
    const today = key(Date.now() / 1000);
    return r.v.filter((x) => x.status === 'closed' && x.closed_at && key(x.closed_at) === today).length;
  },

  /* ---------- ③ 生效策略 + 最新 AI 研判 ---------- */
  renderStrategy(act, r) {
    const { stratHost } = this.h || {};
    if (!stratHost || !stratHost.isConnected) return;
    U.clear(stratHost);

    // 策略块（同持仓页口径行，数据源 settings）
    if (!act) {
      stratHost.appendChild(U.el('div', { class: 'empty-tip', text: '尚未配置策略：请到策略页新建并保存。' }));
    } else {
      stratHost.append(
        U.el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
          U.el('b', { style: 'color:var(--fg);font-size:15px', text: act.name }),
          U.el('span', { class: 'chip' + (act.enabled ? ' on' : ''), text: act.enabled ? '生效' : '停用' }),
          U.el('span', { class: 'dim mono', style: 'font-size:11px', text: act.id })),
        U.el('div', { class: 'dim', style: 'font-size:11px;margin-top:9px' },
          `执行 ${U.ivLabel(act.exec_interval)} · 定方向 ${U.ivLabel(act.dir_interval)} · 确认 ${U.ivLabel(act.confirm_interval)}` +
          ` · 盈亏比 ≥ ${U.fx(act.rr_min, 1)} · 风险 ${U.fx(act.risk_percent, 1)}%`));
    }

    stratHost.appendChild(U.el('div', { style: 'border-top:1px solid var(--line-2);margin:11px 0' }));

    // 最新 AI 研判摘要（读现成 /api/ai/log，不在此触发新研判）
    if (!r || r.e) {
      stratHost.appendChild(U.el('div', { class: 'note err', text: 'AI 研判记录读取失败：' + (r && r.e ? r.e : '无数据') }));
      return;
    }
    const items = Array.isArray(r.v) ? r.v : [];
    const e = items[0];
    if (!e) {
      stratHost.appendChild(U.el('div', { class: 'empty-tip' },
        U.el('div', { text: '该策略暂无 AI 研判记录' }),
        U.el('div', { style: 'margin-top:6px;font-size:11px', text: '到信号页对该策略发起一次研判后，这里会显示方向与信心。' })));
      return;
    }

    const dir = e.direction || 'none';
    const label = dir === 'long' ? '看多' : dir === 'short' ? '看空' : '观望';
    const cls = dir === 'long' ? 'up' : dir === 'short' ? 'down' : 'dim';
    const conf = typeof e.confidence === 'number' ? Math.max(0, Math.min(100, e.confidence)) : 0;
    const hasConf = conf > 0;   // 0/缺失视为「无读数」，不摆成未初始化的 0/100

    stratHost.appendChild(U.el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
      U.el('span', { class: cls, style: 'font-size:16px;font-weight:600', text: label }),
      hasConf ? null : U.el('span', { class: 'dim mono', style: 'font-size:16px', text: '—' }),
      e.style ? U.el('span', { class: 'chip', text: e.style }) : null,
      U.el('span', { class: 'dim', style: 'font-size:11px;margin-left:auto' },
        (e.sname ? e.sname + ' · ' : '') + (e.t ? U.full(e.t) + '（' + U.ago(e.t) + '）' : '时间未知'))));

    // 信心条：为 0 时走「—」中性样式，不显示 0 / 100
    stratHost.appendChild(U.el('div', { class: 'conf-wrap', title: hasConf ? '' : '本次研判未给出信心读数' },
      U.el('div', { class: 'conf-top' },
        U.el('span', { class: hasConf ? '' : 'dim', text: '信心' }),
        U.el('span', { class: 'mono' + (hasConf ? '' : ' dim'), text: hasConf ? U.fx(conf, 0) + ' / 100' : '—' })),
      U.el('div', { class: 'conf-bar' }, U.el('div', { class: 'conf-fill', style: 'width:' + (hasConf ? conf : 0) + '%' }))));

    if (e.summary) {
      stratHost.appendChild(U.el('div', { class: 'note', style: 'margin-top:9px', text: e.summary }));
    } else {
      stratHost.appendChild(U.el('div', { class: 'note dim', style: 'margin-top:9px', text: '本次研判无摘要文本。' }));
    }
    if (e.ai_error) {
      stratHost.appendChild(U.el('div', { class: 'note err', style: 'margin-top:8px', text: 'AI 错误：' + e.ai_error }));
    }
  },

  /* ---------- ④ 最近平仓 ---------- */
  renderTrades(r, todayClosed) {
    const { tradeHost } = this.h || {};
    if (!tradeHost || !tradeHost.isConnected) return;
    U.clear(tradeHost);
    if (!r || r.e || !r.v) {
      tradeHost.appendChild(U.el('div', { class: 'note err', text: '交易记录读取失败：' + (r && r.e ? r.e : '无数据') }));
      return;
    }
    const closed = (r.v || []).filter((p) => p.status === 'closed')
      .sort((a, b) => (b.closed_at || 0) - (a.closed_at || 0));
    if (!closed.length) {
      tradeHost.appendChild(U.el('div', { class: 'empty-tip', text: '还没有平仓记录' }));
      return;
    }
    const recent = closed.slice(0, 5);
    const net = recent.reduce((a, p) => a + (p.pnl || 0), 0);
    tradeHost.appendChild(U.el('div', { class: 'dim', style: 'font-size:11px;margin-bottom:9px' },
      (todayClosed === null ? '' : `今日平仓 ${todayClosed} 笔 · `),
      `累计 ${closed.length} 笔 · 最近 ${recent.length} 笔合计 `,
      U.el('span', { class: U.cls(net), text: U.money(net) })));

    const rows = recent.map((p) => {
      const isLong = p.direction === 'long';
      return [
        { v: U.full(p.closed_at), cls: 'dim' },
        { v: p.strategy_name || '—', cls: p.strategy_name ? '' : 'dim' },
        { v: isLong ? '多' : '空', cls: isLong ? 'up' : 'down' },
        { v: U.money(p.pnl), num: true, cls: U.cls(p.pnl) }
      ];
    });
    tradeHost.appendChild(U.table([
      { label: '平仓时间' }, { label: '策略' }, { label: '方向' }, { label: '盈亏', num: true }
    ], rows));
  },

  /* ---------- ⑤ 快捷入口 ---------- */
  renderQuick() {
    const { quickHost } = this.h || {};
    if (!quickHost) return;
    U.clear(quickHost);
    // 内置页存在才给出入口；插件页（含本页）不列，避免自指
    const entries = [
      ['watch', '行情'], ['signal', '信号'], ['positions', '持仓'],
      ['review', '复盘'], ['strategy', '策略'], ['risk', '风控'], ['settings', '设置']
    ];
    const builtin = (typeof PAGES !== 'undefined' ? PAGES : []).filter((p) => !p.plugin);
    for (const [key, label] of entries) {
      if (!builtin.some((p) => p.key === key)) continue;
      quickHost.appendChild(U.el('button', {
        class: 'btn sm', text: label, onclick: () => App.go(key)
      }));
    }
    if (!quickHost.childNodes.length) {
      quickHost.appendChild(U.el('div', { class: 'empty-tip', text: '暂无可跳转页面' }));
    }
  },

  destroy() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.h = null;
  }
};
