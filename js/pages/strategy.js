/* 策略页：多策略库管理 + 参数 + 个人口径 + 可视化条件行编辑 */

/* ---------- 可视化条件编辑器：枚举与模板库 ----------
 * 契约（后端并行开发中，字段名已锁定）：
 *   策略新增 entry_long / entry_short / exit_conditions 三数组，
 *   Condition = { id, logic:'and'|'or', left, op, right:{kind:'number',value} | {kind:'indicator',name}, period }
 *   period 仅 n_high / n_low / pct_change 生效（缺省 20）；逻辑严格左结合（首行连接符无意义）。 */

/** 左侧指标枚举（契约锁定顺序） */
const COND_METRICS = [
  ['close', '收盘价'], ['ema20', 'EMA20'], ['ema50', 'EMA50'], ['ema200', 'EMA200'],
  ['boll_up', '布林上轨'], ['boll_mid', '布林中轨'], ['boll_low', '布林下轨'],
  ['rsi14', 'RSI14'], ['atr14', 'ATR14'],
  ['n_high', 'N日最高'], ['n_low', 'N日最低'], ['pct_change', 'N根涨跌幅%'],
  ['dev_ema20', '偏离EMA20%']
];

/** 运算枚举 */
const COND_OPS = [
  ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '='],
  ['cross_above', '上穿'], ['cross_below', '下穿']
];

/** 右侧指标枚举（上穿/下穿专用；含 N日最高/最低以支撑「突破 20 日高/低」模板） */
const COND_RIGHT_METRICS = [
  ['ema20', 'EMA20'], ['ema50', 'EMA50'], ['ema200', 'EMA200'],
  ['boll_up', '布林上轨'], ['boll_mid', '布林中轨'], ['boll_low', '布林下轨'],
  ['rsi14', 'RSI14'], ['close', '收盘价'],
  ['n_high', 'N日最高'], ['n_low', 'N日最低']
];

/** 需要「周期」输入的指标（左侧或右侧命中即显示） */
const COND_PERIOD_SET = new Set(['n_high', 'n_low', 'pct_change']);

const COND_MAX_ROWS = 12;

/** 三条件组 */
const COND_GROUPS = [
  { key: 'entry_long', title: '做多入场条件' },
  { key: 'entry_short', title: '做空入场条件' },
  { key: 'exit_conditions', title: '出场条件' }
];

/** 经典模板库（套用即覆盖所在组，套用前 confirm） */
const COND_TEMPLATES = [
  { key: 'ma_golden', label: '均线金叉 → 做多',
    conds: [{ left: 'ema20', op: 'cross_above', right: { kind: 'indicator', name: 'ema50' } }] },
  { key: 'ma_dead', label: '均线死叉 → 做空',
    conds: [{ left: 'ema20', op: 'cross_below', right: { kind: 'indicator', name: 'ema50' } }] },
  { key: 'ma_bull_stack', label: '多头排列 → 做多',
    conds: [
      { left: 'ema20', op: 'gt', right: { kind: 'indicator', name: 'ema50' } },
      { logic: 'and', left: 'ema50', op: 'gt', right: { kind: 'indicator', name: 'ema200' } }
    ] },
  { key: 'rsi_oversold', label: 'RSI 超卖反弹 → 做多',
    conds: [{ left: 'rsi14', op: 'lt', right: { kind: 'number', value: 30 } }] },
  { key: 'rsi_overbought', label: 'RSI 超买回落 → 做空',
    conds: [{ left: 'rsi14', op: 'gt', right: { kind: 'number', value: 70 } }] },
  { key: 'break_high20', label: '突破 20 日高 → 做多',
    conds: [{ left: 'close', op: 'gt', right: { kind: 'indicator', name: 'n_high' }, period: 20 }] },
  { key: 'break_low20', label: '跌破 20 日低 → 做空',
    conds: [{ left: 'close', op: 'lt', right: { kind: 'indicator', name: 'n_low' }, period: 20 }] },
  { key: 'deep_pullback', label: '深度回踩（偏离EMA20 ≤ -1%）→ 做多',
    conds: [{ left: 'dev_ema20', op: 'lte', right: { kind: 'number', value: -1.0 } }] }
];

