/* 信号页：逐策略 AI 买卖分析（完全大模型驱动）
 *
 * 策略 tab 选中一条 → 点【分析】→ AI 结构化研判全量呈现
 * （仪表盘、四模块、多空双方案、风控裁决、思考过程），无规则引擎判定区、
 * 无固定字段摘要——一切分析内容由大模型生成。
 * 宏观研判在行情页「基本分析」区。渲染复用 window.AIReport（watch.js 定义，先于本文件加载）。 */

const PageSignal = {
  key: 'signal',
  title: '信号',
  activeId: null,     // 最近操作过的策略；AIChat 取策略上下文时读它
  tabId: null,        // 当前选中的策略 tab（一策略一 tab）
  analyzing: {},      // 正在请求的策略 id
  errors: {},         // 分析失败信息 { id: msg }
  busyAll: false,     // 「分析全部启用策略」串行任务进行中

  render(view, opts = {}) {
    // 切页/重渲染先清空，否则旧内容叠加
    U.clear(view);
    const page = U.el('div', { class: 'page' });

    const all = (State.settings && State.settings.strategies) || [];
    if (!this.activeId) {
      this.activeId = (State.settings && State.settings.active_strategy) || (all[0] && all[0].id) || null;
    }
    // 策略页「全部评估」跳进来：切到生效策略 tab（生成入口是头部按钮，不自动烧 token）
    if (opts.all && !this.tabId) {
      const en = all.find((x) => x.enabled);
      if (en) this.tabId = en.id;
    }
    if (!this.tabId && this.activeId) this.tabId = this.activeId;

    const enabled = all.filter((x) => x.enabled);

    const allBtn = U.el('button', {
      class: 'btn sm gold',
      text: this.busyAll ? '分析中…' : '分析全部启用策略',
      disabled: this.busyAll,
      onclick: () => this.analyzeAll()
    });
    this._allBtn = allBtn;

    const head = U.el('div', { class: 'card' },
      U.el('div', { class: 'card-head' },
        U.el('span', { text: '逐策略买卖分析' }),
        U.el('div', { class: 'row' },
          U.el('span', {
            class: 'dim', style: 'font-size:11px',
            text: `${enabled.length} / ${all.length} 条策略生效`
          }),
          allBtn,
          U.el('button', { class: 'btn sm', text: 'AI 对话', onclick: () => AIChat.open() }))));

    const listHost = U.el('div', { style: 'display:flex;flex-direction:column;gap:11px' });
    page.appendChild(head);
    page.appendChild(listHost);
    view.appendChild(page);

    this.hosts = { listHost };
    this.renderList();
    // 首次进入：从后端日志恢复各策略最近一次分析（刷新页面后状态不丢）
    AIReport.ensureLoaded().then(() => this.renderList());
  },

  /** 「分析全部启用策略」按钮的进行态（页头不随列表重建，需就地同步） */
  syncAllBtn() {
    const b = this._allBtn;
    if (!b) return;
    b.textContent = this.busyAll ? '分析中…' : '分析全部启用策略';
    b.disabled = !!this.busyAll;
  },

  /** 只重建 tab 行与当前面板，页头不动（单条分析完成时局部刷新，避免整页闪） */
  renderList() {
    const host = this.hosts && this.hosts.listHost;
    if (!host || !host.isConnected) return;
    U.clear(host);

    const list = (State.settings && State.settings.strategies) || [];
    if (!list.length) {
      host.appendChild(U.el('div', { class: 'card' },
        U.el('div', { class: 'card-body' },
          U.el('div', { class: 'empty-tip', text: '尚未配置策略：请到策略页新建并保存策略。' }))));
      return;
    }
    // 生效的排前面（sort 稳定，同组内保持原顺序）
    const sorted = list.slice().sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0));
    // tab 选中态：失效/删除后回落生效或第一条
    if (!sorted.some((x) => x.id === this.tabId)) {
      const en = sorted.find((x) => x.enabled);
      this.tabId = (en || sorted[0]).id;
    }
    const cur = sorted.find((x) => x.id === this.tabId);

    // ---- 策略 tab 行：一策略一 tab ----
    host.appendChild(U.el('div', { class: 'iv-tabs', style: 'gap:4px;flex-wrap:wrap;margin-bottom:10px' },
      sorted.map((st) => {
        const c = (State.analyses || {})[st.id];
        const busy = !!this.analyzing[st.id];
        return U.el('div', {
          class: 'iv-tab' + (st.id === this.tabId ? ' on' : ''),
          title: st.enabled ? '生效中' : '未启用',
          style: st.enabled ? '' : 'opacity:.65',
          onclick: () => { this.tabId = st.id; this.activeId = st.id; this.renderList(); }
        },
          U.el('span', { text: st.name + (st.enabled ? ' ·生效' : '') }),
          U.el('span', { class: 'tab-time', text: busy ? '分析中…' : (c ? '已分析' : '未分析') }));
      })));

    // 规则判定已退场：面板完全由 AI 驱动
    host.appendChild(this.strategyCard(cur));
  },

  /* ---------- 规则引擎判定区已整体退场（充分大模型驱动）：/api/signal 前端不再调用 ---------- */

  /** 单策略面板：名称+状态+【分析】按钮；分析完成即 AI 研判全量呈现（无摘要两段式） */
  strategyCard(st) {
    const id = st.id;
    const c = (State.analyses || {})[id];
    const busy = !!this.analyzing[id];
    const err = this.errors[id];

    const statusChip = busy
      ? U.el('span', { class: 'chip', text: '分析中…' })
      : c ? U.el('span', { class: 'chip on', text: '已分析' })
        : U.el('span', { class: 'chip', text: '未分析' });

    const analyzeBtn = U.el('button', {
      class: 'btn sm' + (busy ? '' : ' gold'),
      text: busy ? '分析中…' : (c ? '重新分析' : '分析'),
      disabled: busy || this.busyAll,
      onclick: () => this.analyze(id)
    });

    const card = U.el('div', { class: 'card' },
      U.el('div', { class: 'card-head' },
        U.el('span', { style: 'display:flex;align-items:center;gap:8px;min-width:0' },
          U.el('b', { style: 'color:var(--fg)', text: st.name }),
          statusChip,
          U.el('span', {
            class: 'dim mono', style: 'font-size:11px',
            text: c ? '最近分析 ' + U.full(Math.floor(c.t / 1000)) : '尚未分析'
          })),
        U.el('div', { class: 'row' }, analyzeBtn)));

    const body = U.el('div', { class: 'card-body' });

    // 该策略口径（配置事实，供 AI 与用户对齐执行环境）
    body.appendChild(U.el('div', { class: 'dim', style: 'font-size:11px;margin-bottom:9px' },
      `执行 ${U.ivLabel(st.exec_interval)} · 定方向 ${U.ivLabel(st.dir_interval)} · 确认 ${U.ivLabel(st.confirm_interval)}` +
      ` · 盈亏比 ≥ ${U.fx(st.rr_min, 1)} · 风险 ${U.fx(st.risk_percent, 1)}%` +
      ` · 做多${st.allow_long ? '允许' : '禁止'} · 做空${st.allow_short ? '允许' : '禁止'}`));

    if (busy) {
      body.appendChild(U.el('div', { class: 'chart-loading loading-dots', text: 'AI 研判中' }));
    } else if (err) {
      body.appendChild(U.el('div', { class: 'note err', text: '分析失败：' + err }));
      body.appendChild(U.el('div', { style: 'text-align:center;margin-top:9px' },
        U.el('button', { class: 'btn gold', text: '重试', onclick: () => this.analyze(id) })));
    }

    if (!busy && !c) {
      body.appendChild(U.el('div', { class: 'empty-tip', text: '尚未分析：点【分析】让 AI 研判这条策略' }));
    }

    if (c && !busy) {
      // 完整结构化研判全量呈现：仪表盘 / 四模块 / 多空双方案 / 风控裁决 / 思考过程
      AIReport.render(body, c.a, { ts: c.t, strategyId: id });
    }

    card.appendChild(body);
    return card;
  },

  /** 单条策略分析：串行调用后端，结果按策略 id 落槽 */
  async analyze(id) {
    if (this.analyzing[id]) return;
    this.activeId = id;
    this.analyzing[id] = true;
    delete this.errors[id];
    this.renderList();
    try {
      const a = await API.signalEnhanced(id);
      AIReport.save(id, a);
    } catch (e) {
      this.errors[id] = e.message;
    }
    this.analyzing[id] = false;
    this.renderList();
  },

  /** 分析全部启用策略：逐条串行 await，每条之间停 1 秒，避免并发打爆 AI */
  async analyzeAll() {
    if (this.busyAll) return;
    const on = ((State.settings && State.settings.strategies) || []).filter((x) => x.enabled);
    if (!on.length) return U.toast('没有启用的策略：先到策略页启用', 'warn');

    this.busyAll = true;
    this.syncAllBtn();
    this.renderList();
    let done = 0;
    try {
      for (const st of on) {
        if (!this.hosts) break; // 已离开本页：中止后续请求，不偷偷烧 token
        await this.analyze(st.id);
        done++;
        if (done < on.length) await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      this.busyAll = false;
      this.syncAllBtn();
      this.renderList();
      if (done) U.toast(`已完成 ${done} 条策略的研判`, 'ok');
    }
  },

  destroy() {
    this.hosts = null;
    this._allBtn = null;
    this.analyzing = {};
    this.errors = {};
    // tabId 保留：切页回来停在原策略
  }
};
