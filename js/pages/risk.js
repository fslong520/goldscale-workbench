/* 风控页：风险与出场参数
 * 另含行为层两件：① 顶部「今日可亏」额度卡（与开仓表单、总览卡同式，数据 /api/stats + settings.risk）
 * ② 「行为提醒」卡（亏损冷却开关与时长，纯本机 localStorage，不入服务端设置）
 */

const PageRisk = {
  key: 'risk',
  title: '风控',

  render(view) {
    // 重渲染前清空视图，否则旧内容会叠加，新页面被盖住
    U.clear(view);
    const page = U.el('div', { class: 'page' });
    const s = State.settings;
    const r = s.risk, e = s.exit;

    // 今日可亏额度卡挂载点（先出占位，取到 /api/stats 再填真值）
    const budgetHost = U.el('div', { class: 'stats' });

    // U.field 返回的是 <label>（标题＋输入），直接对它取 .value 永远是 undefined——
    // 数值字段必须取其中真正的 <input>，否则保存只会写回兜底默认值（本轮修，勿改回）。
    const mk = (label, val, step, min, max) => {
      const input = U.numInput(val, { step, min, max });
      const field = U.field(label, input);
      field.inp = input;
      return field;
    };
    /** 取 mk 字段里的输入值（时间/复选框等直接创建的控件不走这里） */
    const iv = (field) => (field && field.inp ? field.inp.value : '');

    const equity = mk('账户权益（美元）', s.equity, '100', '100', null);
    const spread = mk('当前点差（点）', s.spread_points, '1', '0', null);
    const riskPct = mk('单笔风险 %', r.equity_risk_pct, '0.1', '0.1', '20');
    const minLot = mk('最小手数', r.min_lot, '0.01', '0.01');
    const maxLot = mk('最大手数', r.max_lot, '0.01', '0.01');
    const lotStep = mk('手数步长', r.lot_step, '0.01', '0.01');
    const minSl = mk('最小止损（点）', r.min_sl_points, '10', '0');
    const maxSl = mk('最大止损（点）', r.max_sl_points, '10', '0');
    const maxTrades = mk('日内最多单数', r.max_daily_trades, '1', '1');
    const maxSpread = mk('点差上限（点）', r.max_spread_points, '1', '0');

    const sessStart = U.el('input', { type: 'time', value: r.session_start });
    const sessEnd = U.el('input', { type: 'time', value: r.session_end });
    const evBlock = U.el('input', { type: 'checkbox', checked: r.event_block });
    const evMin = U.numInput(r.event_block_minutes, { step: '5', min: '0' });

    const tp1 = mk('TP1 平仓比例 %', e.tp1_close_pct, '5', '0', '100');
    const tp2 = mk('TP2 平仓比例 %', e.tp2_close_pct, '5', '0', '100');
    const trailMult = mk('ATR 移动止损倍数', e.trail_atr_mult, '0.1', '0.1', '10');
    const beTrig = mk('保本触发点数', e.be_trigger_points, '5', '0');
    const beLock = mk('保本锁定点数', e.be_lock_points, '5', '0');
    const flip = U.el('input', { type: 'checkbox', checked: e.flip_exit });
    const cycle = mk('盯盘间隔（秒）', e.cycle_sec, '5', '5');

    const contractSize = mk('合约规格（盎司/手）', s.contract_size, '1', '1');
    const pointValue = mk('点值（美元/盎司/点）', s.point_value, '0.01', '0.001');

    // ---- 行为提醒：亏损冷却（纯前端 localStorage，改完立即生效，不走保存按钮）----
    const cdOn = U.el('input', { type: 'checkbox', checked: !!window.Cooldown?.on?.() });
    const cdMin = U.numInput(window.Cooldown?.min?.() ?? 15, { step: '1', min: '1', max: '120' });
    cdMin.style.maxWidth = '160px';   // 两位数的小字段不必撑满整栏
    const cdState = U.el('span', { class: 'dim', style: 'font-size:11px' });
    const paintCd = () => {
      cdState.textContent = cdOn.checked
        ? `亏损平仓后 ${cdMin.value || 15} 分钟内的首次开仓，会先弹一次确认`
        : '已关闭：开仓不再弹确认';
    };
    cdOn.addEventListener('change', () => {
      window.Cooldown?.setOn?.(cdOn.checked);
      U.toast(cdOn.checked ? '亏损冷却提醒已开启' : '亏损冷却提醒已关闭');
      paintCd();
    });
    cdMin.addEventListener('change', () => {
      const v = window.Cooldown?.setMin?.(cdMin.value) ?? 15;
      cdMin.value = v;
      U.toast('冷却时长已设为 ' + v + ' 分钟');
      paintCd();
    });
    paintCd();

    const saveBtn = U.el('button', { class: 'btn gold', text: '保存风控设置' });

    const collect = () => ({
      equity: parseFloat(iv(equity)) || 10000,
      spread_points: parseFloat(iv(spread)) || 0,
      contract_size: parseFloat(iv(contractSize)) || 100,
      point_value: parseFloat(iv(pointValue)) || 0.01,
      // 展开旧值再覆盖本页字段：本页没给出编辑入口的字段（如 daily_loss_budget_pct）
      // 必须原样带回去，否则保存风控会把别人加的字段抹成缺省。
      risk: {
        ...r,
        equity_risk_pct: parseFloat(iv(riskPct)) || 1,
        min_lot: parseFloat(iv(minLot)) || 0.01,
        max_lot: parseFloat(iv(maxLot)) || 5,
        lot_step: parseFloat(iv(lotStep)) || 0.01,
        min_sl_points: parseFloat(iv(minSl)) || 0,
        max_sl_points: parseFloat(iv(maxSl)) || 800,
        max_daily_trades: parseInt(iv(maxTrades)) || 6,
        max_spread_points: parseFloat(iv(maxSpread)) || 35,
        session_start: sessStart.value || '00:00',
        session_end: sessEnd.value || '23:59',
        event_block: evBlock.checked,
        event_block_minutes: parseInt(evMin.value) || 30
      },
      exit: {
        ...e,
        tp1_close_pct: parseFloat(iv(tp1)) || 0,
        tp2_close_pct: parseFloat(iv(tp2)) || 0,
        trail_atr_mult: parseFloat(iv(trailMult)) || 1.5,
        be_trigger_points: parseFloat(iv(beTrig)) || 0,
        be_lock_points: parseFloat(iv(beLock)) || 0,
        flip_exit: flip.checked,
        cycle_sec: parseInt(iv(cycle)) || 15
      }
    });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await API.saveSettings({ ...s, ...collect() });
        await App.reloadSettings();
        U.toast('风控设置已保存', 'ok');
        this.render(view);
      } catch (e) {
        U.toast(e.message, 'err');
      } finally {
        saveBtn.disabled = false;
      }
    });

    page.appendChild(budgetHost);

    page.appendChild(U.el('div', { class: 'g2' },
      U.card('账户与手数', U.el('div', {},
        U.el('div', { class: 'g2' },
          equity, spread),
        U.el('div', { class: 'g3' },
          riskPct, minLot, maxLot),
        U.el('div', { class: 'g3' },
          lotStep, contractSize, pointValue))),

      U.card('拦截阈值', U.el('div', {},
        U.el('div', { class: 'g2' },
          minSl, maxSl),
        U.el('div', { class: 'g2' },
          maxTrades, maxSpread),
        U.el('div', { class: 'g2' },
          U.field('交易时段开始', sessStart),
          U.field('交易时段结束', sessEnd)),
        U.el('div', { class: 'g2' },
          U.el('label', { class: 'switch', style: 'align-self:end;padding-bottom:8px' },
            evBlock, ' 重大事件封锁'),
          evMin)))
    ));

    page.appendChild(U.card('行为提醒（只存本机浏览器，不入服务端设置）', U.el('div', {},
      U.el('div', { class: 'row', style: 'margin-bottom:8px' },
        U.el('label', { class: 'switch' }, cdOn, ' 亏损后冷却提醒')),
      U.el('div', { class: 'g3' },
        U.field('冷却时长（分钟）', cdMin)),
      cdState,
      U.el('div', { class: 'note', style: 'margin-top:9px' },
        '改完立即生效，不必点上面的保存；确认过一次后本次会话不再弹（关掉标签页即重置）。'))));

    page.appendChild(U.card('出场管理', U.el('div', {},
      U.el('div', { class: 'g3' },
        tp1, tp2, trailMult),
      U.el('div', { class: 'g3' },
        beTrig, beLock, cycle),
      U.el('div', { class: 'row', style: 'margin-bottom:10px' },
        U.el('label', { class: 'switch' }, flip, ' 趋势反转即离场')),
      U.el('div', { class: 'note' },
        'TP1 与 TP2 的比例之和应小于 100%，剩余仓位由 ATR 移动止损跟进。'),
      U.el('div', { class: 'btns', style: 'margin-top:12px' }, saveBtn))));

    page.appendChild(U.el('div', { class: 'note warn' },
      '所有参数只影响本地模拟计算与风控判定，不会向任何券商发送委托。' +
      '接入真实交易前请务必在模拟环境充分验证。'));

    view.appendChild(page);
    this.hosts = { budgetHost };
    // 今日可亏先按 settings 占位，取到 /api/stats（含今日已实现盈亏）再填真值
    this.renderBudget(budgetHost);
    API.stats()
      .then((st) => { State.stats = st; this.renderBudget(budgetHost); })
      .catch(() => this.renderBudget(budgetHost, true));
  },

  /** 今日可亏额度：预算 = 权益 × pct/100，剩余 = 预算 + daily_pnl（亏为负即扣减），clamp ≥0。
   *  与开仓表单、总览卡共用 Behavior.todayBudget，保证三处同值；取不到就 -- 加原因，绝不编数。 */
  renderBudget(host, failed) {
    if (!host || !host.isConnected) return;
    const s = State.settings || {};
    U.clear(host);
    const b = window.Behavior?.todayBudget?.(State.stats, s.risk, s.equity);
    if (!b || !b.ok) {
      const why = b ? b.why : 'nodata';
      host.appendChild(U.stat('今日可亏', '--',
        why === 'off' ? '未启用每日亏损预算'
          : why === 'missing' ? '服务端未提供 daily_loss_budget_pct'
          : failed ? '账户数据读取失败' : '读取中…', 'dim'));
      return;
    }
    host.appendChild(U.stat('今日可亏', U.fx(b.remaining, 2),
      window.Behavior.budgetNote(b) + (b.over ? ' · 已达预算，开仓会被拦截' : ''),
      b.remaining > 0 ? 'up' : 'down'));
    host.appendChild(U.stat('今日亏损预算', U.fx(b.budget, 2),
      '按权益 ' + U.fx(b.equity, 0) + ' × ' + U.fx(b.pct, 1) + '%'));
  },

  destroy() { this.hosts = null; }
};