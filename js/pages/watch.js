/* 行情页：K线 + 指标 + 现价 + 基本分析（AI 结构化研判）
 *
 * 共享渲染对象 window.AIReport 定义在本文件：index.html 里 watch.js 先于 signal.js 加载，
 * 信号页的「逐策略买卖分析」复用同一套渲染（仪表盘 / 四模块 / 多空两套方案 / 风控裁决），
 * 两页各写一份必然走样，故收在一处。本文件不得依赖页面对象内部状态。 */

window.AIReport = {
  /* ---------- 取数 ---------- */

  /** 单轴多空刻度：0=极度看空、50=中性、100=极度看多（越高越看多，无负数）。
   *  旧日志无 sentiment 时按 bias/confidence/gauge 兜底推导到同一刻度。 */
  sentiment(v) {
    if (!v) return 50;
    if (v.sentiment >= 0 && v.sentiment <= 100) return v.sentiment;
    const conf = Math.max(0, Math.min(100, v.confidence || 0));
    const b = v.bias || (v.gauge > 20 ? 'long' : v.gauge < -20 ? 'short' : '');
    if (b === 'long') return 50 + conf / 2;
    if (b === 'short') return 50 - conf / 2;
    if (v.gauge) return 50 + v.gauge / 2;
    return 50;
  },

  /** 摘要数据：方向、信心刻度、首选方案点位（列表摘要行与详情头共用） */
  summary(a) {
    const v = (a && a.verdict) || null;
    if (!v) return null;
    const dir = v.direction || 'none';
    const plans = v.plans || [];
    const p = plans.find((x) => x.side === dir) || plans[0] || null;
    const sent = this.sentiment(v);
    // 模型没给方向（观望）时，方向大字退回单轴刻度档位，与仪表盘口径一致
    const lv = sent < 20 ? ['极度看空', 'down'] : sent < 40 ? ['看空', 'down']
      : sent < 60 ? ['中性', 'dim'] : sent < 80 ? ['看多', 'up'] : ['极度看多', 'up'];
    return {
      dir: dir,
      dirText: dir === 'long' ? '做多' : dir === 'short' ? '做空' : lv[0],
      cls: dir === 'long' ? 'up' : dir === 'short' ? 'down' : lv[1],
      sent: sent,
      style: v.style_tag || '',
      entry: p ? p.entry : null,
      sl: p ? p.sl : null,
      tp: p ? (p.tp1 !== null && p.tp1 !== undefined ? p.tp1 : p.tp2) : null,
      rr: p ? (p.rr1 !== null && p.rr1 !== undefined ? p.rr1 : p.rr2) : null,
      summary: v.summary || ''
    };
  },

  /** 点位贴文字：数字格式化，区间/文本原样（模型偶尔给 "2410-2416" 这类区间） */
  px(x) {
    if (typeof x === 'number') return U.px(x);
    if (x === null || x === undefined || x === '') return '--';
    return String(x);
  },

  /** 多槽缓存：键=策略 id。首次进入从后端日志恢复各策略最新一条，刷新页面不丢 */
  ensureLoaded() {
    if (State.analyses) return Promise.resolve(State.analyses);
    State.analyses = {};
    return API.aiLog(30).then((list) => {
      for (const it of list) { // 最新在前，每策略取第一条
        if (it.analysis && it.analysis.verdict && it.sid && !State.analyses[it.sid]) {
          State.analyses[it.sid] = { a: it.analysis, t: it.t * 1000 };
        }
      }
      return State.analyses;
    }).catch(() => State.analyses);
  },

  save(id, a) {
    State.analyses = State.analyses || {};
    State.analyses[id] = { a: a, t: Date.now() };
    return State.analyses[id];
  },

  drop(id) { if (State.analyses) delete State.analyses[id]; },

  /* ---------- 片段 ---------- */

  /** 摘要行：方向大字 + 信心指数 + 点位 + 一句结论（信号页每条策略卡用）
   *  opts.sentence === false 时不重复那句结论（展开的完整研判里已经有） */
  summaryLine(a, opts = {}) {
    const box = U.el('div', {});
    const s = this.summary(a);
    if (!s) {
      box.appendChild(U.el('div', {
        class: 'note warn',
        text: (a && a.ai_error) || '该条无结构化结果。'
      }));
      return box;
    }
    box.appendChild(U.el('div', { class: 'ai-head', style: 'margin-bottom:0' },
      U.el('div', { class: 'ai-bias', style: 'flex:none;min-width:104px' },
        U.el('div', { class: 'bias-dir ' + s.cls, text: s.dirText }),
        U.el('div', { class: 'bias-conf' }, '信心 ', U.el('b', { text: U.fx(s.sent, 0) }), ' / 100'),
        // 模型给的打法标签放在方向下方，四个点位框就都是两行，行内高度齐平
        s.style ? U.el('div', { class: 'bias-meta', style: 'margin-top:4px', text: s.style }) : null),
      U.el('div', { class: 'stats', style: 'flex:1;min-width:0' },
        U.stat('入场', this.px(s.entry)),
        U.stat('止损', this.px(s.sl), null, 'down'),
        U.stat('目标', this.px(s.tp), null, 'up'),
        U.stat('盈亏比', s.rr !== null && s.rr !== undefined ? U.fx(s.rr, 1) + ':1' : '--', null,
          s.rr !== null && s.rr !== undefined ? (s.rr >= State.rrMin ? 'up' : 'down') : ''))));
    if (s.summary && opts.sentence !== false) {
      box.appendChild(U.el('div', { class: 'note', style: 'margin-top:9px', text: s.summary }));
    }
    return box;
  },

  /** 工具条：页面注入按钮 + 更新时间戳 */
  toolbar(opts) {
    return U.el('div', { class: 'ai-tools' },
      (opts.actions || []).map((b) => U.el('button', {
        class: 'btn sm' + (b.cls ? ' ' + b.cls : ''),
        text: b.text,
        onclick: b.onClick
      })),
      U.el('span', {
        class: 'dim mono', style: 'margin-left:auto;font-size:12px',
        text: opts.ts ? '已更新 ' + U.hhmmss(Math.floor(opts.ts / 1000)) : ''
      }));
  },

  /* ---------- 仪表盘头（render 与窄栏简版共用） ---------- */

  /** 多空档位（0-100 → 档位名与配色） */
  lvOf(sent) {
    return sent < 20 ? ['极度看空', 'down'] : sent < 40 ? ['看空', 'down']
      : sent < 60 ? ['中性', 'dim'] : sent < 80 ? ['看多', 'up'] : ['极度看多', 'up'];
  },

  /** 单轴仪表盘；showLv=false 时盘内不放档位字（窄栏简版用，避免与下方方向大字重复显乱） */
  gaugeEl(sent, showLv = true) {
    const lv = this.lvOf(sent);
    const numCls = sent < 40 ? 'down' : sent < 60 ? 'dim' : 'up';
    // 指针：0 → -90°（左/空），50 → 0°（中），100 → +90°（右/多）
    const angle = (sent - 50) / 50 * 90;
    return U.el('div', { class: 'gauge' },
      U.el('div', { class: 'gauge-face' }),
      U.el('div', { class: 'gauge-needle', style: `transform:rotate(${angle.toFixed(1)}deg)` }),
      U.el('div', { class: 'gauge-pin' }),
      // 中央数字=多空刻度（0-100，越高越看多）
      U.el('div', { class: 'gauge-val ' + numCls, text: U.fx(sent, 0) }),
      showLv ? U.el('div', { class: 'gauge-lv', text: lv[0] }) : null);
  },

  /** ai-head：单轴仪表盘 + 方向/信心摘要条（sent=0-100 多空刻度，信号页全量版用） */
  headEl(v, a, sent) {
    const lv = this.lvOf(sent);

    return U.el('div', { class: 'ai-head' },
      this.gaugeEl(sent, true),
      U.el('div', { class: 'ai-bias' },
        U.el('div', { class: 'bias-dir ' + lv[1], text: lv[0] }),
        U.el('div', { class: 'bias-conf' }, '信心 ', U.el('b', { text: U.fx(sent, 0) }), ' / 100'),
        U.el('div', { class: 'bias-meta' },
          [
            v.style_tag || '按当前策略',
            a.risk && a.risk.allowed ? '建议手数 ' + U.fx(a.risk.lot, 2) : '手数待风控',
            '多周期合成',
            v.plans && v.plans.length ? '多空两套点位' : ''
          ].filter(Boolean).join('　·　'))));
  },

  /**
   * 窄栏简版（行情页现价下）：只出 ai-head 与一句话结论两小块，
   * 完整研判（四模块/双方案/思考/历史）留在信号页，生成入口也在信号页。
   */
  renderBrief(host, a, opts = {}) {
    U.clear(host);
    if (!a) {
      host.appendChild(U.el('div', { class: 'dim', style: 'font-size:12px',
        text: opts.emptyText || '未研判：到信号页选择策略生成' }));
      return;
    }
    if (a.ai_error) {
      host.appendChild(U.el('div', { class: 'note err', text: 'AI 分析失败：' + a.ai_error }));
      return;
    }
    const v = a.verdict;
    if (!v) {
      host.appendChild(U.el('div', { class: 'note', text: '模型未给出结构化判断。' }));
      return;
    }
    const sent = this.sentiment(v);
    const lv = this.lvOf(sent);

    // 窄栏竖排：仪表盘居中 → 方向·信心一行 → 标签 chips（各自不换行，根治长串断词）→ 一句话结论
    const box = U.el('div', { class: 'brief-block' });
    box.appendChild(this.gaugeEl(sent, false));
    box.appendChild(U.el('div', { class: 'brief-line' },
      U.el('span', { class: 'bias-dir ' + lv[1], style: 'font-size:17px', text: lv[0] }),
      U.el('span', { class: 'dim', text: '·' }),
      U.el('span', { class: 'bias-conf' }, '信心 ', U.el('b', { text: U.fx(sent, 0) }), ' / 100')));
    const chips = [
      v.style_tag || '',
      v.plans && v.plans.length ? '多空两套点位' : '',
      a.risk && a.risk.allowed ? '建议手数 ' + U.fx(a.risk.lot, 2) : '手数待风控'
    ].filter(Boolean);
    box.appendChild(U.el('div', { class: 'brief-chips' },
      chips.map((t) => U.el('span', { class: 'chip', text: t }))));
    if (v.summary) {
      box.appendChild(U.el('div', { class: 'note', style: 'margin-top:2px', text: v.summary }));
    }
    if (opts.ts) {
      box.appendChild(U.el('div', { class: 'brief-ts',
        text: '研判更新于 ' + U.hhmmss(Math.floor(opts.ts / 1000)) + ' · 每 10 分钟自动刷新' }));
    }
    host.appendChild(box);
  },

  /* ---------- 主渲染 ---------- */

  /**
   * 渲染单条策略的结构化研判。
   * host 容器；a=分析结果（null 走空态）；opts:
   *   ts        更新时间（毫秒）
   *   actions   [{ text, cls, onClick }] 工具条按钮，缺省不渲染工具条
   *   onAnalyze 空态下「生成研判」按钮回调
   *   emptyText 空态文案
   */
  render(host, a, opts = {}) {
    U.clear(host);
    if (opts.actions && opts.actions.length) host.appendChild(this.toolbar(opts));

    if (!a) {
      host.appendChild(U.el('div', { class: 'empty-tip', text: opts.emptyText || '选择策略后生成研判' }));
      if (opts.onAnalyze) {
        host.appendChild(U.el('div', { style: 'text-align:center' },
          U.el('button', { class: 'btn gold', text: '生成研判', onclick: opts.onAnalyze })));
      }
      return;
    }

    if (a.ai_error) {
      host.appendChild(U.el('div', { class: 'note warn', text: a.ai_error }));
    }

    const v = a.verdict;
    if (!v) {
      if (!a.ai_error) {
        host.appendChild(U.el('div', { class: 'note', text: '模型未给出结构化判断。' }));
      }
      return;
    }

    const sent = this.sentiment(v);

    // ---- 仪表盘 + 方向头：全部由单轴刻度 sent 推导 ----
    host.appendChild(this.headEl(v, a, sent));

    // ---- 综合结论与风险提示 ----
    if (v.summary) {
      host.appendChild(U.el('div', { class: 'note', style: 'margin-bottom:10px', text: v.summary }));
    }
    if (v.warnings && v.warnings.length) {
      host.appendChild(U.el('div', { class: 'note warn', style: 'margin-bottom:10px' },
        '模型提示：' + v.warnings.join('；')));
    }

    // ---- 四模块分析 ----
    if (v.modules && v.modules.length) {
      for (const m of v.modules) {
        const vague = /未明确|未给出|未做|未判定/.test((m.status || '') + (m.detail || ''));
        host.appendChild(U.el('div', { class: 'mod' },
          U.el('div', { class: 'mod-h', text: '模块 · ' + (m.name || '') }),
          U.el('div', { class: 'mod-b' + (vague ? ' warn' : '') },
            m.status ? U.el('b', { text: m.status }) : null,
            m.detail ? '　' + m.detail : '')));
      }
    }

    // ---- 综合决策：多空两套方案 ----
    if (v.plans && v.plans.length) {
      host.appendChild(U.el('div', { class: 'mod-h', style: 'margin-top:11px' },
        '综合决策 · 入场逻辑与多空两套计划'));
      // 方案下方的计划卡宿主：一次只显示最新生成的一张（重复点覆盖，未点不显示）
      const planHost = U.el('div', { class: 'tplan-host' });
      const st = ((State.settings && State.settings.strategies) || [])
        .find((x) => x.id === opts.strategyId) || null;
      for (const p of v.plans) {
        const longSide = p.side !== 'short';
        const row = (k, val, cls) => U.el('div', { class: 'plan-r' },
          U.el('span', { class: 'k', text: k }),
          U.el('span', { class: cls || '', text: val || '--' }));
        host.appendChild(U.el('div', { class: 'plan ' + (longSide ? 'long' : 'short') },
          U.el('div', { class: 'plan-h' },
            U.el('span', { text: longSide ? '▲ 做多方案' : '▼ 做空方案' }),
            p.style ? U.el('span', { class: 'dim', text: '（' + p.style + '）' }) : null,
            U.el('span', { class: 'spacer' }),
            U.el('button', {
              class: 'btn sm gen-plan', text: '生成计划',
              title: '用这套点位与风控参数生成可执行清单（本地组装，不调 AI）',
              onclick: () => TradePlan.generate(planHost, {
                p: p, v: v, ts: opts.ts || 0, sid: opts.strategyId || '', st: st
              })
            })),
          row('触发', p.trigger),
          row('入场', p.entry + (p.entry_mid ? `　中值 ${U.px(p.entry_mid)}` : '')),
          row('止损', p.sl ? U.px(p.sl) + (p.sl_note ? '　' + p.sl_note : '') : '', 'down'),
          row('目标1', p.tp1 ? U.px(p.tp1) + (p.tp1_note ? '　' + p.tp1_note : '') +
            (p.rr1 ? `　${U.fx(p.rr1, 1)}:1` : '') : '', 'up'),
          row('目标2', p.tp2 ? U.px(p.tp2) + (p.tp2_note ? '　' + p.tp2_note : '') +
            (p.rr2 ? `　${U.fx(p.rr2, 1)}:1` : '') : '', 'up'),
          row('持仓', p.hold)));
      }
      host.appendChild(planHost);
    }

    // ---- 逐条理由 ----
    if (v.reasons && v.reasons.length) {
      host.appendChild(U.el('div', { class: 'reasons', style: 'margin-top:11px' },
        v.reasons.map((r) => U.el('div', { class: 'reason' },
          U.el('span', { class: 'mark up', text: '·' }),
          U.el('span', { text: r })))));
    }

    // 代码风控裁决
    const r = a.risk;
    if (r) {
      const verdictBox = U.el('div', { style: 'margin-top:11px' });
      verdictBox.appendChild(U.el('div', {
        class: 'note ' + (r.allowed ? 'ok' : 'warn'),
        style: 'margin-bottom:9px'
      },
        U.el('b', { text: r.allowed ? '风控通过' : '风控拦截' }),
        r.allowed
          ? '　按此参数可执行'
          : '　' + r.blocks.join('；')));
      if (r.allowed && r.plan) {
        verdictBox.appendChild(U.table(
          [{ label: '项目' }, { label: '数值', num: true }],
          [
            ['代码计算手数', U.fx(r.lot, 2), ''],
            ['预估风险', '$' + U.fx(r.risk_money, 2), 'down'],
            ['实际盈亏比', U.fx(r.rr, 2), r.rr >= State.rrMin ? 'up' : 'down'],
            ['止损点数', U.fx(r.sl_points, 0), ''],
            ['目标点数', U.fx(r.tp_points, 0), '']
          ].map(([k, val, c]) => [
            U.el('span', { class: 'dim', text: k }),
            U.el('span', { class: c || '', text: val })
          ])));
      }
      if (r.warns && r.warns.length) {
        verdictBox.appendChild(U.el('div', { class: 'note', style: 'margin-top:7px' },
          '提醒：' + r.warns.join('；')));
      }
      host.appendChild(verdictBox);
    }

    // token 用量与规则对照
    const sig = a.signal;
    const agree = sig && v.direction !== 'none'
      ? (sig.dir === 1 && v.direction === 'long') || (sig.dir === -1 && v.direction === 'short')
      : null;
    host.appendChild(U.el('div', { class: 'note', style: 'margin-top:9px' },
      sig
        ? `规则引擎独立判定：${sig.summary}（置信度 ${U.fx(sig.confidence, 0)}）` +
          (agree === true ? '　与AI 方向一致' :
            agree === false ? '　与 AI 方向不一致，以你自己的判断为准' : '')
        : ''));

    host.appendChild(U.el('div', {
      class: 'dim mono',
      style: 'font-size:11px;margin-top:7px'
    }, `模型 ${a.model}　输入 ${a.prompt_tokens}　输出 ${a.completion_tokens}` +
      (a.reasoning_tokens ? `　思考 ${a.reasoning_tokens}` : '')));

    // 思考过程：折叠展示，与正式回答分开
    if (a.reasoning_text) {
      host.appendChild(U.el('details', { class: 'ai-reason', style: 'margin-top:9px' },
        U.el('summary', {
          text: `思考过程（${a.reasoning_text.length} 字 · 思考 ${a.reasoning_tokens} token，点击展开）`
        }),
        U.el('pre', { class: 'ai-reason-body', text: a.reasoning_text })));
    }
  },

  /** 分析历史：后端 ai_log.jsonl 落档，行点击在 host 内展开完整研判（同一时刻只显示一份） */
  async toggleHistory(host, opts = {}) {
    if (!host || !host.isConnected) return;
    const exist = host.querySelector('.ai-history');
    if (exist) { exist.remove(); return; }

    const box = U.el('div', { class: 'ai-history' },
      U.el('div', { class: 'ai-history-h', text: '分析历史（最新 30 条 · 点行在下方展示，同一时刻只显示一份结果）' }));
    const listHost = U.el('div', { class: 'ai-history-list' });
    box.appendChild(listHost);
    host.insertBefore(box, host.firstChild);

    try {
      const list = await API.aiLog(30);
      if (!list.length) {
        listHost.appendChild(U.el('div', { class: 'note', text: '暂无历史：点「重新分析」后每次结果自动留档。' }));
        return;
      }
      const dirMap = { long: ['看多', 'up'], short: ['看空', 'down'], none: ['观望', 'dim'] };
      for (const it of list) {
        const d = dirMap[it.direction] || ['--', 'dim'];
        listHost.appendChild(U.el('div', {
          class: 'ai-history-row',
          onclick: () => {
            if (!host.isConnected) return;
            const ana = it.analysis;
            if (ana && ana.verdict) {
              // it.t 是秒，这里统一成毫秒再交给 render
              this.render(host, ana, {
                ts: it.t * 1000,
                actions: opts.actions,
                strategyId: opts.strategyId
              });
            } else {
              U.clear(host);
              host.appendChild(U.el('div', { class: 'note warn', text: '该条无结构化结果：' + (it.ai_error || '未知原因') }));
            }
          }
        },
          U.el('span', { class: 'mono dim', style: 'flex:none;width:86px', text: U.mdhm(it.t) }),
          U.el('span', { style: 'flex:none;width:84px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: it.sname || '--' }),
          U.el('span', { class: d[1], style: 'flex:none;width:40px', text: d[0] }),
          U.el('span', { class: 'mono', style: 'flex:none;width:52px', text: it.confidence != null ? U.fx(it.confidence, 0) : '--' }),
          U.el('span', { class: 'dim hist-sum', text: it.summary || it.ai_error || '' })));
      }
    } catch (e) {
      listHost.appendChild(U.el('div', { class: 'note err', text: '历史读取失败：' + e.message }));
    }
  }
};

/* ---------- 交易计划卡：研判 → 执行的最后一米 ----------
 * 纯前端组装（不调 AI 不花钱）：点位取自已渲染的方案，风控参数取 State.settings，
 * 手数口径与后端 src/risk.rs::calc_lot 一致（按权益风险反推、步长取整、上下限截断），
 * 缺字段一律显示 --，不编造数字。信号页 AI 研判区「多空双方案」下方挂载。 */
window.TradePlan = {
  _eq: null,          // /api/stats 权益缓存
  _eqAt: 0,
  DONE_KEY: 'gs_plan_done',

  /** 权益：/api/stats 拉一次（30 秒内复用）；失败退回配置权益，由调用方如实标注 */
  async equity() {
    if (this._eq !== null && Date.now() - this._eqAt < 30000) return { v: this._eq, live: true };
    try {
      const st = await API.req('/api/stats');
      if (st && typeof st.equity === 'number' && isFinite(st.equity)) {
        this._eq = st.equity; this._eqAt = Date.now();
        return { v: this._eq, live: true };
      }
    } catch { /* 落回配置权益，不编造 */ }
    const cfg = State.settings && State.settings.equity;
    return typeof cfg === 'number' && isFinite(cfg) ? { v: cfg, live: false } : { v: null, live: false };
  },

  /** 点位数：数字原样；字符串（如 "4151.5-4155.5 区间分批"）取前两个数中值；取不到 null */
  num(x) {
    if (typeof x === 'number') return isFinite(x) ? x : null;
    if (x === null || x === undefined || x === '') return null;
    const m = String(x).match(/-?\d+(?:\.\d+)?/g);
    if (!m || !m.length) return null;
    const v = m.slice(0, 2).map(Number);
    return v.length > 1 ? (v[0] + v[1]) / 2 : v[0];
  },

  /** 入场取值：优先 entry_mid，其次从 entry 区间文本取中值（手数用，展示仍用原文） */
  entryPrice(p) {
    if (typeof p.entry_mid === 'number') return p.entry_mid;
    return this.num(p.entry);
  },
  tpPrice(p) { return p.tp1 !== null && p.tp1 !== undefined ? p.tp1 : (p.tp2 ?? null); },
  rrVal(p) {
    if (typeof p.rr1 === 'number') return p.rr1;
    if (typeof p.rr2 === 'number') return p.rr2;
    return null;
  },

  /** 止损点数 + 手数 + 最大亏损：逐步照抄后端 risk::calc_lot / plan 口径，便于与后端对拍 */
  calc(entry, sl, equity, riskPct, s) {
    const pv = s.point_value, cs = s.contract_size, r = s.risk || {};
    if (typeof entry !== 'number' || typeof sl !== 'number' || !(entry > 0) || !(sl > 0)) return null;
    if (!(pv > 0) || !(cs > 0) || typeof equity !== 'number' || !(equity > 0)) return null;
    if (typeof riskPct !== 'number' || !(riskPct > 0)) return null;
    const slPoints = Math.abs(entry - sl) / pv;
    if (!(slPoints > 0)) return null;
    const step = r.lot_step > 0 ? r.lot_step : 0.01;
    const min = typeof r.min_lot === 'number' ? r.min_lot : 0.01;
    const max = typeof r.max_lot === 'number' ? r.max_lot : 5;
    const lossPerLot = slPoints * pv * cs;                         // 每手损多少美元
    const moneyAtRisk = equity * riskPct / 100;
    let lot = Math.round(moneyAtRisk / lossPerLot / step) * step;  // round_step
    lot = Math.min(Math.max(lot, min), max);                       // clamp(min,max)
    if (lot < min) return null;
    lot = Math.round(lot * 100) / 100;
    return { slPoints: slPoints, lot: lot, riskMoney: lot * lossPerLot };
  },

  /* ---------- 重复错误拦截（只读展示，不阻断生成计划） ----------
   * 记忆里最近 7 天的亏损归因（复盘页写入，格式见 review.js::saveAttr），按方向做关键词匹配：
   * 命中就在计划卡顶部插黄条提醒。记忆插件未开启 / 无数据 / 请求失败一律静默返回空，
   * 绝不因为记忆层坏了卡住生成流程，也不编造命中。 */
  REPEAT_MS: 7 * 864e5,
  REPEAT_WORDS: {
    long: ['逆势', '抄底', '接刀'],      // 做多计划：别在下跌里接刀
    short: ['追高', '追涨', '杀跌'],     // 做空计划：别在冲高里追空
    any: ['止损被扫', '太紧']            // 通用：止损设太窄被扫，配当前计划的止损点数一起判
  },

  /** 只认复盘页写的归因条（跨页契约，见 review.js::saveAttr）：标题以「亏损归因」开头，或 tags 里有它 */
  isAttr(it) {
    if (!it) return false;
    const title = String(it.title || '').trim();
    if (/^亏损归因([\s　]|$)/.test(title)) return true;
    const tags = Array.isArray(it.tags) ? it.tags : [];
    return tags.some((t) => String(t).trim() === '亏损归因');
  },

  /** 命中的归因条（无命中/取不到 → 空数组）。c 为 this.calc 结果，可为 null */
  async repeatHits(p, c) {
    if (typeof API.memList !== 'function') return [];
    let items = [];
    try {
      const r = await API.memList('亏损归因');
      items = Array.isArray(r) ? r : [];
    } catch { return []; }   // 记忆插件未开启：静默无黄条

    const now = Date.now();
    const W = this.REPEAT_WORDS;
    const longPlan = p.side !== 'short';
    const risk = (State.settings && State.settings.risk) || {};
    // 止损太窄：当前计划止损点数低于策略最小止损点数才算；没这字段就跳过，不硬凑
    const minSl = typeof risk.min_sl_points === 'number' ? risk.min_sl_points : null;
    const slTight = !!(c && minSl !== null && minSl > 0 && c.slPoints < minSl);

    const hits = [];
    for (const it of items) {
      // 语义召回会混进别条：只认同契约的归因条（标题以「亏损归因」开头，或 tags 里有它）
      if (!this.isAttr(it)) continue;
      const ts = Number(it.updated || 0) * 1000;
      if (!(ts > 0) || now - ts > this.REPEAT_MS) continue;   // 只看最近 7 天
      const say = String(it.body || '').replace(/（[^（）]*）\s*$/, '');  // 去掉末尾括号补充，只留归因原文
      const words = longPlan ? W.long : W.short;
      const hit = words.some((w) => say.includes(w))
        || (slTight && W.any.some((w) => say.includes(w)));
      if (hit) hits.push({ body: say, ts: ts });
    }
    return hits;
  },

  /** 计划卡已落地后异步补黄条：卡片不等它；未命中/失败什么都不加 */
  async bindRepeat(host, card, p, c) {
    let hits = [];
    try { hits = await this.repeatHits(p, c); } catch { return; }
    if (!hits.length) return;
    // 期间又点过生成（或已切页）：老回调不许写进新卡
    if (!host.isConnected || !card.isConnected || card !== host.lastElementChild) return;
    const first = hits[0].body;
    const say = first.length > 60 ? first.slice(0, 60) + '…' : first;
    const bar = U.el('div', {
      class: 'note warn',
      style: 'margin-bottom:9px;font-size:12px;line-height:1.7',
      title: '来自记忆里的亏损归因（最近 7 天）'
    }, '⚠ 你在重复同样的错："' + say + '"（本周第 ' + hits.length + ' 次）。这次先等条件真成立。');
    card.insertBefore(bar, card.firstChild);
  },

  /* ---------- 本地「已执行」标记（只打勾，不开仓） ---------- */
  marks() {
    try {
      const a = JSON.parse(localStorage.getItem(this.DONE_KEY) || '[]');
      return Array.isArray(a) ? a.filter((x) => x && x.side) : [];
    } catch { return []; }
  },
  markDone(sid, side) {
    const list = this.marks();
    list.push({ strategyId: sid || '', side: side, ts: Date.now() });
    try { localStorage.setItem(this.DONE_KEY, JSON.stringify(list.slice(-50))); } catch { /* 超限静默 */ }
  },
  doneAt(sid, side, anaTs) {
    // 研判若在本地标记之后重新生成过，老标记对不上新方案，就不显示（不糊弄）
    const hit = this.marks().filter((r) => r.strategyId === (sid || '') && r.side === side
      && r.ts >= (anaTs || 0));
    return hit.length ? hit[hit.length - 1].ts : null;
  },

  /** 复制（clipboard 优先，execCommand 兜底；不引 aichat.js，自备一份） */
  copy(text) {
    const s = text === null || text === undefined ? '' : String(text);
    const okToast = () => U.toast('计划已复制到剪贴板', 'ok');
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, s.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      if (ok) okToast(); else U.toast('复制失败，请手动选中', 'warn');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(okToast).catch(fallback);
    } else {
      fallback();
    }
  },

  /** 生成计划卡：host 承载（一卡一位，重复点覆盖），ctx = { p, v, ts, sid, st } */
  async generate(host, ctx) {
    if (!host || !host.isConnected) return;
    const p = ctx.p || {}, v = ctx.v || {}, s = State.settings || {};
    const str = s.strategy || {};

    U.clear(host);
    host.appendChild(U.el('div', { class: 'tplan' },
      U.el('div', { class: 'tplan-load', text: '读取权益与风控参数…' })));

    const eq = await this.equity();
    if (!host.isConnected) return;

    // ---- 取值（缺一律 --） ----
    const long = p.side !== 'short';
    const dirText = long ? '做多' : '做空';
    const styleName = p.style || v.style_tag || (ctx.st && ctx.st.name) || '';
    const riskPct = ctx.st && typeof ctx.st.risk_percent === 'number' ? ctx.st.risk_percent
      : (typeof str.risk_percent === 'number' ? str.risk_percent : null);
    const rrMin = ctx.st && typeof ctx.st.rr_min === 'number' ? ctx.st.rr_min
      : (typeof str.rr_min === 'number' ? str.rr_min : null);
    const entryPx = this.entryPrice(p);
    const slPx = this.num(p.sl);
    const tpPx = this.tpPrice(p);
    const rr = this.rrVal(p);
    const c = this.calc(entryPx, slPx, eq.v, riskPct, s);
    const now = Date.now();

    const entryText = (p.entry !== null && p.entry !== undefined && p.entry !== '')
      ? String(p.entry) : (entryPx !== null ? U.px(entryPx) : '--');
    const entrySub = (typeof p.entry === 'string' && entryPx !== null)
      ? '按中值 ' + U.px(entryPx) + ' 计手数' : '';

    const cell = (k, val, cls, sub, title) => U.el('div', { class: 'tplan-cell', title: title || null },
      U.el('div', { class: 'k', text: k }),
      U.el('div', { class: 'v ' + (cls || ''), text: val }),
      sub ? U.el('div', { class: 's', text: sub }) : null);

    const head = U.el('div', { class: 'tplan-h' },
      U.el('span', { class: 'tplan-dir ' + (long ? 'up' : 'down'), text: dirText }),
      U.el('span', { class: 'dim', text: '·' }),
      U.el('span', { class: 'tplan-style', text: styleName || '未命名方案' }),
      U.el('span', { class: 'tplan-time', text: '生成 ' + U.hhmmss(Math.floor(now / 1000)) }));

    const grid = U.el('div', { class: 'tplan-grid' },
      cell('入场区', entryText, '', entrySub, p.trigger ? '触发条件：' + p.trigger : null),
      cell('止损', slPx !== null ? U.px(slPx) : '--', 'down',
        c ? '距入场 ' + U.fx(c.slPoints, 0) + ' 点' : '', p.sl_note || null),
      cell('目标', tpPx !== null ? U.px(tpPx) : '--', 'up',
        p.tp2 ? 'TP2 ' + U.px(p.tp2) : '', p.tp1_note || null),
      cell('盈亏比', rr !== null ? U.fx(rr, 1) + ':1' : '--',
        rr === null ? '' : (rrMin !== null && rr < rrMin ? 'down' : 'up'),
        rr === null ? '' : (rrMin !== null
          ? (rr < rrMin ? '低于策略要求 ' + U.fx(rrMin, 1) + ' ⚠' : '策略要求 ≥ ' + U.fx(rrMin, 1))
          : '')));

    const lotTxt = c ? U.fx(c.lot, 2) + ' 手' : '--';
    const lotNote = riskPct === null ? '风险参数缺失，无法计算'
      : c ? '按风险 ' + U.fx(riskPct, 1) + '% 自动计算' : '点位/权益不全，无法计算';
    const riskSay = c
      ? `本计划最大亏损约 $${U.fx(c.riskMoney, 2)}（本金的 ${U.fx(riskPct, 1)}%）；到价不成交或破止损即放弃，不追单。`
      : '点位或权益参数不全，最大亏损无法计算；到价不成交或破止损即放弃，不追单。';

    const riskLine = U.el('div', { class: 'tplan-risk' },
      U.el('div', { class: 'tplan-lot' },
        U.el('span', { class: 'k', text: '手数' }),
        U.el('b', { text: lotTxt }),
        U.el('span', { class: 'dim', text: lotNote })),
      U.el('div', { class: 'tplan-say', text: riskSay }));

    const tsTxt = ctx.ts ? '基于 ' + U.hhmmss(Math.floor(ctx.ts / 1000)) + ' 行情' : '基于研判时刻行情';
    const expireTxt = tsTxt + '，超过 30 分钟作废，需重新研判';
    const expire = U.el('div', { class: 'tplan-expire', text: expireTxt });

    const planText = this.text({ p: p, dirText: dirText, styleName: styleName,
      entryText: entryText, entryPx: entryPx, slPx: slPx, tpPx: tpPx, rr: rr, rrMin: rrMin,
      c: c, eq: eq, now: now, expireTxt: expireTxt, riskSay: riskSay, lotNote: lotNote });

    const doneTs = this.doneAt(ctx.sid, p.side, ctx.ts);
    const markBtn = U.el('button', {
      class: 'btn sm' + (doneTs ? '' : ' gold'),
      text: doneTs ? '已执行 ' + U.hhmmss(Math.floor(doneTs / 1000)) : '标记已执行',
      title: '只在本机记一笔（不开仓、不发单）；真正开仓请到持仓页填写',
      disabled: !!doneTs,
      onclick: () => {
        this.markDone(ctx.sid, p.side);
        card.classList.add('done');
        markBtn.textContent = '已执行 ' + U.hhmmss(Math.floor(Date.now() / 1000));
        markBtn.disabled = true;
        markBtn.classList.remove('gold');
        U.toast('已标记执行（仅本机记录，未开仓）', 'ok');
      }
    });

    const foot = U.el('div', { class: 'tplan-foot' },
      U.el('button', { class: 'btn sm', text: '复制计划', onclick: () => this.copy(planText) }),
      markBtn,
      U.el('span', { class: 'spacer' }),
      U.el('span', { class: 'dim', text: eq.v === null ? '权益未知（手数无法计算）'
        : '权益 ' + '$' + U.fx(eq.v, 2) + (eq.live ? '（实时）' : '（配置值，实时读取失败）') }));

    const card = U.el('div', { class: 'tplan' + (doneTs ? ' done' : '') },
      head, grid, riskLine, expire, foot);
    U.clear(host);
    host.appendChild(card);
    // 重复错误拦截：异步补黄条，不阻断计划落地（记忆层不可用时静默跳过）
    this.bindRepeat(host, card, p, c);
  },

  /** 纯文本计划（写剪贴板、贴给自己备忘） */
  text(o) {
    const L = [];
    L.push(`【交易计划】${o.dirText}${o.styleName ? ' · ' + o.styleName : ''}`);
    L.push('生成时间 ' + U.full(Math.floor(o.now / 1000)));
    L.push('入场区 ' + o.entryText + (typeof o.p.entry === 'string' && o.entryPx !== null
      ? `（按中值 ${U.px(o.entryPx)} 计手数）` : ''));
    L.push('止损 ' + (o.slPx !== null ? U.px(o.slPx) : '--'));
    L.push('目标 ' + (o.tpPx !== null ? U.px(o.tpPx) : '--')
      + (o.p.tp2 ? `（TP1 减半，余仓看 TP2 ${U.px(o.p.tp2)}）` : ''));
    L.push('盈亏比 ' + (o.rr !== null ? U.fx(o.rr, 1) + ':1' : '--')
      + (o.rr !== null && o.rrMin !== null && o.rr < o.rrMin
        ? `（低于策略要求 ${U.fx(o.rrMin, 1)}）` : ''));
    L.push('手数 ' + (o.c ? U.fx(o.c.lot, 2) + ' 手' : '--') + '（' + o.lotNote
      + (o.eq.v !== null ? `，权益 ${'$' + U.fx(o.eq.v, 2)}` : '') + '）');
    L.push('最大亏损约 ' + (o.c ? '$' + U.fx(o.c.riskMoney, 2) : '--'));
    L.push('有效期 ' + o.expireTxt);
    if (o.p.trigger) L.push('触发条件 ' + o.p.trigger);
    L.push('风险提示 ' + o.riskSay);
    return L.join('\n');
  }
};

/* ---------- 行情页 ---------- */

const PageWatch = {
  key: 'watch',
  title: '行情',
  iv: '5m',
  subIv: 'rsi',
  busy: false,
  _timer: null,
  aiStrategy: null,    // 基本分析区选中的策略（brief 仪表盘旁的下拉）
  aiBusy: null,       // 正在请求的策略 id
  aiErr: null,        // { id, msg } 最近一次失败

  render(view) {
    // 重渲染前清空视图，否则旧内容会叠加，新页面被盖住
    U.clear(view);
    State.currentIv = this.iv; // 供 AI Agent 读取当前查看的周期
    const page = U.el('div', { class: 'page' });

    // 周期与副图切换
    const ivTabs = U.el('div', { class: 'iv-tabs' },
      ['5m', '15m', '1h', '4h', '1d'].map((v) =>
        U.el('div', {
          class: 'iv-tab' + (v === this.iv ? ' on' : ''),
          text: U.ivLabel(v),
          onclick: () => { this.iv = v; this.load(); this.render(view); }
        })));

    const subTabs = U.el('div', { class: 'iv-tabs' },
      [['none', '无'], ['rsi', 'RSI'], ['macd', 'MACD']].map(([v, l]) =>
        U.el('div', {
          class: 'iv-tab' + (v === this.subIv ? ' on' : ''),
          text: l,
          onclick: () => { this.subIv = v; this.render(view); }
        })));

    const indChips = U.el('div', { class: 'ind-chips' },
      [['ema20', 'EMA20'], ['ema50', 'EMA50'], ['boll', 'BOLL']]
        .map(([k, l]) => U.el('div', {
          class: 'chip' + (State.indicators.has(k) ? ' on' : ''),
          text: l,
          onclick: () => {
            State.indicators.has(k) ? State.indicators.delete(k) : State.indicators.add(k);
            this.render(view);
          }
        })));

    const refreshBtn = U.el('button', {
      class: 'btn sm', text: '强制刷新',
      onclick: async () => { await this.load(true); this.render(view); }
    });

    // ---- 画线工具 ----
    const dwgBtns = {};
    const mkDwg = (mode, label) => {
      const b = U.el('button', {
        class: 'btn sm' + (State.drawMode === mode ? ' gold' : ''),
        text: label,
        onclick: () => {
          State.drawMode = State.drawMode === mode ? null : mode;
          this.syncDrawBtns();
        }
      });
      dwgBtns[mode] = b;
      return b;
    };
    this._dwgBtns = dwgBtns;
    const drawBar = U.el('div', { class: 'row', style: 'margin-bottom:8px;gap:6px' },
      U.el('span', { class: 'dim', style: 'font-size:11px;flex:none', text: '画线' }),
      mkDwg('h', '— 水平线'),
      mkDwg('t', '／ 趋势线'),
      U.el('button', {
        class: 'btn sm', text: '撤销', style: 'flex:none',
        onclick: () => { Charts.undoDraw(this.iv); this.load(false); }
      }),
      U.el('button', {
        class: 'btn sm', text: '清除', style: 'flex:none',
        onclick: () => {
          if (window.confirm('清除当前周期的全部标记？')) {
            Charts.clearDraw(this.iv);
            this.load(false);
          }
        }
      }),
      U.el('span', { class: 'dim', id: 'dwgHint', style: 'font-size:11px' }));

    const chartHost = U.el('div', { class: 'chart-host', style: 'height:440px' });
    const subHost = this.subIv !== 'none'
      ? U.el('div', { class: 'chart-host', style: 'height:96px' }) : null;

    const infoHost = U.el('div', { class: 'stats' });
    const dataNote = U.el('div', { class: 'note', text: '加载中…' });

    const head = U.card('K 线 · ' + U.ivLabel(this.iv),
      U.el('div', {},
        U.el('div', { class: 'row', style: 'margin-bottom:8px' },
          ivTabs, U.el('div', { class: 'spacer' }), indChips, subTabs, refreshBtn),
        drawBar,
        chartHost, subHost),
    );

    // ---- 基本分析两小块（仪表盘摘要 ai-head + 一句话结论）：
    //      裸放现价卡之下、数据源卡之上；完整研判在信号页，生成入口也在信号页
    const strategies = (State.settings && State.settings.strategies) || [];
    if (!this.aiStrategy || !strategies.some((x) => x.id === this.aiStrategy)) {
      this.aiStrategy = (State.settings && State.settings.active_strategy)
        || (strategies[0] && strategies[0].id) || null;
    }
    const aiSel = U.el('select', {
      title: '选择要查看研判的策略',
      style: 'width:100%;font-size:12px;padding:3px 6px;margin-bottom:8px'
    }, strategies.length
      ? strategies.map((st) => U.el('option', {
        value: st.id, text: st.name + (st.enabled ? '' : '（未启用）')
      }))
      : [U.el('option', { value: '', text: '未配置策略' })]);
    aiSel.value = this.aiStrategy || '';
    aiSel.addEventListener('change', () => {
      this.aiStrategy = aiSel.value;
      this.aiErr = null;
      this.showAI();
    });
    const briefHost = U.el('div', {});
    const aiHost = U.el('div', {}, aiSel, briefHost);
    // 到价提醒小组件：现价卡下方（提醒源与触发逻辑在 js/alerts.js，跨页生效）
    const alertHost = U.el('div', {});
    const right = U.el('div', { style: 'display:flex;flex-direction:column;gap:11px' },
      U.card('现价', infoHost),
      U.card('到价提醒', alertHost),
      aiHost,
      U.card('数据源', dataNote)
    );

    page.appendChild(U.el('div', { class: 'g-main' }, head, right));
    view.appendChild(page);

    this.hosts = { chartHost, subHost, infoHost, right, dataNote, aiHost, briefHost, alertHost };
    this.syncDrawBtns();
    this.load(false);
    this.showAI();
    try { window.Alerts?.renderWidget?.(alertHost); }
    catch (e) { console.warn('[alerts] 小组件渲染失败，已忽略：', e.message); }
    // 基本分析自动轮询：每分钟检查一次，研判超 10 分钟且页面可见才重新生成
    if (this._aiTimer) clearInterval(this._aiTimer);
    this._aiTimer = setInterval(() => this._aiTick(), 60 * 1000);
  },

  /* ---------- 基本分析（窄栏简版：两小块只读展示） ---------- */

  /** 按选中策略槽渲染两小块（未分析 → 引导文案，不造假数据） */
  showAI() {
    const host = this.hosts && this.hosts.briefHost;
    if (!host || !host.isConnected) return;
    AIReport.ensureLoaded().then(() => {
      const h = this.hosts && this.hosts.briefHost;
      if (!h || !h.isConnected) return;
      const sid = this.aiStrategy
        || (State.settings && State.settings.active_strategy) || '';

      if (this.aiBusy === sid) {
        U.clear(h);
        h.appendChild(U.el('div', { class: 'chart-loading loading-dots', text: 'AI 分析中' }));
        return;
      }
      if (this.aiErr && this.aiErr.id === sid) {
        U.clear(h);
        h.appendChild(U.el('div', { class: 'note err', text: 'AI 分析失败：' + this.aiErr.msg }));
        return;
      }

      const c = (State.analyses || {})[sid];
      AIReport.renderBrief(h, c ? c.a : null, {
        ts: c ? c.t : 0,
        emptyText: sid ? '未研判：到信号页选择该策略生成' : '未配置策略：请先到策略页新建'
      });
    });
  },

  /** 对当前选中策略重新发起 AI 研判，结果按策略多槽存 */
  async runAI() {
    const id = this.aiStrategy
      || (State.settings && State.settings.active_strategy) || '';
    if (!id) return U.toast('请先到策略页配置策略', 'warn');
    this.aiBusy = id;
    this.aiErr = null;
    this.showAI();
    try {
      const a = await API.signalEnhanced(id);
      AIReport.save(id, a);
    } catch (e) {
      this.aiErr = { id: id, msg: e.message };
    }
    this.aiBusy = null;
    this.showAI();
  },

  /** 自动轮询检查：页面可见且研判超过 10 分钟才重新生成（低频省 token） */
  _aiTick() {
    if (document.visibilityState !== 'visible') return;
    const sid = this.aiStrategy
      || (State.settings && State.settings.active_strategy) || '';
    if (!sid || this.aiBusy) return;
    const c = (State.analyses || {})[sid];
    if (!c || Date.now() - c.t > 10 * 60 * 1000) this.runAI();
  },

  /** 画线按钮态与提示同步 */
  syncDrawBtns() {
    const b = this._dwgBtns;
    if (b) {
      if (b.h) b.h.classList.toggle('gold', State.drawMode === 'h');
      if (b.t) b.t.classList.toggle('gold', State.drawMode === 't');
    }
    const hint = document.getElementById('dwgHint');
    if (hint) {
      hint.textContent = State.drawMode === 'h'
        ? '点图表任意位置画水平支撑/阻力线，再点按钮退出'
        : State.drawMode === 't'
          ? '依次点两个位置连成趋势线，再点按钮退出'
          : '标记按周期保存在本机，刷新不丢';
    }
  },

  async load(force) {
    // 加载中又被请求（切周期/重渲染）：排队一次，完成后补跑，不丢
    if (this.busy) { this._queued = true; return; }
    this.busy = true;
    try {
      const [ser, ind] = await Promise.all([
        API.series(this.iv, force),
        API.indicators(this.iv)
      ]);

      // 用最新 hosts：请求期间页面可能已被重渲染（旧宿主已断开）
      const hosts = this.hosts;
      const { chartHost, subHost, infoHost, dataNote } = hosts || {};
      if (!chartHost || !chartHost.isConnected) return;
      // 快速连点时序错开：结果周期与当前所选不符则丢弃，由排队的补画
      if (ser.interval && ser.interval !== this.iv) return;

      Charts.main(chartHost, ser, ind, State.indicators);
      if (subHost && subHost.isConnected) {
        Charts.sub(subHost, this.subIv, ind, ind.times);
      }

      // 数据源说明
      if (dataNote && dataNote.isConnected) {
        const flags = [];
        if (ser.simulated) flags.push('模拟数据');
        if (ser.stale) flags.push('上游标注为陈旧');
        if (ser.error) flags.push(ser.error);
        dataNote.className = 'note' + (ser.simulated ? ' warn' : (ser.stale ? ' warn' : ''));
        dataNote.textContent =
          `${ser.source} · ${ser.points} 根 · 更新于 ${U.ago(ser.fetched_at)}` +
          (flags.length ? `\n${flags.join('；')}` : '');
      }

      // 现价卡片
      U.clear(infoHost);
      const sp = State.spot;
      if (sp) {
        const chg = sp.prev_close ? sp.price - sp.prev_close : null;
        infoHost.appendChild(U.stat('现价', U.px(sp.price), U.hhmmss(sp.t)));
        if (chg !== null) {
          infoHost.appendChild(U.stat('较上次', U.signed(chg),
            ((chg / sp.prev_close) * 100).toFixed(2) + '%', U.cls(chg)));
        }
        if (sp.change_today !== null && sp.change_today !== undefined) {
          infoHost.appendChild(U.stat('今日', U.signed(sp.change_today),
            sp.change_pct != null ? sp.change_pct.toFixed(2) + '%' : '', U.cls(sp.change_today)));
        }
        infoHost.appendChild(U.stat('点差', U.fx(State.spreadPoints, 0) + ' 点',
          State.spreadPoints > (State.settings?.risk?.max_spread_points ?? 35) ? '超限' : '正常',
          State.spreadPoints > (State.settings?.risk?.max_spread_points ?? 35) ? 'down' : ''));
        if (sp.silver) infoHost.appendChild(U.stat('白银', U.fx(sp.silver, 2), '美元/盎司'));
        if (sp.gold_silver_ratio) infoHost.appendChild(U.stat('金银比', U.fx(sp.gold_silver_ratio, 1)));
      }
    } catch (e) {
      const { chartHost } = this.hosts || {};
      if (chartHost && chartHost.isConnected) {
        U.clear(chartHost);
        chartHost.appendChild(U.el('div', { class: 'empty-tip', text: '行情加载失败：' + e.message }));
      }
    } finally {
      this.busy = false;
      if (this._queued) { this._queued = false; this.load(false); }
    }
  },

  tick(view) {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (State.spot) {
        const { infoHost } = this.hosts || {};
        if (infoHost && infoHost.isConnected) this.load(false);
      }
    }, 30000);
  },

  destroy() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._aiTimer) { clearInterval(this._aiTimer); this._aiTimer = null; }
    this.hosts = null;
    this._queued = false;
    this._dwgBtns = null;
  }
};
