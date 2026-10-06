/* 投研回测 tab：嵌在「策略」页里的第二个 tab
 * （参数 → 绩效指标 → 权益曲线 + 回撤 → 月度收益 → 逐笔明细；另有多策略对比模式）
 *
 * 由 js/pages/strategy.js 在切到「投研回测」时 ResearchTab.mount(host)，切走时 ResearchTab.unmount()。
 * 数据来源只有 POST /api/backtest 一条路，接口失败即明示失败——本视图不做假数据兜底。
 * 契约 v2（字段名锁定，旧字段保留）：
 *   req → {strategy_id, interval, bars, initial_equity,
 *          commission_rate: 单边佣金%, 默认 0.02, slippage: 美元/盎司, 默认 0.1}
 *   data → {strategy_id, strategy_name, interval, bars_used, from, to, initial_equity,
 *            metrics:{total_return_pct, annual_return_pct, sharpe, sortino, calmar, max_drawdown_pct,
 *                     win_rate_pct, profit_factor, trades, expectancy_r, avg_hold_bars},
 *            equity:[{t,v}], benchmark:[{t,v}],
 *            monthly:[{ym, ret_pct}],
 *            drawdown:[{t,pct}],                       // pct ≤ 0，水下回撤 %
 *            costs:{commission, slippage, spread},
 *            trades:[{t_open,t_close,direction,entry,exit,pnl,bars,open_reason,close_reason,
 *                     r_multiple, exit_reason, commission, slippage}]}
 * 后端未升级时 v2 字段缺失：对应区块整块不渲染，不用假数据补位。
 *
 * 参数优化（网格扫描，另一条端点；字段名锁定）：
 *   POST /api/backtest/optimize
 *   req → {strategy_id, interval, bars, commission_rate, slippage,
 *          grid:{confidence_floor|rr_min|ema_period|trend_ema_period:[值, …]}}
 *         每键 1..=8 个值、组合总数 ≤200，违规由后端报错（error 文案直显，前端不兜底）
 *   data → {combos:[{params, total_return_pct, sharpe, max_drawdown_pct, win_rate_pct, trades}],
 *           tried}
 *         combos 已按 total_return_pct 降序，前端只补序号与 top1 标记。
 *
 * 研究笔记（把结论沉淀进记忆，研究是连续剧不是单集）：
 *   写 POST /api/memory {title, body, tags}；读 API.memList('回测研究')；
 *   删 DELETE /api/memory/:id（二次确认）。记忆插件未开启时后端回「记忆插件未开启」，
 *   本视图只提示（不刷屏、不造假数据），提示语指路设置页。
 *   title 格式 `回测研究 <策略名> <周期> <bars>根 总收益<X%>`（优化结论后缀 ` ·优化<参数摘要>`），
 *   body 走【前因】【行为】【后果】三标——与 AGENTS.override.md 的格式契约一致。
 */

