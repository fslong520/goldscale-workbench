/* 插件 · 行为周报（产品哲学：agent 靠记忆形成免疫力）
 * 契约：window.Pages['behavior-review'] = { key, title, render(view), destroy() }
 * 数据全部来自真实接口，宁缺毋假：
 *   ① /api/positions —— 本地模拟成交（按平仓时间筛本期）
 *   ② /api/memory?q=亏损归因 —— 复盘页写入的归因记忆（复盘页不动，这里只读）
 *   ③ /api/ai —— 用户点「让 AI 总结」才发，一次一个请求，失败可重试，绝不塞假总结
 * 记忆插件未开启时不报错：顶部提示开启，本地成交统计照常看。
 */
window.Pages = window.Pages || {};

window.Pages['behavior-review'] = {
  key: 'behavior-review',
  title: '行为周报',
  _days: 7,          // 7=本周 30=本月
  _busy: false,      // AI 请求进行中
  _data: null,       // 最近一次聚合结果（重试 AI 时复用，不重新拉一遍）
  _summary: '',      // AI 总结文本：跨渲染保留，切页回来不用重烧 token

  /* 简单分词表：对每条归因文案做关键词计数（每条同一词最多计 1 次，不放大单条） */
  WORDS: ['逆势', '抄底', '接刀', '追高', '追涨', '杀跌', '止损被扫', '太紧',
    '过早', '无确认', '过久', '回吐', '重仓'],

  render(view) {
    U.clear(view);
    const page = U.el('div', { class: 'page' });
    this.h = {
      rangeHost: U.el('div', { class: 'btns' }),
      srcHost: U.el('div', {}),
      statHost: U.el('div', { class: 'stats' }),
      freqHost: U.el('div', {}),
      aiHost: U.el('div', {}),
      footHost: U.el('div', {})
    };

    /* ① 两个按钮：本周 / 本月 */
    const mk = (days, text) => {
      const b = U.el('button', {
        class: 'btn sm' + (this._days === days ? ' gold' : ''), text: text,
        title: '按平仓时间统计最近 ' + days + ' 天'
      });
      b.addEventListener('click', () => { this._days = days; this._summary = ''; this.render(view); });
      return b;
    };
    this.h.rangeHost.append(mk(7, '本周报告'), mk(30, '本月报告'));

    page.appendChild(U.card('统计口径', U.el('div', {},
      this.h.rangeHost,
      U.el('div', { class: 'note', style: 'margin-top:9px' },
        '数据源只有两个：本地模拟成交、记忆库里的亏损归因；取不到的那半就明说，不凑数。'),
      this.h.srcHost)));

    page.appendChild(U.card('本期账目', this.h.statHost));
    page.appendChild(U.card('错误词频', this.h.freqHost));
    page.appendChild(U.card('AI 复盘总结', this.h.aiHost));
    page.appendChild(this.h.footHost);

    view.appendChild(page);
    this.load();
  },

  /* ---------- 聚合：一次拉齐成交与归因，全部为真数据 ---------- */

  /** 只认复盘页写的归因条（跨页契约，见 js/pages/review.js::saveAttr）：
   *  标题以「亏损归因」开头，或 tags 里有精确的「亏损归因」——
   *  否则记忆库里写「亏损归因功能」的总结条会被误当亏损归因。 */
  isAttr(it) {
    if (!it) return false;
    const title = String(it.title || '').trim();
    if (/^亏损归因([\s　]|$)/.test(title)) return true;
    const tags = Array.isArray(it.tags) ? it.tags : [];
    return tags.some((t) => String(t).trim() === '亏损归因');
  },

  async collect() {
    const days = this._days;
    const since = Date.now() - days * 864e5;
    const out = { days: days, closed: [], posErr: null, mem: [], memOff: false, memErr: null };

    try {
      const all = await API.positions();
      const list = Array.isArray(all) ? all : [];
      out.closed = list.filter((p) => p && p.status === 'closed'
        && Number(p.closed_at || 0) * 1000 >= since);
    } catch (e) { out.posErr = e.message || '成交读取失败'; }

    try {
      const items = await API.memList('亏损归因');
      const arr = Array.isArray(items) ? items : [];
      out.mem = arr.filter((it) => {
        if (!this.isAttr(it)) return false;
        const ts = Number(it.updated || 0) * 1000;
        return ts > 0 && ts >= since;
      });
    } catch (e) {
      // 记忆插件未开启 / runtime 不通：本地成交照统计，归因那一半如实标注
      out.memOff = /记忆插件未开启/.test(String(e.message || ''));
      out.memErr = e.message || '记忆读取失败';
    }
    return out;
  },

  /** 词频：每条归因里同一关键词最多计 1 次；按次数降序 */
  freq(mem) {
    const rows = [];
    for (const w of this.WORDS) {
      let n = 0;
      for (const it of mem) if (String(it.body || '').includes(w)) n++;
      if (n > 0) rows.push([w, n]);
    }
    rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return rows;
  },

  async load() {
    const h = this.h;
    if (!h) return;
    U.clear(h.statHost);
    h.statHost.appendChild(U.el('div', { class: 'empty-tip', text: '读取中…' }));
    U.clear(h.freqHost);
    h.freqHost.appendChild(U.el('div', { class: 'empty-tip', text: '读取中…' }));

    const data = await this.collect();
    if (!h.statHost || !h.statHost.isConnected) return;   // 切页了，别写空
    this._data = data;
    this.paint(data);
  },

  paint(data) {
    const h = this.h;
    if (!h) return;
    const label = data.days === 7 ? '本周' : '本月';

    /* 来源与降级提示（如实说明能看什么、不能看什么） */
    U.clear(h.srcHost);
    if (data.memOff) {
      h.srcHost.appendChild(U.el('div', { class: 'note warn', style: 'margin-top:9px' },
        '记忆插件未开启：本页只统计本地成交，归因词频与 AI 总结需要先到设置页开启记忆插件。'));
    } else if (data.memErr) {
      h.srcHost.appendChild(U.el('div', { class: 'note err', style: 'margin-top:9px' },
        '归因记忆读取失败：' + data.memErr + '（成交统计不受影响）'));
    }
    h.srcHost.appendChild(U.el('div', { class: 'row', style: 'margin-top:9px' },
      U.el('span', { class: 'chip', text: '口径：' + label + '（按平仓时间）' }),
      data.memOff ? null : U.el('span', { class: 'chip', text: '归因取自记忆语义召回（上限 30 条）' })));

    /* 本地统计 */
    const n = data.closed.length;
    const losses = data.closed.filter((p) => Number(p.pnl || 0) < 0);
    const wins = data.closed.filter((p) => Number(p.pnl || 0) > 0);
    const pnl = data.closed.reduce((a, p) => a + Number(p.pnl || 0), 0);
    const rows = this.freq(data.mem);
    const top = rows.length ? rows[0][0] + ' ×' + rows[0][1] : '--';

    U.clear(h.statHost);
    h.statHost.append(
      U.stat('平仓笔数', data.posErr ? '--' : String(n), data.posErr ? data.posErr : '笔', ''),
      U.stat('亏损笔数', data.posErr ? '--' : String(losses.length), '笔', losses.length ? 'down' : ''),
      U.stat('胜率', data.posErr || n === 0 ? '--' : U.fx(wins.length / n * 100, 1) + '%',
        n === 0 ? '本期无平仓' : wins.length + '/' + n, n === 0 ? 'dim' : (wins.length / n >= 0.5 ? 'up' : 'down')),
      U.stat('总盈亏', data.posErr ? '--' : U.money(pnl), '本地模拟', data.posErr ? '' : U.cls(pnl)),
      U.stat('归因条数', data.memOff ? '--' : String(data.mem.length), data.memOff ? '记忆未开启' : '条', ''),
      U.stat('最高频错误', top, rows.length ? '来自归因原文' : null, rows.length ? 'down' : 'dim'));

    /* ③ 词频条形（纯 DOM 宽度百分比，不引图表库） */
    U.clear(h.freqHost);
    if (!rows.length) {
      h.freqHost.appendChild(U.el('div', { class: 'empty-tip' },
        data.memOff ? '记忆插件未开启，暂时看不到归因词频。'
          : '本期归因没命中已知错误词。'));
    } else {
      const max = rows[0][1];
      for (let i = 0; i < rows.length; i++) {
        const w = rows[i][0], c = rows[i][1];
        const pct = Math.max(4, Math.round(c / max * 100));
        // 最高频的那条用告警色，其余压成暗金：一眼看出该防的是哪个错
        const color = i === 0 ? 'var(--warn)' : 'var(--gold-dim)';
        h.freqHost.appendChild(U.el('div', { style: 'display:flex;align-items:center;gap:9px;margin:5px 0' },
          U.el('span', { class: i === 0 ? '' : 'dim', style: 'width:66px;flex:none;font-size:12px;text-align:right', text: w }),
          U.el('div', { style: 'flex:1;height:12px;background:var(--bg-3);border-radius:6px;overflow:hidden' },
            U.el('div', { style: 'width:' + pct + '%;height:100%;background:' + color + ';border-radius:6px' })),
          U.el('span', { class: 'mono', style: 'width:28px;flex:none;font-size:12px', text: String(c) })));
      }
    }

    /* ② AI 总结 */
    this.paintAI(data, rows);
    this.paintFoot();
  },

  paintAI(data, rows) {
    const h = this.h;
    U.clear(h.aiHost);
    const empty = data.mem.length === 0;
    const btn = U.el('button', {
      class: 'btn sm gold', text: this._busy ? '总结中…' : '让 AI 总结',
      disabled: this._busy,
      title: '把本期账目与逐条归因原文交给 AI，用大白话说清反复犯的错'
    });
    btn.addEventListener('click', () => this.runAI());
    h.aiHost.appendChild(U.el('div', { class: 'row' }, btn,
      U.el('span', { class: 'dim', text: '60–120 字：TOP 错误排行 + 一条下周纪律。' })));

    if (empty && !data.closed.length) {
      h.aiHost.appendChild(U.el('div', { class: 'note', style: 'margin-top:9px' },
        '还没有归因记录——去复盘页给亏损单点『归因』。'));
      const go = U.el('button', { class: 'btn sm', text: '去复盘页', onclick: () => App.go('review') });
      h.aiHost.appendChild(U.el('div', { class: 'btns', style: 'margin-top:9px' }, go));
    }

    if (this._summary) {
      h.aiHost.appendChild(U.el('div', { class: 'chat-md', style: 'margin-top:10px', html: U.md(this._summary) }));
    }
  },

  buildPrompt(data, rows) {
    const label = data.days === 7 ? '本周' : '本月';
    const n = data.closed.length;
    const losses = data.closed.filter((p) => Number(p.pnl || 0) < 0);
    const wins = data.closed.filter((p) => Number(p.pnl || 0) > 0);
    const pnl = data.closed.reduce((a, p) => a + Number(p.pnl || 0), 0);
    const L = [];
    L.push('你在帮一个做黄金日内模拟交易的人复盘' + label + '的行为。以下全是本地真实数据，只许依据它，不得编造。');
    L.push('账目：平仓 ' + n + ' 笔，亏损 ' + losses.length + ' 笔，盈利 ' + wins.length + ' 笔，总盈亏 ' +
      U.money(pnl) + ' 美元。');
    if (rows.length) {
      L.push('归因词频：' + rows.map(([w, c]) => w + ' ' + c + ' 次').join('、') + '。');
    } else {
      L.push('归因词频：本期无（无归因记录）。');
    }
    if (data.mem.length) {
      L.push('逐条归因原文（时间『' + label + '』内，' + data.mem.length + ' 条）：');
      data.mem.forEach((it, i) => {
        L.push((i + 1) + '. ' + String(it.title || '') + '：' + String(it.body || '').replace(/\s+/g, ' ').trim());
      });
    }
    L.push('请输出 60-120 个字的大白话：先点名反复出现的 TOP 错误排行（引用上面归因原文里的关键词），' +
      '最后给一条下周只做得到的具体纪律。不要分点、不要标题、不要寒暄、不要提模型与数据格式。');
    return L.join('\n');
  },

  async runAI() {
    const h = this.h;
    if (!h || this._busy) return;
    const data = this._data;
    if (!data) return;
    if (!data.mem.length && !data.closed.length) {
      U.toast('本期没有可总结的真实数据', 'warn');
      return;
    }
    const rows = this.freq(data.mem);
    this._busy = true;
    this.paintAI(data, rows);
    // 加载态：明确说在跑，不留白屏
    h.aiHost.appendChild(U.el('div', { class: 'attr-text loading-dots', style: 'margin-top:9px', text: '正在让 AI 总结' }));
    try {
      const sid = (State.settings && State.settings.active_strategy) || '';
      const r = await API.ai(this.buildPrompt(data, rows), sid, []);
      const text = r && r.text ? String(r.text).trim() : '';
      if (!text) throw new Error('AI 未返回内容');
      this._summary = text;
      this._busy = false;
      this.paintAI(data, rows);
      U.toast('AI 总结完成', 'ok');
    } catch (e) {
      this._busy = false;
      // 失败明说，绝不塞假总结
      this.paintAI(data, rows);
      h.aiHost.appendChild(U.el('div', { class: 'note err', style: 'margin-top:9px' },
        'AI 总结失败：' + (e.message || '请求失败')));
      const retry = U.el('button', { class: 'btn sm', text: '重试', onclick: () => this.runAI() });
      h.aiHost.appendChild(U.el('div', { class: 'btns', style: 'margin-top:9px' }, retry));
      U.toast('AI 总结失败：' + (e.message || '请求失败'), 'err');
    }
  },

  paintFoot() {
    const h = this.h;
    U.clear(h.footHost);
    h.footHost.appendChild(U.el('div', { class: 'note' },
      '全部为本地模拟数据与本地记忆，不构成投资建议；归因文案由 AI 生成，仅作提醒，不保证归因正确。'));
  },

  destroy() {
    this.h = null;
    this._busy = false;
    // _summary 与 _days 保留到下次进页：切页回来不用重新烧一次 token
  }
};