const PageStrategy = {
  key: 'strategy',
  title: '策略',
  sel: null,       // 当前展开的策略 id
  ed: null,        // 编辑中的副本
  tab: 'manage',   // 'manage' 策略管理 | 'research' 投研回测
  _numCache: {},   // 条件行：切换上穿/下穿时暂存的「上次数字值」，键 策略id:条件id（不落库）
  _indCache: {},   // 条件行：切换回比较符时暂存的「上次右侧指标」，键同上

  render(view) {
    this.view = view;
    // 重渲染前清空视图，否则旧内容会叠加，新页面被盖住
    U.clear(view);
    // 全量重建会丢弃旧 DOM：先销毁回测图表，免得 echarts 实例泄漏
    if (typeof ResearchTab !== 'undefined') ResearchTab.unmount();

    const s = State.settings;
    const list = s.strategies || [];
    if (!this.sel && list.length) this.sel = s.active_strategy || list[0].id;
    const cur = list.find((x) => x.id === this.sel) || list[0];
    // 不再复制副本：编辑器直接改list 里的对象，改完 persist 才落库

    const page = U.el('div', { class: 'page' });

    // ---- tab 头：策略管理（原有内容）/ 投研回测 ----
    const mkTab = (k, label) => U.el('div', {
      class: 'iv-tab' + (this.tab === k ? ' on' : ''),
      style: 'font-size:13px;padding:5px 14px;letter-spacing:.4px' +
        (this.tab === k ? ';background:rgba(216,171,62,.13)' : ''),
      text: label,
      onclick: () => this.switchTab(k)
    });
    this.tabEls = { manage: mkTab('manage', '策略管理'), research: mkTab('research', '投研回测') };
    this.hintEl = U.el('span', { class: 'dim', style: 'font-size:11px' });
    page.appendChild(U.el('div', {
      class: 'row',
      style: 'border-bottom:1px solid var(--line);padding-bottom:8px'
    },
      U.el('div', { class: 'iv-tabs', style: 'gap:4px' }, this.tabEls.manage, this.tabEls.research),
      U.el('div', { class: 'spacer' }),
      this.hintEl));

    // 两个面板常驻，切 tab 只换 display：管理面板里未保存的改动、回测结果都不丢
    const managePanel = U.el('div', {});
    const researchPanel = U.el('div', {});
    this.panels = { manage: managePanel, research: researchPanel };
    managePanel.style.display = this.tab === 'manage' ? '' : 'none';
    researchPanel.style.display = this.tab === 'research' ? '' : 'none';
    this.updateHint(list.length);

    // ---- 策略列表 ----
    const listBox = U.el('div', {});
    for (const st of list) {
      const active = st.id === s.active_strategy;
      const row = U.el('div', {
        class: 'card',
        style: `margin-bottom:8px;cursor:pointer;` +
          (active ? 'border-color:var(--gold);' : ''),
        onclick: () => { this.sel = st.id; this.render(view); }
      },
        U.el('div', { class: 'card-body', style: 'padding:10px' },
          U.el('div', { class: 'row', style: 'margin-bottom:4px' },
            U.el('span', { style: 'font-weight:500', text: st.name }),
            active ? U.el('span', { class: 'chip on', text: '生效中' }) : null,
            st.enabled ? U.el('span', { class: 'chip', style: 'color:var(--up)', text: '已启用' }) : null,
            U.el('div', { class: 'spacer' }),
            U.el('span', { class: 'dim mono', style: 'font-size:11px',
              text: `${U.ivLabel(st.exec_interval)}/${U.ivLabel(st.dir_interval)}/${U.ivLabel(st.confirm_interval)}` })),
          U.el('div', { class: 'dim', style: 'font-size:11px;line-height:1.6', text: st.desc })));

      // 启用开关与设为生效
      const toggle = U.el('label', { class: 'switch' },
        U.el('input', {
          type: 'checkbox', checked: st.enabled,
          onclick: (e) => {
            e.stopPropagation();
            st.enabled = e.target.checked;
            this.persist(list, view);
          }
        }), ' 启用');

      const setActive = U.el('button', {
        class: 'btn sm', text: active ? '当前生效' : '设为生效',
        disabled: active,
        onclick: (e) => {
          e.stopPropagation();
          this.persist(list, view, st.id);
        }
      });

      row.querySelector('.card-body').appendChild(
        U.el('div', { class: 'row', style: 'margin-top:8px' },
          toggle,
          U.el('div', { class: 'spacer' }),
          setActive,
          U.el('button', {
            class: 'btn sm', text: '删除', style: 'margin-left:6px',
            onclick: async (e) => {
              e.stopPropagation();
              if (list.length <= 1) { U.toast('至少保留一条策略', 'err'); return; }
              if (!window.confirm(`删除策略「${st.name}」？内置策略删除后也不会再自动恢复。`)) return;
              const s2 = State.settings;
              // 墓碑：内置策略删除后加载合并时跳过，防复活
              s2.removed_strategies = [...new Set([...(s2.removed_strategies || []), st.id])];
              const rest = list.filter((x) => x.id !== st.id);
              try {
                await this.persist(rest, view);
                U.toast('已删除「' + st.name + '」', 'ok');
              } catch (err) { U.toast(err.message, 'err'); }
            }
          })));

      listBox.appendChild(row);
    }

    const listCard = U.card('策略库', listBox,
      U.el('div', { class: 'row' },
        U.el('button', {
          class: 'btn sm gold', text: '新增策略',
          onclick: async () => {
            const base = list.find((x) => x.id === this.sel) || list[0];
            if (!base) return;
            const ns = U.clone(base);
            ns.id = 'custom_' + Date.now();
            ns.name = base.name + ' · 副本';
            ns.enabled = false;
            // 新策略条件组默认留空（旧后端忽略这三个字段，不影响保存）
            ns.entry_long = [];
            ns.entry_short = [];
            ns.exit_conditions = [];
            list.push(ns);
            this.sel = ns.id;
            try {
              await this.persist(list, view);
              U.toast('已新增，改名后点「保存本策略」', 'ok');
            } catch (e) { U.toast(e.message, 'err'); }
          }
        }),
        U.el('div', { class: 'spacer' }),
        U.el('button', {
          class: 'btn sm', text: '全部评估',
          onclick: () => App.go('signal', { all: true })
        })));

    // ---- 当前策略编辑 ----
    // 编辑器必须直接操作 strategies 数组里的原对象。
    // 早先传的是 this.ed（clone 出来的副本），保存时写回副本，
    // 原始数组没变 —— 结果是改了参数保存不进去。
    let editor = U.el('div', { class: 'note', text: '未选择策略' });
    if (cur) editor = this.buildEditor(cur, view);

    managePanel.appendChild(U.el('div', { class: 'g-main' },
      U.el('div', { style: 'display:flex;flex-direction:column;gap:11px' },
        editor,
        this.buildPersonal(s, view)),
      listCard));

    page.appendChild(managePanel);
    page.appendChild(researchPanel);
    view.appendChild(page);

    // 面板已入 DOM（容器宽度有效），此时才挂图表
    if (this.tab === 'research' && typeof ResearchTab !== 'undefined') {
      ResearchTab.mount(researchPanel);
    }
  },

  /** 切 tab：不重建管理面板，避免丢掉未保存的策略参数 */
  switchTab(k) {
    if (k === this.tab || !this.panels) return;
    this.tab = k;
    for (const key of ['manage', 'research']) {
      if (this.tabEls && this.tabEls[key]) {
        this.tabEls[key].classList.toggle('on', key === k);
        this.tabEls[key].style.background = key === k ? 'rgba(216,171,62,.13)' : '';
      }
    }
    this.panels.manage.style.display = k === 'manage' ? '' : 'none';
    this.panels.research.style.display = k === 'research' ? '' : 'none';
    this.updateHint((State.settings && State.settings.strategies || []).length);
    if (typeof ResearchTab !== 'undefined') {
      // 先可见再挂载，否则图表量到的是 0 宽
      if (k === 'research') ResearchTab.mount(this.panels.research);
      else ResearchTab.unmount();
    }
    if (this.view) this.view.scrollTop = 0;
  },

  updateHint(n) {
    if (!this.hintEl) return;
    this.hintEl.textContent = this.tab === 'research'
      ? '逐根复盘真实历史 K 线，不产生任何实盘委托'
      : `共 ${n} 条策略 · 改完参数点「保存本策略」生效`;
  },

  buildEditor(st, view) {
    const ivOpts = [['5m', 'M5'], ['15m', 'M15'], ['1h', 'H1'], ['4h', 'H4'], ['1d', 'D1']];

    // 条件组兜底 + 载入规范化：旧策略无字段视为空数组，行缺字段补默认
    for (const g of COND_GROUPS) {
      st[g.key] = this.ensureConds(st, g.key).map((c, i) => this.normCond(c, i));
    }

    const mk = (label, node) => U.field(label, node);
    const execSel = U.sel(st.exec_interval, ivOpts);
    const dirSel = U.sel(st.dir_interval, ivOpts);
    const confSel = U.sel(st.confirm_interval, ivOpts);
    const emaP = U.numInput(st.ema_period, { step: '1', min: '2', max: '200' });
    const trendP = U.numInput(st.trend_ema_period, { step: '1', min: '10', max: '400' });
    const rrIn = U.numInput(st.rr_min, { step: '0.1', min: '0.5' });
    const confIn = U.numInput(st.confidence_floor, { step: '1', min: '0', max: '100' });
    const riskIn = U.numInput(st.risk_percent, { step: '0.1', min: '0.1', max: '10' });
    const allowLong = U.el('input', { type: 'checkbox', checked: st.allow_long });
    const allowShort = U.el('input', { type: 'checkbox', checked: st.allow_short });
    const promptIn = U.el('textarea', { rows: 5 });
    promptIn.value = st.prompt || '';
    const nameIn = U.el('input', { type: 'text', value: st.name });
    const descIn = U.el('textarea', { rows: 2 });
    descIn.value = st.desc || '';

    const focusBox = U.el('div', { class: 'ind-chips' },
      (st.focus || []).map((f) => U.el('span', { class: 'chip on', text: f })));

    const saveBtn = U.el('button', { class: 'btn gold', text: '保存本策略' });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        Object.assign(st, {
          name: nameIn.value.trim() || st.name,
          desc: descIn.value.trim(),
          exec_interval: execSel.value,
          dir_interval: dirSel.value,
          confirm_interval: confSel.value,
          ema_period: parseInt(emaP.value) || 20,
          trend_ema_period: parseInt(trendP.value) || 50,
          rr_min: parseFloat(rrIn.value) || 1.8,
          confidence_floor: parseFloat(confIn.value) || 44,
          risk_percent: parseFloat(riskIn.value) || 0.6,
          allow_long: allowLong.checked,
          allow_short: allowShort.checked,
          prompt: promptIn.value.trim(),
          // 三组条件已在编辑时即时写回 st，这里原样带上（旧后端会忽略）
          entry_long: st.entry_long || [],
          entry_short: st.entry_short || [],
          exit_conditions: st.exit_conditions || []
        });
        await this.persist(State.settings.strategies, view);
        U.toast('策略已保存', 'ok');
      } catch (e) { U.toast(e.message, 'err'); }
      finally { saveBtn.disabled = false; }
    });

    const paramCard = U.card('策略参数 · ' + st.name, U.el('div', {},
      U.el('div', { class: 'g2' },
        mk('策略名称', nameIn),
        mk('一句话说明', descIn)),
      U.el('div', { class: 'g3' },
        mk('定方向（趋势）', dirSel),
        mk('执行（入场）', execSel),
        mk('确认（形态）', confSel)),
      U.el('div', { class: 'g3' },
        mk('回踩 EMA 周期', emaP),
        mk('趋势 EMA 周期', trendP),
        mk('单笔风险 %', riskIn)),
      U.el('div', { class: 'g3' },
        mk('最低盈亏比', rrIn),
        mk('置信度下限', confIn),
        U.el('div', {},
          U.el('span', { style: 'display:block;margin-bottom:4px;font-size:11px;color:var(--fg-3)', text: '允许方向' }),
          U.el('div', { class: 'row', style: 'padding-top:6px' },
            U.el('label', { class: 'switch' }, allowLong, ' 做多'),
            U.el('label', { class: 'switch' }, allowShort, ' 做空')))),
      U.el('div', { style: 'margin-top:10px' },
        U.el('span', { style: 'display:block;margin-bottom:4px;font-size:11px;color:var(--fg-3)',
          text: '给 AI 的分析要求（会随行情一起发给模型）' }),
        promptIn),
      focusBox.childNodes.length
        ? U.el('div', { style: 'margin-top:8px' },
            U.el('span', { style: 'display:block;margin-bottom:4px;font-size:11px;color:var(--fg-3)', text: '本策略关注点' }),
            focusBox)
        : null,
      U.el('div', { class: 'btns', style: 'margin-top:12px' }, saveBtn)), st.name);

    // 参数卡 + 可视化条件编辑器（三组条件行）
    return U.el('div', { style: 'display:flex;flex-direction:column;gap:11px' },
      paramCard, this.buildConditions(st));
  },

  /* ================= 可视化条件编辑器 ================= */

  /** 取（必要时初始化）某条件组数组 */
  ensureConds(st, key) {
    if (!Array.isArray(st[key])) st[key] = [];
    return st[key];
  },

  /** 组内未占用的最短 id：c1 / c2 … */
  condId(arr) {
    const used = new Set(arr.map((c) => c && c.id));
    let i = 1;
    while (used.has('c' + i)) i++;
    return 'c' + i;
  },

  /** 规范化一条条件：缺字段补默认，非法枚举回落，保证契约结构完整 */
  normCond(c, i) {
    const o = (c && typeof c === 'object') ? c : {};
    const r = (o.right && typeof o.right === 'object') ? o.right : {};
    let right = r.kind === 'indicator'
      ? { kind: 'indicator', name: COND_RIGHT_METRICS.some(([v]) => v === r.name) ? r.name : 'ema50' }
      : { kind: 'number', value: Number.isFinite(Number(r.value)) ? Number(r.value) : 0 };
    // 契约：上穿/下穿右侧必须是指标
    if ((o.op === 'cross_above' || o.op === 'cross_below') && right.kind !== 'indicator') {
      right = { kind: 'indicator', name: 'ema50' };
    }
    const p = Number(o.period);
    return {
      id: o.id || ('c' + (i + 1)),
      logic: o.logic === 'or' ? 'or' : 'and',
      left: COND_METRICS.some(([v]) => v === o.left) ? o.left : 'close',
      op: COND_OPS.some(([v]) => v === o.op) ? o.op : 'gt',
      right,
      period: Number.isFinite(p) && p > 0 ? Math.round(p) : 20
    };
  },

  /** 该行是否需要「周期」输入：左侧为周期型指标，或右侧选了周期型指标 */
  needPeriod(c) {
    return COND_PERIOD_SET.has(c.left) ||
      (c.right.kind === 'indicator' && COND_PERIOD_SET.has(c.right.name));
  },

  isCross(c) { return c.op === 'cross_above' || c.op === 'cross_below'; },

  /** 缓存键：策略id:条件组:行id（同一策略里 c1 会跨组复现，必须带组维度） */
  condKey(st, key, c) { return (st && st.id ? st.id : '') + ':' + key + ':' + (c.id || ''); },

  /** 运算切换：上穿/下穿 ⇒ 值域换指标下拉；切回比较符 ⇒ 恢复数字输入并保留上次值 */
  switchRight(st, key, c) {
    const k = this.condKey(st, key, c);
    if (this.isCross(c)) {
      if (c.right.kind === 'number') this._numCache[k] = c.right.value;
      if (c.right.kind !== 'indicator') {
        c.right = { kind: 'indicator', name: this._indCache[k] || 'ema50' };
      }
    } else {
      if (c.right.kind === 'indicator') this._indCache[k] = c.right.name;
      if (c.right.kind !== 'number') {
        const last = this._numCache[k];
        c.right = { kind: 'number', value: Number.isFinite(last) ? last : 1 };
      }
    }
  },

  /** 值域节点：上穿/下穿或右值本身为指标 ⇒ 指标下拉（含「数值…」回切项）；
   *  比较符 + 数字 ⇒ 数字输入 + 「↔」回切键；两态随时互达，切换后重建值域与周期列 */
  condRightNode(st, key, c, refresh) {
    const k = this.condKey(st, key, c);
    const style = 'font-size:11px;padding:3px 5px;width:96px;flex:0 0 auto';
    const cross = this.isCross(c);
    if (cross || c.right.kind === 'indicator') {
      const opts = cross ? COND_RIGHT_METRICS : [['__number__', '数值…']].concat(COND_RIGHT_METRICS);
      const name = c.right.kind === 'indicator' ? c.right.name : 'ema50';
      const sel = U.sel(name, opts);
      sel.style.cssText = style;
      sel.addEventListener('change', () => {
        if (sel.value === '__number__') {
          // 记住原指标，便于「↔」一键切回
          if (c.right.kind === 'indicator') this._indCache[k] = c.right.name;
          const last = this._numCache[k];
          c.right = { kind: 'number', value: Number.isFinite(last) ? last : 1 };
        } else {
          c.right = { kind: 'indicator', name: sel.value };
          this._indCache[k] = sel.value;
        }
        refresh();
      });
      return sel;
    }
    const init = c.right.kind === 'number'
      ? c.right.value
      : (Number.isFinite(this._numCache[k]) ? this._numCache[k] : 1);
    const inp = U.numInput(init, { step: '0.01' });
    inp.style.cssText = style;
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) {
        c.right = { kind: 'number', value: v };
        this._numCache[k] = v;
      }
    });
    // 小回切键：数字 ⇄ 指标（如「收盘价 > EMA50」），免得单行只进不出
    const toInd = U.el('button', {
      class: 'btn sm', title: '把这一格改成指标比较（如 收盘价 > EMA50）', text: '指标',
      style: 'padding:2px 6px;flex:0 0 auto'
    });
    toInd.addEventListener('click', () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) this._numCache[k] = v;
      c.right = { kind: 'indicator', name: this._indCache[k] || 'ema50' };
      refresh();
    });
    return U.el('div', { style: 'display:flex;align-items:center;gap:3px;flex:0 0 auto' }, inp, toInd);
  },

  /** 周期节点（仅周期型指标显示） */
  condPeriodNode(c) {
    const inp = U.numInput(c.period || 20, { step: '1', min: '1', max: '250' });
    inp.style.cssText = 'font-size:11px;padding:3px 5px;width:60px;flex:0 0 auto';
    inp.addEventListener('input', () => {
      const v = parseInt(inp.value, 10);
      if (Number.isFinite(v) && v > 0) c.period = v;
    });
    return U.el('div', { style: 'display:flex;align-items:center;gap:4px;flex:0 0 auto' },
      U.el('span', { class: 'dim', style: 'font-size:11px', text: '周期' }), inp);
  },

  /** 单条条件行：连接符 / 指标 / 运算 / 值域 / 周期 / 删（字段改动即时写回策略对象） */
  condRow(st, key, i, rebuild) {
    const c = st[key][i];
    const cellStyle = 'font-size:11px;padding:3px 5px;flex:0 0 auto';
    const row = U.el('div', {
      class: 'row',
      style: 'gap:6px;align-items:center;padding:5px 7px;border:1px solid var(--line);border-radius:7px;background:var(--bg-1)'
    });

    // 1) 连接符：首行无前置条件 ⇒ 禁用态下拉显示「当」（与后续行等宽，整列对齐）
    if (i === 0) {
      c.logic = 'and';
      const logicSel = U.sel('and', [['and', '当']]);
      logicSel.disabled = true;
      logicSel.title = '首行无条件连接符';
      logicSel.style.cssText = cellStyle + ';width:62px';
      row.appendChild(logicSel);
    } else {
      const logicSel = U.sel(c.logic, [['and', '并且'], ['or', '或者']]);
      logicSel.style.cssText = cellStyle + ';width:62px';
      logicSel.addEventListener('change', () => { c.logic = logicSel.value; });
      row.appendChild(logicSel);
    }

    // 2) 指标
    const leftSel = U.sel(c.left, COND_METRICS);
    leftSel.style.cssText = cellStyle + ';width:118px';
    row.appendChild(leftSel);

    // 3) 运算
    const opSel = U.sel(c.op, COND_OPS);
    opSel.style.cssText = cellStyle + ';width:76px';
    row.appendChild(opSel);

    // 4) 值域 / 周期（两格按需重建，其余 DOM 不动，输入焦点不丢）
    const cellRight = U.el('div', { style: 'display:flex;align-items:center;flex:0 0 auto' });
    const cellPeriod = U.el('div', { style: 'display:flex;align-items:center;flex:0 0 auto' });
    const renderPeriod = () => {
      U.clear(cellPeriod);
      if (this.needPeriod(c)) cellPeriod.appendChild(this.condPeriodNode(c));
    };
    const renderRight = () => {
      U.clear(cellRight);
      cellRight.appendChild(this.condRightNode(st, key, c, () => { renderRight(); renderPeriod(); }));
    };
    row.appendChild(cellRight);
    row.appendChild(cellPeriod);

    leftSel.addEventListener('change', () => { c.left = leftSel.value; renderPeriod(); });
    opSel.addEventListener('change', () => {
      c.op = opSel.value;
      this.switchRight(st, key, c);
      renderRight();
      renderPeriod();
    });

    // 5) 删除（索引在重建时刷新）
    row.appendChild(U.el('div', { class: 'spacer' }));
    row.appendChild(U.el('button', {
      class: 'btn sm', text: '删',
      onclick: () => {
        this.ensureConds(st, key).splice(i, 1);
        rebuild();
      }
    }));

    renderRight();
    renderPeriod();
    return row;
  },

  /** 单个条件组：标题 + 模板下拉 + 加条件 + 行列表（空态提示） */
  condGroup(st, g) {
    const rowsHost = U.el('div', { style: 'display:flex;flex-direction:column;gap:6px' });
    const tip = U.el('div', { class: 'note', style: 'margin:0;font-size:11px', text: '留空 = 使用默认五步判定' });
    const meta = U.el('span', { class: 'dim mono', style: 'font-size:11px' });

    const rebuild = () => {
      const arr = this.ensureConds(st, g.key);
      U.clear(rowsHost);
      arr.forEach((c, i) => rowsHost.appendChild(this.condRow(st, g.key, i, rebuild)));
      tip.style.display = arr.length ? 'none' : '';
      meta.textContent = arr.length ? `${arr.length} / ${COND_MAX_ROWS}` : '';
    };

    // 固定宽度：select 宽度默认被最长模板名撑开，视觉上像个空框
    const tplSel = U.el('select', {
      title: '套用经典模板（覆盖本组条件）',
      style: 'font-size:11px;padding:3px 6px;width:100px;flex:0 0 auto'
    },
      U.el('option', { value: '', text: '模板 ▾' }),
      COND_TEMPLATES.map((t) => U.el('option', { value: t.key, text: t.label })));
    tplSel.addEventListener('change', () => {
      const t = COND_TEMPLATES.find((x) => x.key === tplSel.value);
      tplSel.value = '';
      if (!t) return;
      if (!window.confirm('套用模板将覆盖该组现有条件')) return;
      this.applyTemplate(st, g.key, t);
      rebuild();
      U.toast('已套用「' + t.label + '」', 'ok');
    });

    const addBtn = U.el('button', {
      class: 'btn sm', text: '+ 加条件',
      onclick: () => {
        const arr = this.ensureConds(st, g.key);
        if (arr.length >= COND_MAX_ROWS) {
          U.toast(`「${g.title}」最多 ${COND_MAX_ROWS} 条`, 'warn');
          return;
        }
        arr.push({ id: this.condId(arr), logic: 'and', left: 'close', op: 'gt',
          right: { kind: 'number', value: 0 }, period: 20 });
        rebuild();
      }
    });

    const head = U.el('div', { class: 'row', style: 'gap:7px' },
      U.el('span', { style: 'font-size:12px;font-weight:500;color:var(--fg)', text: g.title }),
      meta,
      U.el('div', { class: 'spacer' }),
      tplSel, addBtn);

    rebuild();
    return U.el('div', {
      style: 'padding:9px;border:1px solid var(--line-2);border-radius:var(--r);background:var(--bg-2)'
    }, head, U.el('div', { style: 'margin-top:7px' }, tip, rowsHost));
  },

  /** 套用模板：覆盖该组现有条件（confirm 由调用方负责） */
  applyTemplate(st, key, tpl) {
    const arr = (st[key] = []);
    for (const t of tpl.conds) {
      arr.push({
        id: this.condId(arr),
        logic: t.logic === 'or' ? 'or' : 'and',
        left: t.left,
        op: t.op,
        right: U.clone(t.right),
        period: t.period || 20
      });
    }
    return arr;
  },

  /** 三组条件编辑器整卡 */
  buildConditions(st) {
    const box = U.el('div', { style: 'display:flex;flex-direction:column;gap:9px' });
    for (const g of COND_GROUPS) box.appendChild(this.condGroup(st, g));
    return U.card('条件编写 · 零代码', U.el('div', {},
      U.el('div', { class: 'note', style: 'margin-bottom:9px' },
        '每行一个条件，第一格选「并且 / 或者」与上一行连接；上穿、下穿右侧须选指标。' +
        '留空的组沿用默认五步判定；改完点下方「保存本策略」一并落盘。'),
      box));
  },

  buildPersonal(s, view) {
    const psText = U.el('textarea', { rows: 4 });
    psText.value = s.personal_strategy.text;
    const psFloor = U.numInput(s.personal_strategy.confidence_floor, { step: '1', min: '0', max: '100' });
    const psRr = U.numInput(s.personal_strategy.rr_min, { step: '0.1', min: '0.5' });

    const saveBtn = U.el('button', { class: 'btn gold', text: '保存个人口径' });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        s.personal_strategy.text = psText.value;
        s.personal_strategy.confidence_floor = parseFloat(psFloor.value) || 44;
        s.personal_strategy.rr_min = parseFloat(psRr.value) || 1.8;
        await API.saveSettings(s);
        await App.reloadSettings();
        U.toast('个人口径已保存', 'ok');
        this.render(view);
      } catch (e) { U.toast(e.message, 'err'); }
      finally { saveBtn.disabled = false; }
    });

    return U.card('个人口径', U.el('div', {},
      U.el('div', { class: 'note', style: 'margin-bottom:10px' },
        '用你自己的话写交易逻辑。这段文字会作为最高优先级约束发给 AI，' +
        '与内置策略冲突时以这里为准。'),
      U.field('策略描述', psText),
      U.el('div', { class: 'g2' },
        U.field('置信度下限', psFloor),
        U.field('最低盈亏比', psRr)),
      U.el('div', { class: 'btns', style: 'margin-top:10px' }, saveBtn)));
  },

  async persist(list, view, activeId) {
    const s = State.settings;
    s.strategies = list;
    if (activeId) s.active_strategy = activeId;
    else if (!list.find((x) => x.id === s.active_strategy)) {
      s.active_strategy = list[0]?.id || '';
    }
    await API.saveSettings(s);
    await App.reloadSettings();
    if (view) this.render(view);
  },

  destroy() {
    this.ed = null;
    this.panels = null;
    this.tabEls = null;
    this.hintEl = null;
    // 条件行的「上次值」缓存不跨页残留
    this._numCache = {};
    this._indCache = {};
    // 离开策略页：回测图表一并销毁
    if (typeof ResearchTab !== 'undefined') ResearchTab.unmount();
  }
};