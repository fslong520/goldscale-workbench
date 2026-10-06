/* 复盘页：历史成交、盈亏曲线、逐笔明细 */

const PageReview = {
  key: 'review',
  title: '复盘',

  render(view) {
    // 重渲染前清空视图，否则旧内容会叠加，新页面被盖住
    U.clear(view);
    // 逐笔归因的状态：跨渲染保留，同一笔只烧一次 token
    this.attrCache = this.attrCache || new Map();   // tradeId -> AI 文案
    this.attrBusy = this.attrBusy || new Set();     // 进行中的 tradeId
    const page = U.el('div', { class: 'page' });
    const listHost = U.el('div', {});
    const curveHost = U.el('div', { class: 'chart-host', style: 'height:230px' });
    const statHost = U.el('div', { class: 'stats' });

    page.appendChild(U.el('div', { class: 'g-main' },
      U.el('div', { style: 'display:flex;flex-direction:column;gap:11px' },
        U.card('累计盈亏', curveHost),
        U.card('历史成交', listHost,
          U.el('button', { class: 'btn sm', text: '刷新', onclick: () => this.render(view) }))
      ),
      U.card('绩效概览', U.el('div', {},
        statHost,
        U.el('div', { class: 'note', style: 'margin-top:10px' },
          '说明：本页统计全部为本地模拟成交，不涉及任何真实账户或券商委托。')))
    ));
    view.appendChild(page);

    this.hosts = { listHost, curveHost, statHost };
    this.load();
  },

  async load() {
    const { listHost, curveHost, statHost } = this.hosts || {};
    if (!listHost || !listHost.isConnected) return;
    const s = State.settings;
    try {
      const [all, st] = await Promise.all([API.positions(), API.stats()]);

      // 统计块
      U.clear(statHost);
      statHost.append(
        U.stat('总成交', String(st.total_closed), '笔'),
        U.stat('胜率', U.fx(st.win_rate, 1) + '%', `${st.wins}/${st.wins + st.losses}`),
        U.stat('净盈亏', U.money(st.net_pnl), null, U.cls(st.net_pnl)),
        U.stat('总盈利', U.money(st.gross_profit), null, 'up'),
        U.stat('总亏损', U.money(st.gross_loss), null, 'down'),
        U.stat('平均盈利', U.money(st.avg_win), null, 'up'),
        U.stat('平均亏损', U.money(st.avg_loss), null, 'down'),
        U.stat('盈亏因子',
          st.total_closed === 0 ? '--' : (st.profit_factor == null ? '∞' : U.fx(st.profit_factor, 2)),
          st.total_closed === 0 ? '暂无成交' : (st.profit_factor == null ? '无亏损笔' : null),
          st.total_closed === 0 ? 'dim' : (st.profit_factor == null || st.profit_factor >= 1 ? 'up' : 'down'))
      );

      // 曲线
      Charts.equity(curveHost, all);

      // 明细
      U.clear(listHost);
      const closed = all.filter((p) => p.status === 'closed')
        .sort((a, b) => (b.closed_at || 0) - (a.closed_at || 0));

      if (!closed.length) {
        listHost.appendChild(U.el('div', { class: 'empty-tip', text: '还没有平仓记录' }));
        return;
      }

      // 行号索引：按钮回调只拿到成交对象，靠它回到表内那一行（详情行插在该行下方）
      this.rowIdx = new Map(closed.map((p, i) => [p.id, i]));
      this.attrBtns = new Map();

      const rows = closed.map((p) => {
        const isLong = p.direction === 'long';
        const ret = ((p.close_price || 0) - p.entry) / p.entry * 100 * (isLong ? 1 : -1);
        // 归因只挂在亏损行，盈利行留空格，列数保持对齐
        let attrCell = null;
        if ((p.pnl || 0) < 0) {
          const btn = U.el('button', {
            class: 'btn sm attr-btn', text: '归因',
            title: '让 AI 用一句话说清这笔为什么亏',
            onclick: () => this.runAttr(p)
          });
          this.attrBtns.set(p.id, btn);
          attrCell = btn;
        }
        return [
          U.el('span', { class: isLong ? 'up' : 'down', text: isLong ? '多' : '空' }),
          U.el('span', { text: U.fx(p.lot, 2) }),
          U.el('span', { text: U.px(p.entry) }),
          U.el('span', { text: U.px(p.close_price) }),
          U.el('span', { text: U.px(p.sl) }),
          U.el('span', { class: U.cls(p.pnl), text: U.money(p.pnl) }),
          U.el('span', { class: U.cls(ret), text: U.signed(ret) + '%' }),
          U.el('span', { class: 'dim', text: U.full(p.opened_at) }),
          U.el('span', { class: 'dim', text: U.full(p.closed_at) }),
          U.el('span', { class: 'dim', text: p.note || '' }),
          attrCell
        ];
      });

      const table = U.table([
        { label: '向' }, { label: '手数', num: true }, { label: '入场', num: true },
        { label: '出场', num: true }, { label: '原止损', num: true },
        { label: '盈亏', num: true }, { label: '幅度', num: true },
        { label: '开仓' }, { label: '平仓' }, { label: '备注' }, { label: '' }
      ], rows);
      this.tableEl = table;
      // 窄屏靠容器横向滚动看全表，不让 11 列把卡片/整页撑破
      listHost.appendChild(U.el('div', { class: 'review-tblwrap' }, table));
    } catch (e) {
      U.clear(listHost);
      listHost.appendChild(U.el('div', { class: 'note err', text: '加载失败：' + e.message }));
    }
  },

  /* ---------- 逐笔亏损归因（只有用户点按钮才发 AI，无自动批量） ---------- */

  /** 明细表第 idx 行；表格已重绘则返回 null，旧按钮回调自然失效 */
  rowAt(idx) {
    const t = this.tableEl;
    if (!t || !t.isConnected) return null;
    return t.querySelectorAll('tbody tr')[idx] || null;
  },

  /** 详情行挂载点：紧随成交行插入，已存在则复用，不叠加 */
  attrHost(p) {
    const idx = this.rowIdx ? this.rowIdx.get(p.id) : undefined;
    if (idx === undefined) return null;
    const tr = this.rowAt(idx);
    if (!tr) return null;
    const next = tr.nextElementSibling;
    if (next && next.classList && next.classList.contains('attr-row')) {
      return next.querySelector('.attr-box');
    }
    const box = U.el('div', { class: 'attr-box' });
    // 通栏整行留在表格内，跟着横向滚动，窄屏也不撑破
    tr.after(U.el('tr', { class: 'attr-row' }, U.el('td', { colspan: '11' }, box)));
    return box;
  },

  paintAttr(box, p, st) {
    if (!box || !box.isConnected) return;
    U.clear(box);
    box.appendChild(U.el('span', { class: 'chip', text: '归因' }));
    if (st.loading) {
      box.appendChild(U.el('span', { class: 'attr-text loading-dots', text: '分析中' }));
      return;
    }
    if (st.err) {
      box.appendChild(U.el('span', { class: 'attr-text' },
        U.el('span', { class: 'note err', style: 'display:inline-block;margin-right:8px',
          text: '归因失败：' + st.err }),
        U.el('button', { class: 'btn sm', text: '重试', onclick: () => this.runAttr(p) })));
      return;
    }
    box.appendChild(U.el('span', { class: 'attr-text', text: st.text }));
  },

  /** 归因提示词：说人话导向，一句话归因 + 一条针对性提醒 */
  attrPrompt(p) {
    const dir = p.direction === 'long' ? '做多' : '做空';
    const lot = p.opened_lot || p.lot || 0;
    return '以下是一笔亏损的黄金模拟交易，请用不超过 60 字的普通话一句话归因' +
      '（从这些常见原因里判：追高进场/逆势摸顶抄底/止损设太紧被扫/入场时机过早无确认/持仓过久回吐），' +
      '并给一条下次的针对性提醒。用大白话说，别用指标缩写和术语（如 M15、ATR、吞没、背离）。数据：方向' + dir +
      '，入场价 ' + U.px(p.entry) + '，平仓价 ' + U.px(p.close_price) +
      '，手数 ' + U.fx(lot, 2) + '，亏损 ' + U.money(p.pnl) +
      '，持仓时间段 ' + U.full(p.opened_at) + '→' + U.full(p.closed_at) +
      '，策略「' + (p.strategy_name || p.strategy_id || '未命名') + '」。' +
      '不要分点、不要标题、不要寒暄。';
  },

  syncAttrBtns() {
    if (!this.attrBtns) return;
    for (const [id, btn] of this.attrBtns) {
      const busy = this.attrBusy.has(id);
      btn.disabled = busy;
      btn.textContent = busy ? '分析中…' : '归因';
    }
  },

  async runAttr(p) {
    const box = this.attrHost(p);
    if (!box) return;
    // 命中缓存：秒出，不再发请求
    if (this.attrCache.has(p.id)) return this.paintAttr(box, p, { text: this.attrCache.get(p.id) });
    if (this.attrBusy.has(p.id)) return;
    this.attrBusy.add(p.id);
    this.paintAttr(box, p, { loading: true });
    this.syncAttrBtns();
    try {
      const sid = p.strategy_id || (State.settings && State.settings.active_strategy) || '';
      const r = await API.ai(this.attrPrompt(p), sid);
      const text = r && r.text ? String(r.text).trim() : '';
      if (!text) throw new Error('AI 未返回内容');
      this.attrCache.set(p.id, text);
      this.paintAttr(box, p, { text });
      // 归因入记忆：本产品的免疫力原料——记忆插件未开启时静默跳过，不弹错、不打断复盘
      this.saveAttr(p, text);
    } catch (e) {
      // 失败明说，绝不塞假归因
      const msg = e.message || '请求失败';
      this.paintAttr(box, p, { err: msg });
      U.toast('归因失败：' + msg, 'err');
    }
    this.attrBusy.delete(p.id);
    this.syncAttrBtns();
  },

  /* ---------- 归因落记忆（跨页契约：行情页计划卡拦截 + 行为周报都只读此格式） ----------
   * 格式（别改标题与 tags）：
   *   title = '亏损归因 <方向>@<入场价>'
   *   tags  = ['亏损归因', <策略名>]
   *   body  = AI 归因原文 + '（<方向> 入场<价> 平仓<价> 亏<金额>，策略<名>，<平仓时间>）'
   * 只在 AI 归因首次成功时存一次（缓存命中的重复点击不会再存）；
   * 记忆插件未开启 / 写入失败一律静默——不能因为记忆层坏了破坏复盘本身。 */
  saveAttr(p, text) {
    if (typeof API.memSave !== 'function') return;
    const dir = p.direction === 'long' ? '做多' : '做空';
    const style = p.strategy_name || p.strategy_id || '未命名';
    const body = text + '（' + dir + ' 入场' + U.px(p.entry) + ' 平仓' + U.px(p.close_price) +
      ' 亏' + U.money(p.pnl) + '，策略' + style + '，' + U.full(p.closed_at) + '）';
    API.memSave({
      title: '亏损归因 ' + dir + '@' + U.px(p.entry),
      body: body,
      tags: ['亏损归因', style]
    }).catch(() => { /* 记忆插件未开启：不存不提示 */ });
  },

  destroy() {
    this.hosts = null;
    this.tableEl = null;
    this.rowIdx = null;
    this.attrBtns = null;
    // 归因缓存保留到下次进页：重复点击不重复烧 token
  }
};