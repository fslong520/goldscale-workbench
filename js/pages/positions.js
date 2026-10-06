/* 持仓页：开仓表单、持仓列表、止盈止损操作 */

const PagePositions = {
  key: 'positions',
  title: '持仓',

  render(view) {
    // 重渲染前清空视图，否则旧内容会叠加，新页面被盖住
    U.clear(view);
    const page = U.el('div', { class: 'page' });
    const s = State.settings;

    // ---- 开仓表单 ----
    const dirSel = U.sel('long', [['long', '做多'], ['short', '做空']]);
    const entryIn = U.numInput(State.spot?.price ?? 0, { step: '0.01' });
    const slIn = U.numInput(0, { step: '0.01' });
    const tp1In = U.numInput(0, { step: '0.01' });
    const tp2In = U.numInput(0, { step: '0.01' });
    const lotIn = U.numInput(0.01, { step: '0.01', min: s.risk.min_lot, max: s.risk.max_lot });
    const noteIn = U.el('input', { type: 'text', placeholder: '备注（可选）' });

    const hint = U.el('div', { class: 'note' });

    // ---- 建议手数（风控联动，只读展示 + 手动填入；绝不自动开仓）----
    const sugTxt = U.el('span', { class: 'mono', style: 'color:var(--fg-3)' });
    const sugNote = U.el('span', { class: 'dim', style: 'font-size:11px;flex:1 1 180px' });
    const sugFill = U.el('button', {
      class: 'btn sm', text: '填入', disabled: 'disabled',
      title: '按风控口径反推的手数写进手数框（仍需自己点模拟开仓）'
    });
    sugFill.addEventListener('click', () => {
      const sug = this.suggestion();
      if (!sug) { U.toast('先填入场价与止损价，再取建议手数', 'warn'); return; }
      lotIn.value = sug.lot;
      U.toast('已填入建议手数 ' + U.fx(sug.lot, 2) + ' 手', 'ok');
    });
    const sugHost = U.el('div', { class: 'f', style: 'flex-direction:row;align-items:center;gap:8px' },
      U.el('span', { text: '建议手数' }), sugTxt, sugFill, sugNote);

    // ---- 今日还可亏（钱口径，与风控页、总览卡同源同式）----
    const budgetTxt = U.el('span', { class: 'mono dim', style: 'font-size:12px', text: '--' });
    const budgetNote = U.el('span', { class: 'dim', style: 'font-size:11px', text: '读取中…' });
    const budgetRow = U.el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 9px' },
      U.el('span', { style: 'font-size:11px;color:var(--fg-3)', text: '今日还可亏' }), budgetTxt, budgetNote);

    const refreshPrice = () => {
      if (State.spot) entryIn.value = U.fx(State.spot.price, 2);
      this.updateHint();
    };
    entryIn.addEventListener('input', () => this.updateHint());
    slIn.addEventListener('input', () => this.updateHint());
    tp1In.addEventListener('input', () => this.updateHint());

    // 真开仓（冷却确认层放行后也走这里，保证只有一条提交路径）
    const doOpen = async () => {
      openBtn.disabled = true;
      try {
        const p = await API.open({
          direction: dirSel.value,
          lot: parseFloat(lotIn.value),
          entry: parseFloat(entryIn.value),
          sl: parseFloat(slIn.value),
          tp1: parseFloat(tp1In.value),
          tp2: parseFloat(tp2In.value),
          note: noteIn.value,
          // 开仓归属：记入当前生效策略，日志据此显示「按哪条策略在跑」
          strategy_id: State.settings?.active_strategy || ''
        });
        U.toast(`已开仓 ${p.direction === 'long' ? '多' : '空'} ${p.lot} 手`, 'ok');
        await App.refreshPositions();
        this.render(view);
      } catch (e) {
        U.toast(e.message, 'err');
      } finally {
        openBtn.disabled = false;
      }
    };

    const openBtn = U.el('button', {
      class: 'btn gold', text: '模拟开仓',
      onclick: () => {
        // 亏损冷却软闸：最近一笔亏损且未过冷却期 → 先弹人话确认层（可关、纯本机）
        const hit = this.cooldownHit();
        if (hit) { this.showCooldown(hit, doOpen); return; }
        doOpen();
      }
    });

    const fromSignalBtn = U.el('button', {
      class: 'btn', text: '套用策略计划',
      onclick: () => {
        const p = State.signal?.plan;
        if (!p) return U.toast('先到信号页生成计划', 'err');
        dirSel.value = p.direction;
        entryIn.value = U.fx(p.entry, 2);
        slIn.value = U.fx(p.sl_price, 2);
        tp1In.value = U.fx(p.tp1_price, 2);
        tp2In.value = U.fx(p.tp2_price, 2);
        lotIn.value = p.lot;
        this.updateHint();
        U.toast('已套用', 'ok');
      }
    });

    const form = U.el('div', {},
      U.el('div', { class: 'g2' },
        U.field('方向', dirSel),
        U.field('手数（' + s.risk.min_lot + ' - ' + s.risk.max_lot + '）', lotIn)),
      sugHost,
      budgetRow,
      U.el('div', { class: 'g2' },
        U.field('入场价', entryIn),
        U.field('止损价', slIn)),
      U.el('div', { class: 'g2' },
        U.field('目标 TP1（先平 ' + s.exit.tp1_close_pct + '%）', tp1In),
        U.field('目标 TP2（再平 ' + s.exit.tp2_close_pct + '%）', tp2In)),
      U.field('备注', noteIn),
      hint,
      U.el('div', { class: 'btns', style: 'margin-top:9px' },
        openBtn, fromSignalBtn,
        U.el('button', { class: 'btn', text: '用现价填入', onclick: refreshPrice }))
    );

    // ---- 持仓列表 ----
    const listHost = U.el('div', {});
    const statHost = U.el('div', { class: 'stats' });
    const strategyHost = U.el('div', {});
    const logHost = U.el('div', {});

    page.appendChild(U.el('div', { class: 'g-main' },
      U.el('div', { style: 'display:flex;flex-direction:column;gap:11px' },
        U.card('运行策略', strategyHost,
          U.el('button', { class: 'btn sm', text: '信号页分析', onclick: () => App.go('signal') })),
        U.card('当前持仓', listHost,
          U.el('div', { class: 'btns' },
            U.el('button', { class: 'btn sm', text: '刷新', onclick: () => this.render(view) }),
            U.el('button', {
              class: 'btn sm', text: '重置今日计数',
              title: '清空日内单数与今日盈亏，调参测试时用',
              onclick: async () => {
                if (!confirm('重置今日单数与今日盈亏？持仓不受影响。')) return;
                try {
                  U.toast(await API.resetDaily(), 'ok');
                  this.renderStats();
                } catch (e) { U.toast(e.message, 'err'); }
              }
            }))),
        U.card('交易日志', logHost,
          U.el('button', { class: 'btn sm', text: '复盘页', onclick: () => App.go('review') })),
        U.card('账户统计', statHost)),
      U.card('模拟开仓', form)));

    view.appendChild(page);

    this.hosts = {
      listHost, statHost, strategyHost, logHost, hint, entryIn, slIn, tp1In, lotIn, sugTxt, sugNote, sugFill,
      budgetTxt, budgetNote
    };
    this.renderStrategy();
    this.updateHint();
    this.updateBudget();
    this.renderList();
    this.renderStats();
    this.renderLog();

    if (!entryIn.value || parseFloat(entryIn.value) === 0) refreshPrice();
  },

  /** 运行策略卡：生效策略 + 生效/停用徽章 + 口径行（数据源 State.settings，不新增请求） */
  renderStrategy() {
    const { strategyHost } = this.hosts || {};
    if (!strategyHost || !strategyHost.isConnected) return;
    U.clear(strategyHost);
    const s = State.settings || {};
    const list = s.strategies || [];
    const act = list.find((x) => x.id === s.active_strategy) || list[0];
    if (!act) {
      strategyHost.appendChild(U.el('div', { class: 'empty-tip', text: '尚未配置策略：请到策略页新建并保存策略。' }));
      return;
    }
    strategyHost.append(
      U.el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
        U.el('b', { style: 'color:var(--fg);font-size:15px', text: act.name }),
        U.el('span', { class: 'chip' + (act.enabled ? ' on' : ''), text: act.enabled ? '生效' : '停用' }),
        U.el('span', { class: 'dim mono', style: 'font-size:11px', text: act.id })),
      // 口径行与信号页策略卡同款文案格式
      U.el('div', { class: 'dim', style: 'font-size:11px;margin-top:9px' },
        `执行 ${U.ivLabel(act.exec_interval)} · 定方向 ${U.ivLabel(act.dir_interval)} · 确认 ${U.ivLabel(act.confirm_interval)}` +
        ` · 盈亏比 ≥ ${U.fx(act.rr_min, 1)} · 风险 ${U.fx(act.risk_percent, 1)}%` +
        ` · 做多${act.allow_long ? '允许' : '禁止'} · 做空${act.allow_short ? '允许' : '禁止'}`),
      U.el('div', { class: 'note', style: 'margin-top:9px' },
        '本页开仓默认记入该策略；点右上【信号页分析】让 AI 按这条策略研判当下行情。'));
  },

  /** 交易日志卡：最近 50 笔平仓，倒序 */
  async renderLog() {
    const { logHost } = this.hosts || {};
    if (!logHost || !logHost.isConnected) return;
    try {
      // 复用列表已取的账本；首屏尚未加载时自行取一次
      const all = State.positions?.length ? State.positions : await API.positions();
      State.positions = all;
      const closed = all.filter((p) => p.status === 'closed')
        .sort((a, b) => (b.closed_at || 0) - (a.closed_at || 0));
      const recent = closed.slice(0, 50);
      U.clear(logHost);

      if (!recent.length) {
        logHost.appendChild(U.el('div', { class: 'empty-tip', text: '还没有平仓记录' }));
        return;
      }

      // 口径与后端 /api/stats 一致：pnl 为 0 的记录不计入胜负
      const judged = recent.filter((p) => p.pnl !== 0);
      const wins = judged.filter((p) => p.pnl > 0).length;
      const net = recent.reduce((a, p) => a + (p.pnl || 0), 0);
      const wr = judged.length ? (wins / judged.length) * 100 : 0;

      logHost.appendChild(U.el('div', { class: 'dim', style: 'font-size:11px;margin-bottom:9px' },
        `共 ${closed.length} 笔 · 胜率 ${U.fx(wr, 1)}% · 累计盈亏 `,
        U.el('span', { class: U.cls(net), text: U.money(net) }),
        closed.length > 50 ? '（以上为最近 50 笔汇总）' : ''));

      const rows = recent.map((p) => {
        const isLong = p.direction === 'long';
        // 单元格用 {v,num,cls} 数据对象；DOM 元素要走本页 grid() 的 Node 分支
        return [
          { v: U.full(p.closed_at), cls: 'dim' },
          { v: p.strategy_name || '—', cls: p.strategy_name ? '' : 'dim' },
          { v: isLong ? '多' : '空', cls: isLong ? 'up' : 'down' },
          { v: U.px(p.entry) + ' → ' + U.px(p.close_price) },
          { v: (p.opened_lot || p.lot) > 0 ? U.fx(p.opened_lot || p.lot, 2) : '—', num: true },
          { v: U.money(p.pnl), num: true, cls: U.cls(p.pnl) }
        ];
      });

      logHost.appendChild(U.el('div', { style: 'overflow-x:auto' }, this.grid([
        { label: '平仓时间' }, { label: '策略' }, { label: '方向' },
        { label: '开仓 → 平仓' }, { label: '手数', num: true }, { label: '盈亏', num: true }
      ], rows)));
    } catch (e) {
      U.clear(logHost);
      logHost.appendChild(U.el('div', { class: 'note err', text: '交易日志读取失败：' + e.message }));
    }
  },

  /** 本页表格：U.table 现在把 DOM 元素当数据对象渲染成空单元格，而本页操作列必须放按钮，
   * 故自带一份最小实现（class 与 U.table 一致，只在本页使用）。 */
  grid(headers, rows) {
    const th = headers.map((h) => U.el('th', { class: h.num ? 'num' : '', text: h.label ?? h }));
    const trs = rows.map((cells) => U.el('tr', {}, cells.map((c) => {
      if (c instanceof Node) return U.el('td', {}, c);
      if (c && typeof c === 'object') {
        return U.el('td', { class: (c.num ? 'num ' : '') + (c.cls || '') }, c.v);
      }
      return U.el('td', {}, c);
    })));
    return U.el('table', { class: 'grid' },
      U.el('thead', {}, U.el('tr', {}, th)),
      U.el('tbody', {}, trs));
  },

  /** 复刻后端 risk::calc_lot：equity × 风险% ÷ (止损点数 × 点值 × 合约) → 步长取整 → clamp 上下限。
   *  equity 取 /api/stats 的权益（无则 settings.equity）；风险% 取生效策略（settings.strategy，
   *  与后端 risk::plan 同源）；手数上下限与步长取 settings.risk。entry/sl 未填或为 0 → null。 */
  suggestion() {
    const s = State.settings;
    const h = this.hosts || {};
    if (!s || !h.entryIn || !h.slIn) return null;
    const entry = parseFloat(h.entryIn.value || 0);
    const sl = parseFloat(h.slIn.value || 0);
    if (!(entry > 0) || !(sl > 0)) return null;
    const pv = s.point_value;
    if (!(pv > 0) || !(s.contract_size > 0)) return null;
    const slPts = Math.abs(entry - sl) / pv;
    if (!(slPts > 0)) return null;
    const perLot = slPts * pv * s.contract_size;   // 每手承受一个止损距离的美元
    if (!(perLot > 0)) return null;
    const equity = (State.stats && State.stats.equity > 0) ? State.stats.equity : s.equity;
    if (!(equity > 0)) return null;
    const riskPct = (s.strategy && s.strategy.risk_percent > 0)
      ? s.strategy.risk_percent : (s.risk.equity_risk_pct || 1);
    const step = s.risk.lot_step > 0 ? s.risk.lot_step : 0.01;
    const raw = equity * riskPct / 100 / perLot;
    const stepped = Math.round(raw / step) * step;   // 与后端 round_step 一致
    const minLot = s.risk.min_lot, maxLot = s.risk.max_lot;
    let lot = Math.min(Math.max(stepped, minLot), maxLot);
    lot = Math.round(lot * 100) / 100;               // 与后端一致：最终保留 2 位
    return { lot, floored: stepped < minLot, capped: stepped > maxLot, slPts, riskPct, equity };
  },

  /** 建议手数行：只读展示 + 依据说明；entry/sl 未填即置灰 */
  updateSuggestion() {
    const h = this.hosts || {};
    if (!h.sugTxt || !h.sugTxt.isConnected) return;
    const sug = this.suggestion();
    if (!sug) {
      h.sugTxt.textContent = '--';
      h.sugTxt.style.color = 'var(--fg-3)';
      h.sugNote.textContent = '填入场价与止损价后，按风控口径自动反推';
      h.sugFill.disabled = true;
      return;
    }
    h.sugTxt.textContent = U.fx(sug.lot, 2) + ' 手';
    h.sugTxt.style.color = sug.lot > 0 ? 'var(--fg)' : 'var(--warn)';
    h.sugFill.disabled = false;
    const parts = [`权益 ${U.fx(sug.equity, 0)} · 风险 ${U.fx(sug.riskPct, 1)}% · 止损 ${sug.slPts.toFixed(0)} 点`];
    if (sug.floored) parts.push('低于风控下限，按下限');
    if (sug.capped) parts.push('超风控上限，按上限');
    h.sugNote.textContent = parts.join(' · ');
  },

  updateHint() {
    const { hint, entryIn, slIn, tp1In } = this.hosts || {};
    this.updateSuggestion();   // 入场/止损一变，建议手数同步重算
    if (!hint || !hint.isConnected) return;
    const s = State.settings;
    const entry = parseFloat(entryIn.value || 0);
    const sl = parseFloat(slIn.value || 0);
    const tp = parseFloat(tp1In.value || 0);

    if (!entry || !sl || !tp) {
      hint.className = 'note';
      hint.textContent = '填入入场、止损、目标价后自动校验盈亏比与风控。';
      return;
    }
    const slPts = Math.abs(entry - sl) / s.point_value;
    const tpPts = Math.abs(tp - entry) / s.point_value;
    const rr = slPts > 0 ? tpPts / slPts : 0;
    const errs = [];
    // 与后端一致留容差，避免 1.8 被浮点算成 1.7999 误判
    if (rr < s.strategy.rr_min - Math.abs(s.strategy.rr_min) * 0.001) {
      errs.push(`盈亏比 ${rr.toFixed(2)} 低于 ${s.strategy.rr_min}`);
    }
    if (slPts < s.risk.min_sl_points || slPts > s.risk.max_sl_points)
      errs.push(`止损 ${slPts.toFixed(0)} 点超出 ${s.risk.min_sl_points}-${s.risk.max_sl_points}`);
    if (s.spread_points > s.risk.max_spread_points)
      errs.push(`点差 ${s.spread_points} 超限`);

    hint.className = 'note ' + (errs.length ? 'warn' : 'ok');
    hint.textContent = errs.length
      ? '将被拦截：' + errs.join('；')
      : `校验通过 · 止损 ${slPts.toFixed(0)} 点 · 目标 ${tpPts.toFixed(0)} 点 · 盈亏比 ${rr.toFixed(2)}`;
  },

  async renderList() {
    const { listHost } = this.hosts || {};
    if (!listHost || !listHost.isConnected) return;
    const s = State.settings;
    try {
      const all = await API.positions();
      State.positions = all;
      const open = all.filter((p) => p.status === 'open');
      U.clear(listHost);

      if (!open.length) {
        listHost.appendChild(U.el('div', { class: 'empty-tip', text: '当前无持仓' }));
        return;
      }

      const rows = open.map((p) => {
        const isLong = p.direction === 'long';
        const cur = State.spot?.price ?? p.current;
        const pnl = (isLong ? cur - p.entry : p.entry - cur) * p.lot * s.contract_size;
        const pnlPct = (pnl / s.equity) * 100;

        const actions = U.el('div', { class: 'btns' },
          U.el('button', { class: 'btn sm', text: '平一半', onclick: () => this.act('partial', p.id, 50) }),
          U.el('button', { class: 'btn sm', text: '手动平仓', onclick: () => this.act('close', p.id) }),
          U.el('button', { class: 'btn sm', text: '改止损', onclick: () => this.promptSL(p) }));

        return [
          U.el('span', { class: isLong ? 'up' : 'down', text: isLong ? '多' : '空' }),
          U.el('span', { text: U.fx(p.lot, 2) }),
          U.el('span', { text: U.px(p.entry) }),
          U.el('span', { text: U.px(cur) }),
          U.el('span', { class: 'down', text: U.px(p.trail_sl) }),
          U.el('span', { class: 'up', text: U.px(p.tp1) }),
          U.el('span', { class: 'up', text: U.px(p.tp2) }),
          U.el('span', {
            text: (p.tp1_done ? '✓' : '·') + (p.tp2_done ? '✓' : '·') +
              (p.trail_active ? '移' : ' '),
            class: p.trail_active ? 'up' : 'dim'
          }),
          U.el('span', { class: U.cls(pnl), text: U.money(pnl) }),
          U.el('span', { class: U.cls(pnlPct), text: U.signed(pnlPct) + '%' }),
          U.el('span', { class: 'dim', text: U.mdhm(p.opened_at) }),
          actions
        ];
      });

      listHost.appendChild(this.grid([
        { label: '向' }, { label: '手数', num: true }, { label: '入场', num: true },
        { label: '现价', num: true }, { label: '止损', num: true },
        { label: 'TP1', num: true }, { label: 'TP2', num: true },
        { label: '状态' }, { label: '浮盈', num: true }, { label: '', num: true },
        { label: '开仓时间' }, { label: '操作' }
      ], rows));
    } catch (e) {
      U.clear(listHost);
      listHost.appendChild(U.el('div', { class: 'note err', text: '持仓读取失败：' + e.message }));
    }
  },

  async renderStats() {
    const { statHost } = this.hosts || {};
    if (!statHost || !statHost.isConnected) return;
    try {
      const st = await API.stats();
      State.stats = st;
      U.clear(statHost);
      statHost.append(
        U.stat('权益', U.fx(st.equity, 2), '余额 ' + U.fx(st.balance, 2)),
        U.stat('浮动盈亏', U.money(st.floating), null, U.cls(st.floating)),
        U.stat('持仓数', String(st.open_count)),
        U.stat('今日单数', `${st.daily_count} / ${State.settings.risk.max_daily_trades}`,
          null, st.daily_count >= State.settings.risk.max_daily_trades ? 'down' : ''),
        U.stat('今日盈亏', U.money(st.daily_pnl), null, U.cls(st.daily_pnl)),
        U.stat('胜率', U.fx(st.win_rate, 1) + '%', `${st.wins} 胜 ${st.losses} 负`),
        U.stat('净盈亏', U.money(st.net_pnl), `共 ${st.total_closed} 笔`, U.cls(st.net_pnl)),
        U.stat('盈亏因子',
          st.total_closed === 0 ? '--' : (st.profit_factor == null ? '∞' : U.fx(st.profit_factor, 2)),
          st.total_closed === 0 ? '暂无成交' : (st.profit_factor == null ? '无亏损笔' : null),
          st.total_closed === 0 ? 'dim' : (st.profit_factor == null || st.profit_factor >= 1 ? 'up' : 'down'))
      );
      // 权益到手后，建议手数按真实权益重算一遍
      this.updateSuggestion();
      this.updateBudget();
    } catch (e) {
      U.clear(statHost);
      statHost.appendChild(U.el('div', { class: 'note err', text: e.message }));
      this.updateBudget(true);
    }
  },

  async act(kind, id, pct) {
    try {
      let msg;
      if (kind === 'close') msg = await API.close(id);
      else msg = await API.closePartial(id, pct);
      U.toast(msg, 'ok');
      await App.refreshPositions();
      this.reportClose(id);          // 行为层：按账本实况上报平仓事件（亏损 / 连胜）
      this.renderList();
      this.renderStats();
      this.renderLog();
    } catch (e) {
      U.toast(e.message, 'err');
    }
  },

  /** 行为层上报（fire-and-forget，agentd 不在线即静默）：
   *  平仓亏损 → loss_closed；同策略连续盈利每满 3 笔 → streak_win。
   *  只认账本实况：这笔没在账本里落成「已平仓」就不报（手工部分平仓后端未回写 pnl，算不出就不发）。 */
  reportClose(id) {
    const all = State.positions || [];
    const p = all.find((x) => x.id === id);
    if (!p || p.status !== 'closed') return;
    const pnl = typeof p.pnl === 'number' && isFinite(p.pnl) ? p.pnl : 0;
    const sid = p.strategy_id || '';
    if (pnl < 0) {
      window.GSEvent?.post?.('loss_closed', {
        pnl: Math.round(pnl * 100) / 100, strategy_id: sid, direction: p.direction,
        entry: p.entry, exit: p.close_price
      });
      return;
    }
    if (pnl <= 0) return;                            // pnl 为 0：不计胜负，不报
    // 连盈：同策略按平仓时间倒序，从最新往前数连续盈利笔数（遇到不盈利即断）
    const mine = all
      .filter((x) => x.status === 'closed' && (x.strategy_id || '') === sid && x.closed_at)
      .sort((a, b) => b.closed_at - a.closed_at);
    let n = 0;
    for (const x of mine) { if (x.pnl > 0) n++; else break; }
    if (n >= 3 && n % 3 === 0) {                     // 3、6、9 连盈各报一次，不重复刷
      window.GSEvent?.post?.('streak_win', {
        streak: n, strategy_id: sid, pnl: Math.round(pnl * 100) / 100
      });
    }
  },

  /** 今日还可亏：与风控页、总览卡共用 Behavior.todayBudget（后端 risk::gate_check 同式）。
   *  stats 未到手写「读取中…」，读取失败写失败，字段未上线写 `--`——绝不编数。 */
  updateBudget(failed) {
    const h = this.hosts || {};
    if (!h.budgetTxt || !h.budgetTxt.isConnected) return;
    const s = State.settings || {};
    const b = window.Behavior?.todayBudget?.(State.stats, s.risk, s.equity);
    if (!b || !b.ok) {
      h.budgetTxt.textContent = '--';
      h.budgetTxt.className = 'mono dim';
      h.budgetNote.textContent = b && b.why === 'off' ? '未启用每日亏损预算'
        : b && b.why === 'missing' ? '服务端未提供该字段'
        : failed ? '账户数据读取失败' : '读取中…';
      return;
    }
    h.budgetTxt.textContent = window.Behavior.usd(b.remaining);
    h.budgetTxt.className = 'mono ' + (b.remaining > 0 ? 'up' : 'down');
    h.budgetNote.textContent = window.Behavior.budgetNote(b)
      + (b.over ? ' · 已达预算，开仓将被拦截' : '');
  },

  /** 亏损冷却判据：本机开关开着、本会话尚未确认过、最近一笔平仓为亏损且距今不足阈值分钟。
   *  只看账本实况（State.positions），不另存标记；任何异常一律不拦人。 */
  cooldownHit() {
    try {
      if (!window.Cooldown || !window.Cooldown.on()) return null;
      if (window.Cooldown.acked()) return null;      // 点过「我确认」：本次会话不再弹
      const min = window.Cooldown.min();
      const closed = (State.positions || [])
        .filter((p) => p.status === 'closed' && p.pnl < 0 && p.closed_at)
        .sort((a, b) => b.closed_at - a.closed_at);
      const last = closed[0];
      if (!last) return null;
      const ageMin = (Date.now() / 1000 - last.closed_at) / 60;
      if (!(ageMin >= 0 && ageMin < min)) return null;
      return { pnl: last.pnl, closed_at: last.closed_at, min: min };
    } catch { return null; }
  },

  /** 亏损冷却确认层：人话、可关、可退；用项目现成的 .modal-mask 遮罩，不用 window.confirm。
   *  「缓一缓，返回」是默认焦点，Esc 同缓一缓；点「我确认，继续开仓」才记会话级标记并真开。 */
  showCooldown(info, onGo) {
    const mask = U.el('div', { class: 'modal-mask on' });
    const back = U.el('button', { class: 'btn gold', text: '缓一缓，返回' });
    const go = U.el('button', { class: 'btn sm cd-go', text: '我确认，继续开仓' });
    const close = () => {
      document.removeEventListener('keydown', onKey);
      mask.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    back.addEventListener('click', close);
    go.addEventListener('click', () => {
      try { window.Cooldown?.ack?.(); } catch { /* 存储被禁：照常放行 */ }
      close();
      onGo();
    });
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey);

    mask.appendChild(U.el('div', { class: 'modal cooldown-modal' },
      U.el('div', { class: 'cd-title', text: '先缓一缓，再决定' }),
      U.el('div', { class: 'cd-body' },
        '刚经历亏损单（',
        U.el('b', { text: U.hhmmss(info.closed_at).slice(0, 5) + ' 平仓，-' + window.Behavior.usd(Math.abs(info.pnl)) }),
        '），亏损后 ', U.el('b', { text: String(info.min) }),
        ' 分钟内交易的胜率通常更低。先缓一缓，真要继续请点下方确认。'),
      U.el('div', { class: 'cd-note', text: '本提醒只在本机浏览器内生效（按 Esc 可直接返回），可在风控页的「行为提醒」里关掉。' }),
      U.el('div', { class: 'btns' }, go, back)));
    document.body.appendChild(mask);
    back.focus();
  },

  async promptSL(p) {
    const v = prompt('新止损价：', p.trail_sl.toFixed(2));
    if (v === null) return;
    const n = parseFloat(v);
    if (!n || n <= 0) return U.toast('价格无效', 'err');
    try {
      U.toast(await API.setSL(p.id, n), 'ok');
      this.renderList();
    } catch (e) { U.toast(e.message, 'err'); }
  },

  tick() {
    if (!this.hosts) return;
    this.renderList();
  },

  destroy() { this.hosts = null; }
};