const ResearchTab = {
  /* ---------- 状态 ---------- */
  // 上次运行参数：切 tab 返回后仍在
  params: {
    strategy_id: '', interval: '1h', bars: 500, initial_equity: 10000,
    commission_rate: 0.02, slippage: 0.1
  },
  stratCache: null,   // /api/strategies 兜底结果，settings 缺策略时复用
  mode: 'single',     // 'single' 单策略 | 'compare' 多策略对比
  running: false,
  result: null,       // 最近一次成功的单策略回测响应
  error: null,        // 单策略失败文案（与 result 互斥）
  cmp: null,          // {total, done, results:[{id,name,ok,data,error}], error}
  chart: null,        // 权益图
  ddChart: null,      // 回撤图
  opt: null,          // 参数优化卡状态（见 optState()）
  optNodes: null,     // 优化卡活节点 {btn, hint, clock}
  optResultHost: null,
  _onResize: null,
  _seq: 0,            // 运行序号：新一次运行令旧循环作废
  _progress: '',      // 对比进度文案
  IV_MIN: { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 },

  /* ---------- 骨架 ---------- */
  /** 挂到 host（策略页「投研回测」面板）；可重复挂载，参数与上次结果由模块状态恢复 */
  mount(host, opts = {}) {
    U.clear(host);
    this.disposeChart();
    if (opts && opts.interval) this.params.interval = opts.interval;

    const s = State.settings || {};
    const src = (s.strategies && s.strategies.length) ? s.strategies : (this.stratCache || []);
    const list = src.map((x) => ({
      id: x.id, name: x.name, enabled: x.enabled !== false
    }));
    // 默认策略：上次选中的 → 当前生效的 → 第一条
    if (!list.some((x) => x.id === this.params.strategy_id)) {
      this.params.strategy_id = list.some((x) => x.id === s.active_strategy)
        ? s.active_strategy : (list[0]?.id || '');
    }

    const page = U.el('div', { class: 'page' });

    // ---- 参数区 ----
    const stratSel = U.sel(this.params.strategy_id, list.map((x) => [x.id, this.optLabel(x)]));
    stratSel.addEventListener('change', () => { this.params.strategy_id = stratSel.value; });

    const ivOpts = [['5m', 'M5'], ['15m', 'M15'], ['1h', 'H1'], ['4h', 'H4'], ['1d', 'D1']];
    const ivSel = U.sel(this.params.interval, ivOpts);
    ivSel.addEventListener('change', () => { this.params.interval = ivSel.value; });

    const barsSel = U.sel(String(this.params.bars), [[300, '300 根'], [500, '500 根'], [1000, '1000 根'], [2000, '2000 根']]);
    barsSel.addEventListener('change', () => { this.params.bars = parseInt(barsSel.value, 10) || 500; });

    const eqIn = U.numInput(this.params.initial_equity, { step: '100', min: '100' });
    eqIn.addEventListener('change', () => {
      this.params.initial_equity = parseFloat(eqIn.value) || 10000;
    });

    // 成本假设：随「运行回测」一起提交给后端
    const cIn = U.numInput(this.params.commission_rate, { step: '0.01', min: '0' });
    cIn.addEventListener('change', () => { this.params.commission_rate = parseFloat(cIn.value); });
    const slIn = U.numInput(this.params.slippage, { step: '0.01', min: '0' });
    slIn.addEventListener('change', () => { this.params.slippage = parseFloat(slIn.value); });

    const runBtn = U.el('button', { class: 'btn gold', text: '运行回测' });
    runBtn.addEventListener('click', () => this.run());

    const cmpBtn = U.el('button', { class: 'btn', text: '对比全部启用策略' });
    cmpBtn.addEventListener('click', () => this.runCompare());
    const progressEl = U.el('span', { class: 'dim mono', style: 'font-size:11px' });

    // 「历史研究」入口：读记忆里的「回测研究」笔记，接上一轮结论继续验证
    const histBtn = U.el('button', { class: 'btn sm', text: '历史研究',
      title: '读本机记忆里的「回测研究」笔记：看上次结论、接着跑一次' });
    histBtn.addEventListener('click', () => this.toggleNotes());

    page.appendChild(U.card('回测参数', U.el('div', {},
      U.el('div', {
        style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));' +
          'gap:11px;align-items:end'
      },
        U.field('策略', stratSel),
        U.field('周期', ivSel),
        U.field('K 线根数', barsSel),
        U.field('初始资金（美元）', eqIn),
        U.field('佣金（单边 %）', cIn),
        U.field('滑点（美元/盎司）', slIn)),
      U.el('div', { class: 'row', style: 'margin-top:10px' },
        runBtn,
        cmpBtn,
        progressEl,
        U.el('span', { class: 'dim', style: 'font-size:11px',
          text: '按该策略的定方向 / 执行 / 确认周期逐根复盘；对比模式串行回测每条启用策略' }))),
      histBtn));

    // ---- 历史研究 · 研究笔记（再挂载时保持上次开合状态由模块状态恢复） ----
    const histHost = U.el('div', {});
    page.appendChild(histHost);

    // 策略列表为空（settings 缺失）时才去问后端，避免无谓请求
    if (!list.length) {
      stratSel.appendChild(U.el('option', { value: '', text: '策略列表读取中…' }));
      stratSel.disabled = true;
      this.fetchStrategies(stratSel);
    }

    // ---- 结果区 ----
    const resultHost = U.el('div', {});
    page.appendChild(resultHost);

    // ---- 参数优化 · 网格扫描（独立于主回测结果：单策略 / 对比两种模式下都可用） ----
    const optHost = U.el('div', { style: 'display:flex;flex-direction:column;gap:11px' });
    page.appendChild(optHost);

    host.appendChild(page);

    optHost.appendChild(this.buildOptCard());
    const optResultHost = U.el('div', { style: 'display:flex;flex-direction:column;gap:11px' });
    optHost.appendChild(optResultHost);
    this.optResultHost = optResultHost;

    this.hosts = { resultHost, runBtn, cmpBtn, progressEl, host, histBtn, histHost };
    this.histHost = histHost;

    this.syncButton();
    this.syncHistBtn();
    this.renderNotes();
    this.renderResult();
    // 扫描中切走再回来：秒表接着走，节点重新对上新卡
    if (this.optState().running) this.startOptTimer();
    this.syncOpt();
    this.renderOpt();
  },

  optLabel: (x) => x.name + (x.enabled ? '' : '（已停用）'),

  /** 兜底取策略列表：当前版本策略随 /api/settings 下发，后端若有独立端点则用它 */
  async fetchStrategies(sel) {
    let arr = [];
    try {
      const d = await API.req('/api/strategies');
      arr = (Array.isArray(d) ? d : (d && d.strategies) || []).map((x) => ({
        id: x.id, name: x.name, enabled: x.enabled !== false
      }));
    } catch { arr = []; }
    this.stratCache = arr;
    if (!sel.isConnected) return;
    U.clear(sel);
    if (!arr.length) {
      sel.appendChild(U.el('option', { value: '', text: '策略不可用' }));
      sel.disabled = true;
      return;
    }
    for (const it of arr) sel.appendChild(U.el('option', { value: it.id, text: this.optLabel(it) }));
    this.params.strategy_id = arr[0].id;
    sel.value = arr[0].id;
    sel.disabled = false;
  },

  /** 有效策略列表（settings 优先，兜底缓存） */
  strategies() {
    const s = State.settings || {};
    const src = (s.strategies && s.strategies.length) ? s.strategies : (this.stratCache || []);
    return src.map((x) => ({ id: x.id, name: x.name, enabled: x.enabled !== false }));
  },

  /** 校验并取回本次请求参数（成本假设）；不合法返回 null 并已 toast */
  requestPayload(strategyId) {
    const p = this.params;
    const bars = parseInt(p.bars, 10) || 500;
    const eq = parseFloat(p.initial_equity);
    const cr = parseFloat(p.commission_rate);
    const sl = parseFloat(p.slippage);
    if (!(eq > 0)) { U.toast('初始资金需大于 0', 'err'); return null; }
    if (!Number.isFinite(cr) || cr < 0) { U.toast('佣金需为不小于 0 的数值（单边 %）', 'err'); return null; }
    if (!Number.isFinite(sl) || sl < 0) { U.toast('滑点需为不小于 0 的数值（美元/盎司）', 'err'); return null; }
    return {
      strategy_id: strategyId, interval: p.interval, bars, initial_equity: eq,
      commission_rate: cr, slippage: sl
    };
  },

  /* ---------- 运行（单策略） ---------- */
  async run() {
    if (this.running) return;
    if (!this.params.strategy_id) { U.toast('请先选择策略', 'err'); return; }
    const payload = this.requestPayload(this.params.strategy_id);
    if (!payload) return;

    const seq = ++this._seq;
    this.mode = 'single';
    this.cmp = null;
    this.running = true;
    this.error = null;
    this._progress = '';
    this.syncButton();
    this.renderResult();

    try {
      const d = await API.backtest(payload);
      if (!d || !d.metrics || !Array.isArray(d.equity)) {
        throw new Error('回测响应缺少 metrics / equity 字段');
      }
      if (seq !== this._seq) return;   // 期间又发起了新运行
      this.result = d;
    } catch (e) {
      if (seq !== this._seq) return;
      this.result = null;
      this.error = (e && e.message) || '未知错误';
      U.toast('回测失败：' + this.error, 'err');
    } finally {
      if (seq !== this._seq) return;
      this.running = false;
      this.syncButton();
      this.renderResult();
    }
  },

  /* ---------- 运行（多策略对比：串行，每条间隔 800ms） ---------- */
  async runCompare() {
    if (this.running) return;
    // 先校验成本参数，再取启用列表
    const probe = this.requestPayload(this.params.strategy_id || '__probe__');
    if (!probe) return;
    const en = this.strategies().filter((x) => x.enabled);
    if (!en.length) { U.toast('没有已启用的策略可比对', 'err'); return; }
    if (en.length < 2) { U.toast('仅 1 条启用策略，无需对比', 'err'); return; }

    const seq = ++this._seq;
    this.mode = 'compare';
    this.running = true;
    this.error = null;
    this.cmp = { total: en.length, done: 0, results: [], error: null };
    this._progress = '';
    this.syncButton();
    this.renderResult();

    for (let i = 0; i < en.length; i++) {
      if (seq !== this._seq) return;           // 被新运行 / 卸载顶掉
      const st = en[i];
      this._progress = `正在回测 ${i + 1}/${en.length}…（${st.name}）`;
      this.syncButton();
      const payload = Object.assign(this.requestPayload(st.id) || {}, { strategy_id: st.id });
      try {
        const d = await API.backtest(payload);
        if (seq !== this._seq) return;
        if (!d || !d.metrics || !Array.isArray(d.equity)) {
          throw new Error('响应缺少 metrics / equity 字段');
        }
        this.cmp.results.push({ id: st.id, name: st.name, ok: true, data: d });
      } catch (e) {
        if (seq !== this._seq) return;
        this.cmp.results.push({
          id: st.id, name: st.name, ok: false, error: (e && e.message) || '未知错误'
        });
      }
      this.cmp.done = i + 1;
      // 每条之间留 800ms，避免把后端与行情源打满
      if (i < en.length - 1) await new Promise((r) => setTimeout(r, 800));
    }
    if (seq !== this._seq) return;

    const bad = this.cmp.results.filter((r) => !r.ok);
    if (bad.length === this.cmp.results.length) {
      this.cmp.error = '全部策略回测失败：' + bad[0].error;
      U.toast('对比回测失败', 'err');
    } else if (bad.length) {
      U.toast(`${bad.length} 条策略回测失败`, 'err');
    }
    this.running = false;
    this._progress = '';
    this.syncButton();
    this.renderResult();
  },

  syncButton() {
    const h = this.hosts;
    if (!h) return;
    const b = h.runBtn;
    if (b && b.isConnected) {
      b.disabled = this.running;
      b.textContent = (this.running && this.mode === 'single') ? '回测中…' : '运行回测';
    }
    const c = h.cmpBtn;
    if (c && c.isConnected) {
      c.disabled = this.running;
      c.textContent = (this.running && this.mode === 'compare') ? '对比中…' : '对比全部启用策略';
    }
    const pr = h.progressEl;
    if (pr && pr.isConnected) pr.textContent = this._progress || '';
    if (this._loadProg && this._loadProg.isConnected) this._loadProg.textContent = this._progress || '';
  },

  /* ---------- 结果渲染 ---------- */
  renderResult() {
    const h = this.hosts;
    if (!h || !h.resultHost || !h.resultHost.isConnected) return;
    const host = h.resultHost;
    this.disposeChart();
    U.clear(host);

    if (this.running) {
      const txt = this.mode === 'compare'
        ? '正在串行回测各条启用策略，每条之间间隔 800ms'
        : '回测中，正在复盘历史 K 线';
      const title = this.mode === 'compare' ? '多策略对比' : '回测报告';
      const prog = this.mode === 'compare'
        ? U.el('div', { class: 'dim mono', style: 'font-size:11px;text-align:center;margin-top:8px',
            text: this._progress })
        : null;
      this._loadProg = prog;
      host.appendChild(U.card(title, U.el('div', {},
        U.el('div', { class: 'chart-loading loading-dots', text: txt }), prog)));
      return;
    }
    this._loadProg = null;

    if (this.mode === 'compare') { this.renderCompare(host); return; }

    if (this.error) {
      host.appendChild(this.errorCard('回测失败：' + this.error, () => this.run()));
      return;
    }

    if (!this.result) { host.appendChild(this.emptyCard()); return; }

    // 图表必须在节点入 DOM 之后再 init，否则拿不到容器宽度
    const node = this.reportCard(this.result);
    host.appendChild(node.el);
    if (host.isConnected) node.after();
  },

  /** 失败卡（回测 / 参数优化共用同一形态；标题与说明可用 opts 覆盖） */
  errorCard(msg, onRetry, opts = {}) {
    const retry = U.el('button', { class: 'btn sm gold', text: '重试' });
    retry.addEventListener('click', onRetry);
    return U.card(opts.title || '回测报告', U.el('div', {},
      U.el('div', { class: 'note err', style: 'display:flex;align-items:center;gap:8px' },
        U.el('span', { style: 'font-size:14px;line-height:1', text: '⚠' }),
        U.el('span', { style: 'flex:1', text: msg })),
      U.el('div', { class: 'note', style: 'margin-top:10px' },
        opts.note || '这里不做假数据兜底：请确认本机后端 /api/backtest 可用、' +
          '所选策略与周期有足够历史 K 线。'),
      U.el('div', { class: 'btns', style: 'margin-top:10px' }, retry)));
  },

  emptyCard() {
    return U.card('回测报告', U.el('div', { style: 'padding:40px 20px;text-align:center' },
      U.el('div', { style: 'font-size:24px;color:var(--gold-dim);margin-bottom:12px', text: '◈' }),
      U.el('div', { style: 'font-size:13px;color:var(--fg-2)',
        text: '选择参数后运行回测，用真实历史 K 线复盘该策略' }),
      U.el('div', { style: 'font-size:12px;color:var(--fg-3);margin-top:8px',
        text: '输出：权益曲线 · 水下回撤 · 十项绩效指标 · 月度收益 · 逐笔交易明细' })));
  },

  /* ---------- 单策略报告 ---------- */
  /** 拼装报告：返回 {el, after}，图表由调用方在入 DOM 后 init */
  reportCard(d) {
    const m = d.metrics || {};
    const init = d.initial_equity ?? this.params.initial_equity;
    const trades = Array.isArray(d.trades) ? d.trades : [];
    const sid = d.strategy_id || this.params.strategy_id;
    const sname = d.strategy_name
      || (State.settings?.strategies || []).find((x) => x.id === sid)?.name || sid;

    const wrap = U.el('div', { style: 'display:flex;flex-direction:column;gap:11px' });

    // --- 元信息 ---
    const rangeTxt = (d.from != null && d.to != null)
      ? `${U.mdhm(d.from)} ~ ${U.mdhm(d.to)}` : '区间未知';
    const meta = U.el('div', { class: 'row', style: 'gap:6px;margin-bottom:10px' },
      U.el('span', { class: 'chip on', text: sname }),
      U.el('span', { class: 'chip', text: U.ivLabel(d.interval || this.params.interval) }),
      U.el('span', { class: 'chip', text: `${d.bars_used ?? this.params.bars} 根` }),
      U.el('span', { class: 'chip mono', text: rangeTxt,
        title: (d.from != null && d.to != null) ? `${U.full(d.from)} ~ ${U.full(d.to)}` : '' }),
      U.el('div', { class: 'spacer' }),
      U.el('span', { class: 'dim mono', style: 'font-size:11px', text: `初始 ${U.fx(init, 0)}` }));

    // --- 十项指标（网格自适应换行，不挤爆） ---
    // 最大回撤统一按负数展示（后端若给正幅值也能读对）；盈亏比 >100 视为哨兵值
    const dd = m.max_drawdown_pct == null ? null : -Math.abs(m.max_drawdown_pct);
    const pf = m.profit_factor;
    const pfTxt = pf == null ? '--' : (!Number.isFinite(pf) || pf > 100 ? '∞' : U.fx(pf, 2));
    const stats = U.el('div', { class: 'stats' });
    // 每张卡统一三行结构（标签/数值/含义），下缘齐平，扫读时不必猜指标含义
    stats.append(
      U.stat('总收益', m.total_return_pct == null ? '--' : U.fx(m.total_return_pct, 2) + '%',
        '相对初始资金', U.cls(m.total_return_pct)),
      U.stat('年化收益', m.annual_return_pct == null ? '--' : U.fx(m.annual_return_pct, 2) + '%',
        '折算到年度', U.cls(m.annual_return_pct)),
      U.stat('夏普比率', U.fx(m.sharpe, 2), '波动调整后收益', U.cls(m.sharpe)),
      U.stat('索提诺比率', U.fx(m.sortino, 2), '下行波动调整', U.cls(m.sortino)),
      U.stat('卡玛比率', U.fx(m.calmar, 2), '年化 / 最大回撤', U.cls(m.calmar)),
      U.stat('最大回撤', dd == null ? '--' : U.fx(dd, 2) + '%', '峰值到谷底',
        dd == null ? 'dim' : 'down'),
      U.stat('胜率', m.win_rate_pct == null ? '--' : U.fx(m.win_rate_pct, 1) + '%',
        '盈利笔数占比', ''),
      U.stat('盈亏比', pfTxt, '总盈利 / 总亏损', pf == null ? 'dim' : (pf >= 1 ? 'up' : 'down')),
      U.stat('交易次数', U.fx(m.trades, 0),
        m.avg_hold_bars != null ? '均持仓 ' + U.fx(m.avg_hold_bars, 1) + ' 根' : '完整平仓笔数', ''),
      U.stat('期望值', m.expectancy_r == null ? '--' : U.fx(m.expectancy_r, 2) + 'R', '每笔预期',
        U.cls(m.expectancy_r))
    );

    // --- 成本汇总行：跟在指标卡网格之后，同属「绩效指标」卡（契约 costs 缺失则整行不渲染） ---
    const costs = d.costs;
    let costRow = null;
    if (costs && typeof costs === 'object') {
      const item = (label, v) => (v == null ? null : U.el('span', {
        style: 'background:var(--bg-2);border:1px solid var(--line-2);border-radius:5px;' +
          'padding:3px 8px;font-size:11px;color:var(--fg-3);font-family:var(--mono,monospace)'
      }, label + ' ',
        U.el('b', { style: 'color:var(--fg-2);font-weight:500', text: this.usd(v) })));
      const kids = [item('总佣金', costs.commission), item('总滑点', costs.slippage),
        item('总点差', costs.spread)].filter(Boolean);
      if (kids.length) {
        costRow = U.el('div', { class: 'row', style: 'gap:6px;margin-top:9px' },
          kids,
          U.el('span', { class: 'dim', style: 'font-size:10.5px;text-align:right;flex:1 1 auto',
            text: '按本次回测全部成交累计' }));
      }
    }

    // 「存为研究笔记」：把本次结论沉淀进记忆，下次研究自动接上（记忆插件未开启则明示提示）
    const saveBtn = U.el('button', { class: 'btn sm', text: '存为研究笔记',
      title: '把本次回测结论写入本机记忆（rsrs）：前因 / 行为 / 后果 三标' });
    saveBtn.addEventListener('click', () => this.saveBacktestNote(d, saveBtn));

    wrap.appendChild(U.card('绩效指标', U.el('div', {}, meta, stats, costRow), saveBtn));

    // --- 权益曲线 + 水下回撤（同期 x 轴，两图各自独立 echarts 实例） ---
    const chartHost = U.el('div', { class: 'chart-host', style: 'height:300px' });
    const ddHost = U.el('div', { class: 'chart-host', style: 'height:160px' });
    const ddOk = Array.isArray(d.drawdown) && d.drawdown.length >= 2;
    wrap.appendChild(U.card('权益曲线', U.el('div', {},
      chartHost,
      ddOk
        ? U.el('div', {},
            U.el('div', { class: 'dim', style: 'font-size:11px;margin:10px 0 2px',
              text: '水下回撤（0 轴基线，与上图同期）' }),
            ddHost)
        : (Array.isArray(d.drawdown)
            ? U.el('div', { class: 'empty-tip', text: '该区间无回撤序列' })
            : null),
      U.el('div', { class: 'note', style: 'margin-top:10px' },
        '回测基于真实历史 K 线逐根复盘，指标由回测引擎按实际成交序列计算；' +
        '结果仅供研究参考，不构成交易建议。'))));

    // --- 月度收益（契约 monthly 缺失则整块不渲染） ---
    if (Array.isArray(d.monthly)) {
      const mHost = U.el('div', {});
      wrap.appendChild(U.card('月度收益', mHost,
        U.el('span', { class: 'dim mono', style: 'font-size:11px', text: '按月复利折算' })));
      this.renderMonthly(mHost, d.monthly);
    }

    // --- 交易明细 ---
    const tradesHost = U.el('div', {});
    this.renderTrades(tradesHost, trades, d.interval || this.params.interval);
    wrap.appendChild(U.card('交易明细', tradesHost,
      U.el('span', { class: 'dim mono', style: 'font-size:11px', text: trades.length + ' 笔' })));

    return {
      el: wrap,
      after: () => {
        if (this.running) return;
        const bm = this.pts(d.benchmark);
        const series = [{ name: '策略权益', data: this.pts(d.equity), color: '#d8ab3e', area: true }];
        if (bm.length >= 2) series.push({ name: '买入持有', data: bm, color: '#4a9eff', dashed: true });
        this.chart = this.initEquity(chartHost, series, init, true);
        if (ddOk) this.ddChart = this.initDrawdown(ddHost, d.drawdown, this.pts(d.equity));
      }
    };
  },

  /** 金额：$1,234.56（成本按正值展示，与标签「总佣金」语义一致） */
  usd(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '--';
    return '$' + String(U.money(-Math.abs(n))).replace('-', '');
  },

  /* ---------- 月度收益表（聚宽式：行=年，列=1..12 月 + 合计） ---------- */
  renderMonthly(host, monthly) {
    U.clear(host);
    const byYear = new Map();
    for (const it of (monthly || [])) {
      const mt = String((it && it.ym) || '').match(/^(\d{4})-(\d{1,2})$/);
      if (!mt) continue;
      const y = mt[1];
      const mo = parseInt(mt[2], 10);
      if (!(mo >= 1 && mo <= 12)) continue;
      if (!byYear.has(y)) byYear.set(y, {});
      const raw = it.ret_pct;
      const v = (raw === null || raw === undefined || raw === '') ? null : Number(raw);
      byYear.get(y)[mo] = Number.isFinite(v) ? v : null;
    }
    const years = [...byYear.keys()].sort();
    if (!years.length) {
      host.appendChild(U.el('div', { class: 'empty-tip', text: '该区间没有完整月度数据' }));
      return;
    }

    const headers = [{ label: '年' }];
    for (let i = 1; i <= 12; i++) headers.push({ label: i + '月', num: true });
    headers.push({ label: '合计', num: true });

    const cell = (v) => (v == null
      ? { v: '—', cls: 'dim', num: true }
      : { v: U.fx(v, 2) + '%', cls: U.cls(v), num: true });

    const rows = years.map((y) => {
      const mm = byYear.get(y);
      let acc = 1, has = false;
      const cells = [y];
      for (let i = 1; i <= 12; i++) {
        const v = mm[i];
        if (v != null) { acc *= (1 + v / 100); has = true; }
        cells.push(cell(v == null ? null : v));
      }
      cells.push(has ? cell((acc - 1) * 100) : { v: '—', cls: 'dim', num: true });
      return cells;
    });

    const tbl = U.table(headers, rows);
    tbl.style.minWidth = '760px';
    tbl.insertBefore(U.el('colgroup', {},
      [['6%'], ...Array.from({ length: 12 }, () => ['6.5%']), ['8%']]
        .map(([w]) => U.el('col', { style: 'width:' + w }))), tbl.firstChild);

    // 12 列横放不下：自建横向滚动容器（不改 CSS）
    host.appendChild(U.el('div', { style: 'overflow-x:auto' }, tbl));
    host.appendChild(U.el('div', { class: 'dim', style: 'font-size:10.5px;margin-top:7px',
      text: '单元格为该月收益 %，空月显示 —；合计按年内各月复利折算' }));
  },

  /* ---------- 交易明细 ---------- */
  renderTrades(host, trades, interval) {
    U.clear(host);
    if (!trades.length) {
      host.appendChild(U.el('div', { class: 'empty-tip', text: '该区间无信号触发' }));
      return;
    }
    const dirCell = (dir) => dir === 'short'
      ? { v: '做空', cls: 'down' }
      : dir === 'long' ? { v: '做多', cls: 'up' } : { v: dir || '--', cls: 'dim' };

    const tbl = U.table([
      { label: '开仓时间' }, { label: '方向' },
      { label: '开仓价', num: true }, { label: '平仓价', num: true },
      { label: '平仓时间' }, { label: '持仓时长', num: true },
      { label: '出场原因' }, { label: 'R 倍数', num: true },
      { label: '盈亏', num: true }, { label: '佣金', num: true }, { label: '滑点', num: true }
    ], trades.map((t) => [
      U.full(t.t_open),
      dirCell(t.direction),
      { v: U.px(t.entry), num: true },
      { v: U.px(t.exit), num: true },
      U.full(t.t_close),
      { v: this.durTxt(t.bars, interval), num: true },
      { v: this.exitBadge(t) },
      t.r_multiple == null ? { v: '--', cls: 'dim', num: true }
        : { v: U.fx(t.r_multiple, 2) + 'R', cls: U.cls(t.r_multiple), num: true },
      { v: U.money(t.pnl), cls: U.cls(t.pnl), num: true },
      { v: t.commission == null ? '--' : this.usd(t.commission),
        cls: t.commission == null ? 'dim' : '', num: true },
      { v: t.slippage == null ? '--' : this.usd(t.slippage),
        cls: t.slippage == null ? 'dim' : '', num: true }
    ]));

    // 开平仓依据与持仓根数不占列宽，悬停行上可见
    U.$$('tbody tr', tbl).forEach((tr, i) => {
      const t = trades[i] || {};
      const parts = [];
      if (t.bars != null) parts.push('持仓 ' + t.bars + ' 根');
      if (t.open_reason) parts.push('开：' + t.open_reason);
      if (t.close_reason) parts.push('平：' + t.close_reason);
      if (parts.length) tr.title = parts.join('　');
    });

    // 11 列均摊会留出大片真空：按内容密度定列宽（行内 colgroup，不改 CSS）
    tbl.style.minWidth = '1060px';
    tbl.insertBefore(U.el('colgroup', {},
      ['12%', '6%', '9%', '9%', '12%', '7.5%', '8.5%', '7%', '10%', '9%', '8%']
        .map((w) => U.el('col', { style: 'width:' + w }))), tbl.firstChild);

    host.appendChild(U.el('div', { style: 'overflow:auto;max-height:420px' }, tbl));
  },

  /** 出场原因徽章：止损 down / 止盈 up / 期末 dim（旧后端只有 close_reason 时按词兜底） */
  exitBadge(t) {
    let label = t.exit_reason || '';
    if (!label) {
      const cr = String(t.close_reason || '');
      if (cr.includes('止损')) label = '止损';
      else if (cr.includes('止盈')) label = '止盈';
      else if (cr.includes('期末')) label = '期末';
      else return cr ? this.badge(cr, 'dim') : U.el('span', { class: 'dim', text: '--' });
    }
    const kind = label.includes('止损') ? 'down' : label.includes('止盈') ? 'up' : 'dim';
    const text = label.includes('期末') ? '期末' : label;
    return this.badge(text, kind);
  },

  badge(text, kind) {
    const col = kind === 'up' ? 'var(--up)' : kind === 'down' ? 'var(--down)' : 'var(--fg-3)';
    return U.el('span', {
      class: 'chip',
      style: 'cursor:default;padding:1px 7px;font-size:10.5px;line-height:1.6;background:transparent;' +
        'vertical-align:middle;' +
        `color:${col};border-color:${col}`
    }, text);
  },

  /** bars × 周期 → 2h15m / 3d4h / 45m */
  durTxt(bars, interval) {
    const n = Number(bars);
    const min = n * (this.IV_MIN[interval] || 0);
    if (!Number.isFinite(n) || n <= 0 || !min) return '--';
    if (min >= 1440) {
      const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60);
      return h ? `${d}d${h}h` : `${d}d`;
    }
    if (min >= 60) {
      const h = Math.floor(min / 60), mm = min % 60;
      return mm ? `${h}h${mm}m` : `${h}h`;
    }
    return `${min}m`;
  },

  /* ---------- 研究笔记（回测 / 优化结论 → 记忆；研究是连续剧，不是单集）
   * 格式契约（AGENTS.override.md 五、研究与记忆纪律）：
   *   title `回测研究 <策略名> <周期> <bars>根 总收益<X%>`；优化结论后缀 ` ·优化<参数摘要>`
   *   body 【前因】何日对何策略何参数（含佣金/滑点）→【行为】核心指标（+ 最优组合）
   *        →【后果】一句可复用结论 + 下一步看什么
   *   tags ['回测研究', 策略名]
   * 写入走 POST /api/memory；记忆插件未开启时后端回「记忆插件未开启」——此处只提示一次，不刷屏。
   */
  NOTE_TAG: '回测研究',
  NOTE_MAX: 10,                     // 列表最多展示条数
  NOTE_DUP_MS: 30 * 60 * 1000,      // 同一结果指纹 30 分钟内不重复入库

  /** 研究笔记面板状态（跨挂载保留：切 tab 回来列表还在） */
  noteState() {
    if (!this.notes) {
      this.notes = { open: false, loading: false, off: false, error: '', items: null, openId: '' };
    }
    return this.notes;
  },

  /** 防重指纹表（内存 Map，进程内有效） */
  noteSeen() {
    if (!this._noteSeen) this._noteSeen = new Map();
    return this._noteSeen;
  },

  today() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },

  /** 当前参数区所选策略名（拿不到返回空串） */
  currentStrategyName() {
    const sid = this.params.strategy_id;
    const s = ((State.settings && State.settings.strategies) || []).find((x) => x.id === sid)
      || (this.stratCache || []).find((x) => x.id === sid);
    return s ? s.name : '';
  },

  /** 单策略回测结果 → 记忆条目（字段全部取自本次结果，不编造） */
  backtestNote(d, sname) {
    const m = d.metrics || {};
    const p = this.params;
    const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)))
      ? null : Number(v);
    const ret = num(m.total_return_pct), shp = num(m.sharpe), dd = num(m.max_drawdown_pct);
    const win = num(m.win_rate_pct), trd = num(m.trades);
    const bars = d.bars_used ?? p.bars;
    const iv = d.interval || p.interval;
    const span = (d.from != null && d.to != null)
      ? `${U.full(d.from)} ~ ${U.full(d.to)}` : '区间未知';
    const months = Array.isArray(d.monthly) ? d.monthly.length : null;
    const monWin = months == null
      ? null : d.monthly.filter((x) => Number(x.ret_pct) > 0).length;

    const good = ret != null && ret > 0 && shp != null && shp > 0;
    const title = `回测研究 ${sname} ${U.ivLabel(iv)} ${bars}根 总收益${U.fx(ret, 2)}%`;
    const body = [
      `【前因】${this.today()} 对策略「${sname}」按 ${U.ivLabel(iv)} / ${bars} 根` +
        `（${span}）跑回测，佣金 ${p.commission_rate}%/边、滑点 ${p.slippage} 美元/盎司`,
      `【行为】总收益 ${U.fx(ret, 2)}% · 夏普 ${U.fx(shp, 2)} · 最大回撤 ` +
        `${dd == null ? '--' : U.fx(-Math.abs(dd), 2) + '%'} · 胜率 ${U.fx(win, 1)}% · ` +
        `交易 ${U.fx(trd, 0)} 笔` +
        (months == null ? '' : ` · 月度跨度 ${months} 个月（盈利 ${monWin} 个月）`),
      `【后果】${good ? '该参数组合在本区间有效，下一步换更大样本验证'
        : '本区间失效，下一步换参数 / 区间'}。` +
        (good
          ? '下一步：把 K 线根数抬到 1000 / 2000 复跑同一参数，并在相邻周期（H4 / D1）各跑一次，' +
            '看收益与夏普是否守得住；守住再考虑写入策略。'
          : '下一步：换周期，或用「参数优化 · 网格扫描」扫一遍参数网格，别在同一区间反复调参。')
    ].join('\n');
    return { title, body, tags: [this.NOTE_TAG, sname] };
  },

  /** 参数优化结果 → 记忆条目（最优组合与网格取值都来自本次结果） */
  optNote(d, sname) {
    const st = this.optState();
    const best = ((d.combos || []).filter((c) => c && c.params))[0];
    if (!best) return null;
    const p = this.params;
    const grid = st.lastGrid || {};
    const gridTxt = Object.keys(grid).map((k) => {
      const f = this.OPT_FIELDS.find((x) => x.key === k);
      return `${f ? f.label : k}=[${(grid[k] || []).join(', ')}]`;
    }).join('；');
    const label = this.comboLabel(best.params);
    const ret = Number(best.total_return_pct), shp = Number(best.sharpe);
    const dd = best.max_drawdown_pct == null ? null : -Math.abs(Number(best.max_drawdown_pct));
    const good = Number.isFinite(ret) && ret > 0 && Number.isFinite(shp) && shp > 0;
    const brief = label.length > 60 ? label.slice(0, 60) + '…' : label;
    const tried = d.tried == null ? (d.combos || []).length : d.tried;

    return {
      title: `回测研究 ${sname} ${U.ivLabel(p.interval)} ${p.bars}根 ` +
        `总收益${U.fx(ret, 2)}% ·优化${brief}`,
      body: [
        `【前因】${this.today()} 对策略「${sname}」按 ${U.ivLabel(p.interval)} / ${p.bars} 根` +
          `扫描 ${tried} 组参数` + (gridTxt ? `（网格：${gridTxt}）` : '') +
          `，佣金 ${p.commission_rate}%/边、滑点 ${p.slippage} 美元/盎司`,
        `【行为】最优组合 ${label} → 总收益 ${U.fx(ret, 2)}% · 夏普 ${U.fx(shp, 2)} · ` +
          `最大回撤 ${dd == null ? '--' : U.fx(dd, 2) + '%'} · ` +
          `胜率 ${U.fx(best.win_rate_pct, 1)}% · 交易 ${U.fx(best.trades, 0)} 笔` +
          (st.secs == null ? '' : `；共扫 ${tried} 组，耗时 ${st.secs.toFixed(1)}s`),
        `【后果】${good ? '最优组合在本区间有效，下一步换更大样本验证'
          : '本区间无有效组合，下一步换网格 / 区间'}。` +
          (good
            ? '下一步：用更大样本（bars 抬到 1000 / 2000）复核该最优组合，再考虑「应用最优组合」写入策略。'
            : '下一步：放宽或调整网格取值（每参数 ≤8 个）、换周期再扫，别只调一个参数。')
      ].join('\n'),
      tags: [this.NOTE_TAG, sname]
    };
  },

  saveBacktestNote(d, btn) {
    if (!d || !d.metrics) { U.toast('没有可保存的回测结果', 'err'); return; }
    const p = this.params;
    const sid = d.strategy_id || p.strategy_id;
    const sname = d.strategy_name
      || ((State.settings && State.settings.strategies) || []).find((x) => x.id === sid)?.name
      || sid || '未命名策略';
    this.saveNote(this.backtestNote(d, sname), btn,
      ['bt', sid, d.interval || p.interval, d.bars_used ?? p.bars,
        p.commission_rate, p.slippage]);
  },

  saveOptNote(d, btn) {
    const st = this.optState();
    if (!st.result || !d || !Array.isArray(d.combos)) {
      U.toast('没有可保存的优化结果', 'err'); return;
    }
    const sname = this.currentStrategyName() || this.params.strategy_id || '未命名策略';
    const note = this.optNote(d, sname);
    if (!note) { U.toast('本次扫描没有有效组合，暂无可沉淀的结论', 'err'); return; }
    const best = (d.combos || []).filter((c) => c && c.params)[0];
    this.saveNote(note, btn,
      ['opt', this.params.strategy_id, this.params.interval, this.params.bars,
        this.params.commission_rate, this.params.slippage, this.comboLabel(best.params)]);
  },

  /* ---------- 研究笔记 · 写入与列表 ---------- */

  /** 公共写入口：30 分钟同指纹防重 → fire-and-forget 落库 → 按钮转「已存 ✓」 */
  async saveNote(note, btn, fpParts) {
    const seen = this.noteSeen();
    const fp = (fpParts || []).join('|');
    const now = Date.now();
    const last = seen.get(fp);
    if (last && now - last < this.NOTE_DUP_MS) {
      const mins = Math.ceil((this.NOTE_DUP_MS - (now - last)) / 60000);
      U.toast(`同一结果已存过研究笔记（${mins} 分钟内防重复，历史研究里可查）`, 'warn');
      return;
    }
    seen.set(fp, now);
    const prev = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '存入中…'; }
    try {
      await API.memSave({ title: note.title, body: note.body, tags: note.tags });
      U.toast('已存为研究笔记，下次研究自动接上', 'ok');
      if (btn && btn.isConnected) btn.textContent = '已存 ✓';
      setTimeout(() => {
        if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = prev; }
      }, 3000);
      const st = this.noteState();
      if (st.open) this.loadNotes(true);   // 列表开着就顺手刷新，新条目立刻可见
    } catch (e) {
      seen.delete(fp);                      // 没存进去不算重复，允许重试
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = prev; }
      const msg = (e && e.message) || '未知错误';
      if (/未开启/.test(msg)) {
        // 记忆插件未开启：同因只提示一次，避免连点刷屏
        if (Date.now() - (this._offWarnAt || 0) > 60000) {
          this._offWarnAt = Date.now();
          U.toast('需在设置页开启记忆插件，才能把结论存进记忆', 'err');
        }
        const st = this.noteState();
        st.off = true;
        if (st.open) this.renderNotes();
      } else {
        U.toast('存入失败：' + msg, 'err');
      }
    }
  },

  /** 开着则收起、收起则读取；读取走 API.memList('回测研究') */
  async toggleNotes() {
    const st = this.noteState();
    st.open = !st.open;
    if (st.open) {
      this.renderNotes();
      await this.loadNotes();
    } else {
      this.renderNotes();
    }
    this.syncHistBtn();
  },

  async loadNotes(keep) {
    const st = this.noteState();
    if (st.loading) return;
    st.loading = true;
    st.error = '';
    if (!keep) this.renderNotes();
    try {
      // 语义召回（按相关度、上限 30 条）+ 全量列表（限 200 条）合并：
      // 后者保证刚存的笔记一定在列表里，前者补回语义相关的老条目
      const [rel, all] = await Promise.all([
        API.memList(this.NOTE_TAG),
        API.memList('').catch(() => null)
      ]);
      const cand = (Array.isArray(all) ? all : []).concat(Array.isArray(rel) ? rel : []);
      // 记忆里混着同主题但非本功能所存的条目：只认「回测研究」标签（或标题前缀）
      const seenIds = new Set();
      const list = cand.filter((it) => {
        if (!it || !it.id) return false;
        const tags = Array.isArray(it.tags) ? it.tags : [];
        const isNote = tags.includes(this.NOTE_TAG)
          || String(it.title || '').indexOf(this.NOTE_TAG + ' ') === 0;
        if (!isNote || seenIds.has(it.id)) return false;
        seenIds.add(it.id);
        return true;
      });
      list.sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0));
      st.items = list;
      st.recalled = cand.length;
      st.off = false;
    } catch (e) {
      const msg = (e && e.message) || '未知错误';
      st.off = /未开启/.test(msg);
      st.error = st.off ? '' : msg;
      if (st.off) st.items = null;
    } finally {
      st.loading = false;
      this.renderNotes();
    }
  },

  syncHistBtn() {
    const h = this.hosts;
    const st = this.noteState();
    if (h && h.histBtn && h.histBtn.isConnected) {
      h.histBtn.textContent = st.open ? '历史研究 ▲' : '历史研究';
    }
  },

  /** 取【后果】段（到下一个【标或结尾） */
  outcomeOf(body) {
    const t = String(body || '');
    const i = t.indexOf('【后果】');
    if (i < 0) return t.trim().slice(0, 300);
    const rest = t.slice(i + 4);
    const j = rest.indexOf('【');
    return (j < 0 ? rest : rest.slice(0, j)).trim();
  },

  /** 与当前所选策略同名的最近一条研究笔记（items 已按时间倒序；无匹配返回 null） */
  lastNote(items, name) {
    if (!name || !Array.isArray(items)) return null;
    for (const it of items) {
      const tags = Array.isArray(it.tags) ? it.tags : [];
      if (tags.includes(name)) return it;
      if (String(it.title || '').indexOf(`回测研究 ${name} `) === 0) return it;
    }
    return null;
  },

  renderNotes() {
    const host = this.histHost;
    if (!host || !host.isConnected) return;
    const st = this.noteState();
    U.clear(host);
    if (!st.open) return;

    const body = U.el('div', {});
    const refresh = U.el('button', { class: 'btn sm', text: st.loading ? '读取中…' : '刷新',
      disabled: st.loading ? true : null });
    refresh.addEventListener('click', () => this.loadNotes());

    if (st.loading && !st.items) {
      body.appendChild(U.el('div', { class: 'empty-tip', text: '正在读取本机记忆里的研究笔记…' }));
    } else if (st.off) {
      body.appendChild(U.el('div', { class: 'note warn',
        text: '记忆插件未开启：研究笔记存在本机 rsrs 记忆里，请到「设置」页开启记忆插件后重试。' }));
      const re = U.el('button', { class: 'btn sm', text: '重新检查' });
      re.addEventListener('click', () => this.loadNotes());
      body.appendChild(U.el('div', { class: 'row', style: 'margin-top:9px' }, re));
    } else if (st.error) {
      body.appendChild(U.el('div', { class: 'note err', text: '读取研究笔记失败：' + st.error }));
    } else if (!st.items || !st.items.length) {
      body.appendChild(U.el('div', { class: 'empty-tip',
        text: '暂无研究笔记——跑完回测点「存为研究笔记」沉淀结论' }));
    } else {
      const sname = this.currentStrategyName();
      const prev = this.lastNote(st.items, sname);
      if (prev) body.appendChild(this.prevNoteCard(prev, sname));

      const list = U.el('div', { style: 'display:flex;flex-direction:column;gap:6px' });
      for (const it of st.items.slice(0, this.NOTE_MAX)) {
        list.appendChild(this.noteRow(it, st.openId === it.id));
      }
      body.appendChild(list);
      const more = st.items.length - this.NOTE_MAX;
      body.appendChild(U.el('div', { class: 'dim', style: 'font-size:10.5px;margin-top:7px',
        text: `共 ${st.items.length} 条研究笔记（自 ${st.recalled || st.items.length} 条相关记忆筛出），` +
          `显示最近 ${Math.min(st.items.length, this.NOTE_MAX)} 条` +
          (more > 0 ? `（另有 ${more} 条更早，略）` : '') +
          '；点条目展开全文，删即从记忆里抹掉' }));
    }

    host.appendChild(U.card('历史研究 · 研究笔记', body, refresh));
  },

  noteRow(it, open) {
    const del = U.el('button', { class: 'btn sm', text: '删除',
      title: '从记忆里删除该条研究笔记（不可撤销）' });
    del.addEventListener('click', (e) => { e.stopPropagation(); this.removeNote(it); });
    const head = U.el('div', { class: 'row', style: 'gap:8px;align-items:baseline;cursor:pointer' },
      U.el('span', { class: 'dim mono', style: 'font-size:11px;flex:none',
        text: it.updated ? U.ago(Number(it.updated)) : '时间未知',
        title: it.updated ? U.full(Number(it.updated)) : '' }),
      U.el('span', { style: 'font-size:12px;color:var(--fg-2);flex:1 1 55%;overflow-wrap:anywhere',
        text: it.title || '（无标题）' }),
      del);
    head.addEventListener('click', () => {
      const st = this.noteState();
      st.openId = open ? '' : it.id;
      this.renderNotes();
    });
    const box = U.el('div', { style: 'border:1px solid var(--line);border-radius:7px;' +
      'background:var(--bg-2);padding:8px 10px' }, head);
    if (open) {
      box.appendChild(U.el('div', { style: 'white-space:pre-wrap;font-size:12px;line-height:1.75;' +
        'color:var(--fg-2);margin-top:7px;border-top:1px solid var(--line);padding-top:7px',
        text: it.body || '（该条目无正文）' }));
    }
    return box;
  },

  /** 「上次结论」卡：同策略最近一条的【后果】+ 接着跑 */
  prevNoteCard(it, sname) {
    const runBtn = U.el('button', { class: 'btn gold sm', text: '接着这个结论跑',
      title: '按当前参数区再跑一次回测（参数可在上方改）' });
    runBtn.addEventListener('click', () => {
      U.toast('接着上次结论跑一次：' + sname + ' · ' + U.ivLabel(this.params.interval));
      this.run();
    });
    return U.el('div', { style: 'border:1px solid var(--gold-dim);border-radius:8px;' +
      'background:rgba(216,171,62,.07);padding:9px 11px;margin-bottom:9px' },
      U.el('div', { class: 'row', style: 'gap:7px;align-items:baseline' },
        U.el('span', { class: 'chip on', text: '上次结论' }),
        U.el('span', { class: 'dim mono', style: 'font-size:11px',
          text: (it.updated ? U.ago(Number(it.updated)) + '存 · ' : '') + '同策略「' + sname + '」' }),
        U.el('div', { class: 'spacer' }),
        runBtn),
      U.el('div', { style: 'font-size:12px;line-height:1.75;color:var(--fg-2);margin-top:7px;' +
        'white-space:pre-wrap', text: this.outcomeOf(it.body) }),
      U.el('div', { class: 'dim', style: 'font-size:10.5px;margin-top:6px',
        text: '截自该条研究笔记的【后果】段；点「接着这个结论跑」用当前参数区再跑一次' }));
  },

  /** 删除：二次确认后 DELETE /api/memory/:id */
  async removeNote(it) {
    const ok = window.confirm('从记忆里删除该条研究笔记？删除后不可撤销。\n\n' + (it.title || it.id));
    if (!ok) return;
    try {
      await API.memDel(it.id);
      const st = this.noteState();
      if (st.items) st.items = st.items.filter((x) => x.id !== it.id);
      if (st.openId === it.id) st.openId = '';
      U.toast('已从记忆里删除该条研究笔记', 'ok');
      this.renderNotes();
    } catch (e) {
      U.toast('删除失败：' + ((e && e.message) || '未知错误'), 'err');
    }
  },

  /* ---------- 多策略对比 ---------- */
  renderCompare(host) {
    const cmp = this.cmp;
    if (!cmp || (!cmp.results.length && !cmp.error)) { host.appendChild(this.emptyCard()); return; }

    const p = this.params;
    const okRes = cmp.results.filter((r) => r.ok);
    const badRes = cmp.results.filter((r) => !r.ok);
    const wrap = U.el('div', { style: 'display:flex;flex-direction:column;gap:11px' });

    const backBtn = U.el('button', { class: 'btn sm', text: '返回单策略' });
    backBtn.addEventListener('click', () => {
      this.mode = 'single';
      this.renderResult();
    });

    const meta = U.el('div', { class: 'row', style: 'gap:6px;margin-bottom:10px' },
      U.el('span', { class: 'chip on', text: `对比 ${cmp.total} 条启用策略` }),
      U.el('span', { class: 'chip', text: U.ivLabel(p.interval) }),
      U.el('span', { class: 'chip', text: `${p.bars} 根` }),
      U.el('span', { class: 'chip mono', text: `佣金 ${p.commission_rate}% · 滑点 ${p.slippage}` }),
      U.el('div', { class: 'spacer' }),
      U.el('span', { class: 'dim mono', style: 'font-size:11px', text: `成功 ${okRes.length}/${cmp.total}` }));

    wrap.appendChild(U.card('多策略对比', U.el('div', {}, meta,
      cmp.error ? U.el('div', { class: 'note err', text: cmp.error }) : null,
      badRes.length && !cmp.error
        ? U.el('div', { class: 'note warn', style: 'margin-top:9px',
            text: '部分策略失败：' + badRes.map((r) => `${r.name}（${r.error}）`).join('；') })
        : null), backBtn));

    // --- 权益曲线：每策略一色 + 基准只留一条虚线 ---
    const chartHost = U.el('div', { class: 'chart-host', style: 'height:300px' });
    wrap.appendChild(U.card('权益曲线对比', U.el('div', {},
      chartHost,
      U.el('div', { class: 'note', style: 'margin-top:10px' },
        '各策略同一区间、同一成本假设（佣金与滑点）串行回测；基准买入持有只画一条虚线。'))));

    // --- 对比指标表 ---
    const tblHost = U.el('div', {});
    wrap.appendChild(U.card('对比指标', tblHost,
      U.el('span', { class: 'dim mono', style: 'font-size:11px', text: okRes.length + ' 条有效' })));
    this.renderCompareTable(tblHost, cmp.results);

    host.appendChild(wrap);

    if (this.running) return;
    const palette = ['#d8ab3e', '#4a9eff', '#26a69a', '#ef5350', '#a78bfa',
      '#f0a35e', '#5ed3f3', '#c084fc', '#e8eef5', '#facc15'];
    const series = okRes.map((r, i) => ({
      name: r.name, data: this.pts(r.data.equity), color: palette[i % palette.length]
    }));
    const bmSrc = okRes.find((r) => this.pts(r.data.benchmark).length >= 2);
    if (bmSrc) {
      series.push({ name: '买入持有', data: this.pts(bmSrc.data.benchmark),
        color: '#7c8a99', dashed: true, thin: true });
    }
    this.chart = this.initEquity(chartHost, series, null, false);
  },

  renderCompareTable(host, results) {
    U.clear(host);
    if (!results.length) {
      host.appendChild(U.el('div', { class: 'empty-tip', text: '暂无对比结果' }));
      return;
    }
    const pct = (v) => (v == null ? { v: '--', cls: 'dim', num: true }
      : { v: U.fx(v, 2) + '%', cls: U.cls(v), num: true });

    const tbl = U.table([
      { label: '策略' }, { label: '总收益', num: true }, { label: '夏普', num: true },
      { label: '最大回撤', num: true }, { label: '胜率', num: true }, { label: '交易数', num: true }
    ], results.map((r) => {
      if (!r.ok) {
        const row = [
          { v: r.name }, { v: '失败', cls: 'down', num: true },
          { v: '--', cls: 'dim', num: true }, { v: '--', cls: 'dim', num: true },
          { v: '--', cls: 'dim', num: true }, { v: '--', cls: 'dim', num: true }
        ];
        return row;
      }
      const m = r.data.metrics || {};
      const dd = m.max_drawdown_pct == null ? null : -Math.abs(m.max_drawdown_pct);
      return [
        { v: r.name },
        pct(m.total_return_pct),
        { v: U.fx(m.sharpe, 2), cls: U.cls(m.sharpe), num: true },
        dd == null ? { v: '--', cls: 'dim', num: true } : { v: U.fx(dd, 2) + '%', cls: 'down', num: true },
        m.win_rate_pct == null ? { v: '--', cls: 'dim', num: true }
          : { v: U.fx(m.win_rate_pct, 1) + '%', cls: '', num: true },
        { v: U.fx(m.trades, 0), cls: '', num: true }
      ];
    }));

    U.$$('tbody tr', tbl).forEach((tr, i) => {
      const r = results[i] || {};
      tr.title = r.ok ? '' : (r.error || '回测失败');
    });
    tbl.style.minWidth = '620px';
    tbl.insertBefore(U.el('colgroup', {},
      ['30%', '14%', '12%', '14%', '14%', '12%'].map((w) => U.el('col', { style: 'width:' + w }))),
      tbl.firstChild);
    host.appendChild(U.el('div', { style: 'overflow-x:auto' }, tbl));
  },

  /* ---------- 参数优化 · 网格扫描 ----------
   * 契约：POST /api/backtest/optimize（字段名锁定）
   *   req  {strategy_id, interval, bars, commission_rate, slippage, grid}
   *   grid 键白名单 confidence_floor / rr_min / ema_period / trend_ema_period；
   *        每键 1..=8 个值、组合总数 ≤200，违规由后端报错（error 文案直显，前端不造假数据）
   *   data {combos:[{params, total_return_pct, sharpe, max_drawdown_pct, win_rate_pct, trades}],
   *         tried}
   * combos 已按 total_return_pct 降序返回，前端只补序号与 top1 金色标记。
   */
  OPT_FIELDS: [
    { key: 'confidence_floor', label: '置信下限', def: '40,50,60', ph: '40,50,60' },
    { key: 'rr_min', label: '盈亏比下限', def: '1.5,2,2.5', ph: '1.5,2,2.5' },
    { key: 'ema_period', label: 'EMA周期', def: '', ph: '10,20,30' },
    { key: 'trend_ema_period', label: '趋势EMA周期', def: '', ph: '50,100,150' }
  ],
  OPT_MAXVALS: 8,      // 每参数取值上限（与后端同规）
  OPT_MAXCOMBOS: 200,  // 组合总数上限

  /** 优化卡状态：勾选与取值挂在模块上，切 tab 回来照旧 */
  optState() {
    if (!this.opt) {
      const sel = {};
      for (const f of this.OPT_FIELDS) sel[f.key] = { on: !!f.def, text: f.def };
      this.opt = {
        sel, running: false, error: null, result: null, secs: null, t0: 0, timer: null, seq: 0
      };
    }
    return this.opt;
  },

  /** 一行取值文本 → 数值数组（剔非法 / 非数，按数值去重，保序） */
  parseVals(text) {
    const out = [], seen = new Set();
    const src = (text === null || text === undefined) ? '' : String(text);
    for (const tok of src.split(/[,，、;；\s]+/)) {
      if (!tok) continue;
      const n = Number(tok);
      if (!Number.isFinite(n) || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  },

  /** 勾选现状 → {grid, count, err}；err 非空即按钮禁用（并就地说明原因） */
  gridPlan() {
    const st = this.optState();
    const picked = [], errs = [];
    for (const f of this.OPT_FIELDS) {
      const s = st.sel[f.key];
      if (!s || !s.on) continue;
      const vals = this.parseVals(s.text);
      if (!vals.length) errs.push(`${f.label} 无有效取值`);
      else if (vals.length > this.OPT_MAXVALS) {
        errs.push(`${f.label} ${vals.length} 个取值超上限 ${this.OPT_MAXVALS}`);
      }
      picked.push({ f, vals });
    }
    if (!picked.length) return { grid: null, count: 0, err: '请至少勾选 1 个参数' };
    let count = 1;
    for (const p of picked) count *= Math.max(1, p.vals.length);
    if (!errs.length && count > this.OPT_MAXCOMBOS) {
      errs.push(`组合数 ${count} 超上限 ${this.OPT_MAXCOMBOS}`);
    }
    if (errs.length) return { grid: null, count, err: errs.join('；') };
    const grid = {};
    for (const p of picked) grid[p.f.key] = p.vals;
    return { grid, count, err: '' };
  },

  /** 优化卡（控件）：勾选 + 取值 + 扫描按钮；节点登记在 this.optNodes */
  buildOptCard() {
    const st = this.optState();
    const grid = U.el('div', {
      style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));' +
        'gap:11px;align-items:end'
    });
    for (const f of this.OPT_FIELDS) {
      const s = st.sel[f.key];
      const cb = U.el('input', { type: 'checkbox', checked: s.on ? 'checked' : null,
        style: 'width:auto;flex:none', title: '勾选后该参数计入扫描网格' });
      const lbl = U.el('label', { style: 'display:flex;align-items:center;gap:6px;cursor:pointer;' +
        'font-size:12px;color:' + (s.on ? 'var(--fg-2)' : 'var(--fg-3)') }, cb,
        U.el('span', { text: f.label }));
      const inp = U.el('input', { type: 'text', value: s.text, placeholder: f.ph,
        title: '逗号分隔的取值，如 ' + f.ph + '；最多 ' + this.OPT_MAXVALS + ' 个',
        style: 'font-family:var(--mono,monospace);font-size:12px;padding:5px 8px' });
      inp.disabled = !s.on;
      cb.addEventListener('change', () => {
        s.on = cb.checked;
        inp.disabled = !s.on;
        lbl.style.color = s.on ? 'var(--fg-2)' : 'var(--fg-3)';
        this.syncOpt();
      });
      inp.addEventListener('input', () => { s.text = inp.value; this.syncOpt(); });
      grid.appendChild(U.el('div', { style: 'display:flex;flex-direction:column;gap:4px' }, lbl, inp));
    }

    const btn = U.el('button', { class: 'btn gold', text: '开始扫描' });
    btn.addEventListener('click', () => this.runOptimize());
    const hint = U.el('span', { class: 'mono', style: 'font-size:11px' });
    const clock = U.el('span', { class: 'dim mono', style: 'font-size:11px' });
    this.optNodes = { btn, hint, clock };

    return U.card('参数优化 · 网格扫描', U.el('div', {},
      U.el('div', { class: 'dim', style: 'font-size:11px;margin-bottom:10px',
        text: '对选中参数逐组合跑回测，按总收益排序，找最优参数组合' }),
      grid,
      U.el('div', { class: 'row', style: 'margin-top:11px' },
        btn, hint, clock,
        U.el('span', { class: 'dim', style: 'font-size:11px;flex:1 1 220px;text-align:right',
          text: '取值逗号分隔；每参数最多 ' + this.OPT_MAXVALS + ' 个、组合总数上限 ' +
            this.OPT_MAXCOMBOS + '；策略 / 周期 / 根数 / 佣金 / 滑点同上' }))));
  },

  /** 提示与按钮态：组合数随输入实时刷新 */
  syncOpt() {
    const st = this.optState();
    const n = this.optNodes;
    if (!n) return;
    const plan = this.gridPlan();
    if (n.hint && n.hint.isConnected) {
      n.hint.textContent = plan.err ? plan.err : `当前 ${plan.count} 组`;
      n.hint.style.color = plan.err ? 'var(--warn)' : 'var(--fg-3)';
    }
    if (n.btn && n.btn.isConnected) {
      n.btn.disabled = st.running || !!plan.err;
      n.btn.textContent = st.running ? '扫描中…' : '开始扫描';
    }
    if (n.clock && n.clock.isConnected) {
      n.clock.textContent = st.running
        ? '已用 ' + ((Date.now() - st.t0) / 1000).toFixed(1) + 's'
        : (st.secs == null ? '' : '耗时 ' + st.secs.toFixed(1) + 's');
    }
  },

  startOptTimer() {
    const st = this.optState();
    if (st.timer) return;
    st.timer = setInterval(() => this.syncOpt(), 200);
  },

  stopOptTimer() {
    const st = this.optState();
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
  },

  /** 网格扫描：取当前策略与周期 / 根数 / 成本（requestPayload 同源），失败即明示 */
  async runOptimize() {
    const st = this.optState();
    if (st.running) return;
    if (!this.params.strategy_id) { U.toast('请先选择策略', 'err'); return; }
    const plan = this.gridPlan();
    if (plan.err) { U.toast(plan.err, 'err'); return; }
    const base = this.requestPayload(this.params.strategy_id);  // 佣金 / 滑点同主回测校验
    if (!base) return;

    const seq = ++st.seq;
    st.running = true;
    st.error = null;
    st.result = null;
    st.secs = null;
    st.t0 = Date.now();
    st.lastGrid = plan.grid;      // 快照：存研究笔记时如实记下本次扫描的网格
    this.startOptTimer();
    this.syncOpt();
    this.renderOpt();

    try {
      const d = await API.req('/api/backtest/optimize', {
        method: 'POST',
        body: {
          strategy_id: base.strategy_id, interval: base.interval, bars: base.bars,
          initial_equity: base.initial_equity,   // 与主回测同一起始资金（后端可省，默认 10000）
          commission_rate: base.commission_rate, slippage: base.slippage, grid: plan.grid
        }
      });
      if (seq !== st.seq) return;
      if (!d || !Array.isArray(d.combos)) throw new Error('响应缺少 combos 字段');
      st.result = d;
    } catch (e) {
      if (seq !== st.seq) return;
      st.error = (e && e.message) || '未知错误';
      U.toast('参数优化失败：' + st.error, 'err');
    } finally {
      if (seq !== st.seq) return;
      st.secs = (Date.now() - st.t0) / 1000;
      st.running = false;
      this.stopOptTimer();
      this.syncOpt();
      this.renderOpt();
    }
  },

  /* ---------- 参数优化结果 ---------- */
  renderOpt() {
    const st = this.optState();
    const host = this.optResultHost;
    if (!host) return;
    U.clear(host);

    if (st.running) {
      const plan = this.gridPlan();
      host.appendChild(U.card('参数优化结果', U.el('div', {},
        U.el('div', { class: 'chart-loading loading-dots',
          text: `正在逐组合回测 ${plan.count || ''} 组参数，按总收益排序` }),
        U.el('div', { class: 'dim', style: 'font-size:11px;text-align:center;margin-top:8px',
          text: '整轮扫描在后端一次跑完，组合越多耗时越长；期间可切走，回来仍在扫' }))));
      return;
    }
    if (st.error) {
      host.appendChild(this.errorCard('参数优化失败：' + st.error, () => this.runOptimize(), {
        title: '参数优化结果',
        note: '这里不做假数据兜底：请确认本机后端 /api/backtest/optimize 可用，' +
          '且所选策略与周期有足够历史 K 线；网格取值需满足每参数 ≤' + this.OPT_MAXVALS +
          ' 个、组合总数 ≤' + this.OPT_MAXCOMBOS + '。'
      }));
      return;
    }
    if (!st.result) { host.appendChild(this.optEmptyCard()); return; }
    host.appendChild(this.optTableCard(st.result));
  },

  optEmptyCard() {
    return U.card('参数优化结果', U.el('div', { style: 'padding:34px 20px;text-align:center' },
      U.el('div', { style: 'font-size:22px;color:var(--gold-dim);margin-bottom:10px', text: '⌗' }),
      U.el('div', { style: 'font-size:13px;color:var(--fg-2)',
        text: '勾选要扫描的参数并填取值范围，点「开始扫描」' }),
      U.el('div', { style: 'font-size:12px;color:var(--fg-3);margin-top:8px',
        text: '输出：各组合的总收益 / 夏普 / 最大回撤 / 胜率 / 交易数，按总收益降序' })));
  },

  /** `参数=值` 串：按白名单顺序排，后端多给的键缀在后 */
  comboLabel(params) {
    const p = params || {};
    const parts = [];
    for (const f of this.OPT_FIELDS) {
      if (p[f.key] === undefined || p[f.key] === null) continue;
      parts.push(`${f.label}=${p[f.key]}`);
    }
    for (const k of Object.keys(p)) {
      if (this.OPT_FIELDS.some((f) => f.key === k)) continue;
      if (p[k] === undefined || p[k] === null) continue;
      parts.push(`${k}=${p[k]}`);
    }
    return parts.join(', ');
  },

  /** 参数组合 → 策略字段：只取网格白名单键；EMA 周期在 config.rs 是 usize，取整并保底 ≥1 */
  comboFields(params) {
    const out = {}, errs = [];
    for (const f of this.OPT_FIELDS) {
      const v = params ? params[f.key] : undefined;
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n)) { errs.push(`${f.label}「${v}」不是有效数值`); continue; }
      if (f.key === 'ema_period' || f.key === 'trend_ema_period') {
        const i = Math.round(n);
        if (i < 1) { errs.push(`${f.label} 须 ≥ 1`); continue; }
        out[f.key] = i;
      } else {
        out[f.key] = n;   // config.rs 里 confidence_floor / rr_min 是 f64
      }
    }
    return { fields: out, errs };
  },

  /** 把一条参数组合写进「当前回测所选策略」：改 State.settings → POST /api/settings。
   *  只写 grid 里出现过的键；失败明示且回滚内存改动，成功按钮转「已应用 ✓」并防连点 3 秒 */
  async applyCombo(params, btn) {
    const sid = this.params.strategy_id;
    const list = (State.settings && State.settings.strategies) || [];
    const strat = list.find((x) => x.id === sid);
    if (!strat) {
      U.toast('应用失败：当前回测策略不在设置里（' + (sid || '未选择') + '）', 'err');
      return;
    }
    const { fields, errs } = this.comboFields(params);
    if (errs.length) { U.toast('应用失败：' + errs.join('；'), 'err'); return; }
    const keys = Object.keys(fields);
    if (!keys.length) { U.toast('应用失败：该组合没有可写入的参数', 'err'); return; }

    const label = this.OPT_FIELDS.filter((f) => keys.includes(f.key))
      .map((f) => `${f.label}=${fields[f.key]}`).join(' · ');
    const ok = window.confirm(
      `把该参数组合写入策略 ${strat.name}？（${label}）\n` +
      '置信下限/盈亏比下限/EMA 周期/趋势 EMA 周期 只写 grid 里出现过的键');
    if (!ok) return;

    const prev = (btn && btn.textContent) || '应用';
    const old = {};
    for (const k of keys) old[k] = { has: k in strat, v: strat[k] };
    if (btn) { btn.disabled = true; btn.textContent = '写入中…'; }

    try {
      Object.assign(strat, fields);
      await API.saveSettings(State.settings);
      U.toast('已应用，建议重新分析该策略', 'ok');
      if (btn) {
        btn.textContent = '已应用 ✓';
        // 防连点：3 秒内禁用，之后恢复原标签
        setTimeout(() => {
          if (!btn.isConnected) return;
          btn.disabled = false;
          btn.textContent = prev;
        }, 3000);
      }
    } catch (e) {
      // 写盘失败：回滚内存改动，防「界面已改、磁盘没改」的假成功
      for (const k of keys) {
        if (old[k].has) strat[k] = old[k].v;
        else delete strat[k];
      }
      if (btn) { btn.disabled = false; btn.textContent = prev; }
      U.toast('应用失败：' + ((e && e.message) || e), 'err');
    }
  },

  optTableCard(d) {
    const st = this.optState();
    const combos = (d.combos || []).filter((c) => c && c.params && typeof c.params === 'object');
    const tried = d.tried == null ? combos.length : d.tried;
    const head = U.el('span', { class: 'dim mono', style: 'font-size:11px',
      text: `扫描 ${tried} 组` + (st.secs == null ? '' : ` · 耗时 ${st.secs.toFixed(1)}s`) });
    const body = U.el('div', {});

    if (!combos.length) {
      body.appendChild(U.el('div', { class: 'empty-tip',
        text: '该网格没有产出有效组合，换个取值范围再试' }));
      return U.card('参数优化结果', body, head);
    }

    // 「存为研究笔记」：优化结论同样沉淀（标题后缀 ·优化<参数摘要>）
    const optSaveBtn = U.el('button', { class: 'btn sm', text: '存为研究笔记',
      title: '把本次优化结论（最优组合）写入本机记忆（rsrs）' });
    optSaveBtn.addEventListener('click', () => this.saveOptNote(d, optSaveBtn));

    const best = combos[0];
    const strat = ((State.settings && State.settings.strategies) || [])
      .find((x) => x.id === this.params.strategy_id);
    const stratName = strat ? strat.name : (this.params.strategy_id || '未选择策略');
    const bestBtn = U.el('button', {
      class: 'btn gold sm', text: '应用最优组合',
      title: '把最优组合写入策略 ' + stratName + '（只写本次网格扫到的参数）'
    });
    bestBtn.addEventListener('click', () => this.applyCombo(best.params, bestBtn));

    body.appendChild(U.el('div', { class: 'row', style: 'gap:6px;margin-bottom:9px;flex-wrap:wrap' },
      U.el('span', { class: 'chip on', text: '最优 ' + this.comboLabel(best.params) }),
      U.el('span', { class: 'chip mono', text: '总收益 ' + U.fx(best.total_return_pct, 2) + '%',
        style: 'color:' + (Number(best.total_return_pct) >= 0 ? 'var(--up)' : 'var(--down)') }),
      U.el('div', { class: 'spacer' }),
      bestBtn));

    const num = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    const pct = (v) => (num(v) ? { v: U.fx(v, 2) + '%', cls: U.cls(v), num: true }
      : { v: '--', cls: 'dim', num: true });

    const tbl = U.table([
      { label: '#' }, { label: '参数组合' },
      { label: '总收益%', num: true }, { label: '夏普', num: true },
      { label: '最大回撤%', num: true }, { label: '胜率%', num: true },
      { label: '交易数', num: true }, { label: '操作' }
    ], combos.map((c, i) => {
      // 回撤统一负号展示；-0 归一成 0，免得出现「-0.00%」
      const ddRaw = num(c.max_drawdown_pct) ? -Math.abs(Number(c.max_drawdown_pct)) : null;
      const dd = ddRaw === 0 ? 0 : ddRaw;
      const applyBtn = U.el('button', {
        class: i === 0 ? 'btn sm gold' : 'btn sm', text: '应用',
        title: '写入策略 ' + stratName + '：' + this.comboLabel(c.params)
      });
      applyBtn.addEventListener('click', (e) => { e.stopPropagation(); this.applyCombo(c.params, applyBtn); });
      return [
        i === 0
          ? { v: U.el('span', { class: 'mono', style: 'color:var(--gold);font-weight:600' },
              String(i + 1)), num: true }
          : { v: String(i + 1), cls: 'dim', num: true },
        { v: U.el('span', { class: 'mono' }, this.comboLabel(c.params)) },
        pct(c.total_return_pct),
        num(c.sharpe) ? { v: U.fx(c.sharpe, 2), cls: U.cls(c.sharpe), num: true }
          : { v: '--', cls: 'dim', num: true },
        dd === null ? { v: '--', cls: 'dim', num: true }
          : { v: U.fx(dd, 2) + '%', cls: 'down', num: true },
        num(c.win_rate_pct) ? { v: U.fx(c.win_rate_pct, 1) + '%', cls: '', num: true }
          : { v: '--', cls: 'dim', num: true },
        num(c.trades) ? { v: U.fx(c.trades, 0), cls: '', num: true }
          : { v: '--', cls: 'dim', num: true },
        applyBtn
      ];
    }));

    // top1 行左侧金色标记（列宽与配色沿用表格自身主题）
    U.$$('tbody tr', tbl).forEach((tr, i) => {
      if (i !== 0) return;
      const td = tr.querySelector('td');
      if (td) td.style.borderLeft = '2px solid var(--gold)';
      tr.title = '总收益最高组合：' + this.comboLabel(combos[0].params);
    });

    tbl.style.minWidth = '980px';
    tbl.insertBefore(U.el('colgroup', {},
      ['5%', '33%', '11%', '9%', '11%', '10%', '9%', '12%']
        .map((w) => U.el('col', { style: 'width:' + w }))), tbl.firstChild);

    // 横向滚动容器：与月度收益表同款（列多时不挤压）
    body.appendChild(U.el('div', { style: 'overflow-x:auto' }, tbl));
    body.appendChild(U.el('div', { class: 'dim', style: 'font-size:10.5px;margin-top:7px',
      text: '序号即排名，组合按总收益降序；参数组合形如「置信下限=40, 盈亏比下限=1.5」' +
        '；点「应用」把该行参数写进 ' + stratName + ' 并保存（只写本次网格扫到的键）' }));

    return U.card('参数优化结果', body, U.el('div', { class: 'row' }, head, optSaveBtn));
  },

  /* ---------- ECharts ---------- */
  pts(arr) {
    return (arr || [])
      .filter((p) => p && p.t != null && p.v != null && Number.isFinite(Number(p.v)))
      .map((p) => [Number(p.t) * 1000, Number(p.v)]);
  },

  timeAxis() {
    return {
      type: 'time',
      axisLine: { lineStyle: { color: '#2a3441' } },
      axisTick: { lineStyle: { color: '#2a3441' } },
      axisLabel: {
        color: '#64717f', fontSize: 10, hideOverlap: true,
        formatter: (v) => U.mdhm(Math.floor(v / 1000))
      },
      splitLine: { show: false }
    };
  },

  tipBase() {
    return {
      trigger: 'axis',
      backgroundColor: '#1a212c',
      borderColor: '#374354',
      textStyle: { color: '#e8eef5', fontSize: 11 },
      axisPointer: { lineStyle: { color: '#4a9eff', type: 'dashed' } }
    };
  },

  /** 权益图：series = [{name,data,color,area?,dashed?,thin?}]；markInit 为初始资金线 */
  initEquity(host, series, init, markInit) {
    if (typeof echarts === 'undefined') {
      host.appendChild(U.el('div', { class: 'chart-loading', text: '图表库未加载' }));
      return null;
    }
    const ok = (series || []).filter((s) => s.data && s.data.length >= 2);
    if (!ok.length) {
      host.appendChild(U.el('div', { class: 'empty-tip', text: '该区间权益序列不足，无法绘图' }));
      return null;
    }

    const chart = echarts.init(host);
    const axisTip = (ts) => U.mdhm(Math.floor(ts / 1000));

    chart.setOption({
      animationDuration: 420,
      grid: { left: 64, right: 22, top: 36, bottom: 30 },
      legend: {
        type: 'scroll', data: ok.map((s) => s.name), top: 2, right: 8,
        itemWidth: 16, itemHeight: 8,
        textStyle: { color: '#97a5b5', fontSize: 11 }
      },
      tooltip: Object.assign(this.tipBase(), {
        formatter: (ps) => {
          if (!ps || !ps.length) return '';
          const rows = ps.map((p) =>
            `<div style="display:grid;grid-template-columns:auto 1fr;gap:2px 16px;font-size:11px">` +
            `<span style="color:#97a5b5">${p.marker}${p.seriesName}</span>` +
            `<b style="font-family:var(--mono,monospace);text-align:right">${U.fx(p.value[1], 2)}</b></div>`
          ).join('');
          return `<div style="font-family:var(--mono,monospace);font-size:10.5px;color:#64717f;` +
            `margin-bottom:5px">${axisTip(ps[0].value[0])}</div>` + rows;
        }
      }),
      xAxis: this.timeAxis(),
      yAxis: {
        type: 'value', scale: true,
        splitLine: { lineStyle: { color: '#1e2632' } },
        axisLabel: { color: '#64717f', fontSize: 10, formatter: (v) => U.fx(v, 0) }
      },
      series: ok.map((s, i) => Object.assign({
        name: s.name, type: 'line', data: s.data,
        showSymbol: false, symbol: 'none', smooth: false,
        lineStyle: {
          width: s.thin ? 1.4 : 2,
          color: s.color,
          type: s.dashed ? 'dashed' : 'solid',
          opacity: s.dashed ? 0.85 : 1
        },
        itemStyle: { color: s.color }
      }, (s.area ? {
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(216,171,62,.26)' },
            { offset: 1, color: 'rgba(216,171,62,0)' }
          ])
        }
      } : {}), (markInit && i === 0 && Number.isFinite(Number(init)) ? {
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: '#374354', type: 'dashed', width: 1 },
          label: { color: '#64717f', fontSize: 10, formatter: '初始资金',
            position: 'insideEndTop' },
          data: [{ yAxis: Number(init) }]
        }
      } : {})))
    });

    this.bindResize();
    return chart;
  },

  /** 回撤图：pct ≤ 0 面积图，0 轴为基线，x 轴与权益图同期 */
  initDrawdown(host, dd, eqPts) {
    if (typeof echarts === 'undefined') return null;
    const data = (dd || [])
      .filter((p) => p && p.t != null && p.pct != null && Number.isFinite(Number(p.pct)))
      .map((p) => [Number(p.t) * 1000, Number(p.pct)]);
    if (data.length < 2) return null;

    const lo = Math.min(0, ...data.map((p) => p[1]));
    const hi = Math.max(0, ...data.map((p) => p[1]));
    const span = (hi - lo) || 1;

    const chart = echarts.init(host);
    chart.setOption({
      animationDuration: 420,
      grid: { left: 64, right: 22, top: 10, bottom: 8 },
      tooltip: Object.assign(this.tipBase(), {
        formatter: (ps) => {
          if (!ps || !ps.length) return '';
          const t = ps[0];
          return `<div style="font-family:var(--mono,monospace);font-size:10.5px;color:#64717f;` +
            `margin-bottom:5px">${U.mdhm(Math.floor(t.value[0] / 1000))}</div>` +
            `<div style="font-size:11px;color:#97a5b5">${t.marker}回撤 ` +
            `<b style="font-family:var(--mono,monospace);color:#ef5350">` +
            `${U.fx(t.value[1], 2)}%</b></div>`;
        }
      }),
      xAxis: Object.assign(this.timeAxis(), {
        min: eqPts && eqPts.length ? eqPts[0][0] : undefined,
        max: eqPts && eqPts.length ? eqPts[eqPts.length - 1][0] : undefined,
        axisLabel: { show: false }, axisTick: { show: false }
      }),
      yAxis: {
        type: 'value',
        min: lo - span * 0.08, max: 0,
        splitLine: { lineStyle: { color: '#1e2632' } },
        axisLabel: { color: '#64717f', fontSize: 10, formatter: (v) => U.fx(v, 1) + '%' }
      },
      series: [{
        name: '回撤', type: 'line', data,
        showSymbol: false, symbol: 'none', smooth: false,
        lineStyle: { width: 1.2, color: '#ef5350' },
        itemStyle: { color: '#ef5350' },
        areaStyle: {
          origin: 0,          // 从 0 轴基线向下填充
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(239,83,80,.06)' },
            { offset: 1, color: 'rgba(239,83,80,.42)' }
          ])
        },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: '#374354', width: 1 },
          label: { show: false },
          data: [{ yAxis: 0 }]
        }
      }]
    });

    this.bindResize();
    return chart;
  },

  bindResize() {
    if (!this._onResize) {
      this._onResize = () => {
        if (this.chart) this.chart.resize();
        if (this.ddChart) this.ddChart.resize();
      };
      window.addEventListener('resize', this._onResize);
    }
  },

  disposeChart() {
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
    for (const k of ['chart', 'ddChart']) {
      if (this[k]) {
        try { this[k].dispose(); } catch { /* 已销毁 */ }
        this[k] = null;
      }
    }
  },

  /* 切走 tab 或离开策略页：销毁图表、释放面板；参数与结果留在模块状态里 */
  unmount() {
    this.disposeChart();
    this._seq++;                 // 作废进行中的对比循环渲染
    this.stopOptTimer();         // 扫描中的请求继续跑，结果落回模块状态，再挂载即恢复
    this.optNodes = null;
    this.optResultHost = null;
    this.histHost = null;
    const h = this.hosts;
    if (h && h.host && h.host.isConnected) U.clear(h.host);
    this.hosts = null;
  }
};
