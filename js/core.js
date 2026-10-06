/* 核心工具：API 封装、DOM 助手、格式化、状态缓存 */

const API_BASE = '';

/* Agent 常驻宿主 goldscale-agentd（独立进程）：金秤重启不断它的会话，
   金秤崩了它还负责把金秤拉起来。只有 /api/agent* 走这个绝对地址。 */
const AGENT_BASE = 'http://127.0.0.1:8788';

const U = {
  /* ---------- 格式化 ---------- */
  fx(n, d = 2) {
    if (n === null || n === undefined || Number.isNaN(n)) return '--';
    return Number(n).toLocaleString('zh-CN', {
      minimumFractionDigits: d, maximumFractionDigits: d
    });
  },
  px(n) { return U.fx(n, 2); },
  money(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '--';
    const r = Math.round(n * 100) / 100;
    if (r === 0) return '0.00';          // 修 -0.00：小额四舍五入后不带符号
    return (r > 0 ? '+' : '') + U.fx(r, 2);
  },
  signed(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '--';
    const r = Math.round(n * 100) / 100;
    if (r === 0) return '0.00';
    return (r > 0 ? '+' : '') + U.fx(r, 2);
  },
  cls(v) {
    if (v === null || v === undefined || v === 0) return 'dim';
    return v > 0 ? 'up' : 'down';
  },

  hhmmss(ts) {
    const d = new Date(ts * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },
  mdhm(ts) {
    const d = new Date(ts * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  full(ts) {
    const d = new Date(ts * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },
  ago(ts) {
    const s = Math.floor(Date.now() / 1000 - ts);
    if (s < 60) return `${s} 秒前`;
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
  },

  ivLabel(v) {
    return { '5m': 'M5', '15m': 'M15', '1h': 'H1', '4h': 'H4', '1d': 'D1' }[v] || v;
  },

  /* ---------- DOM ---------- */
  el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat(3)) {
      if (c === null || c === undefined || c === false) continue;
      n.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    return n;
  },

  $: (sel, root = document) => root.querySelector(sel),
  $$: (sel, root = document) => Array.from(root.querySelectorAll(sel)),

  clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; },

  card(title, body, actions) {
    const head = actions
      ? U.el('div', { class: 'card-head' },
          U.el('span', { text: title }),
          U.el('div', { class: 'row' }, actions))
      : U.el('div', { class: 'card-head' }, U.el('span', { text: title }));
    return U.el('div', { class: 'card' }, head, U.el('div', { class: 'card-body' }, body));
  },

  table(headers, rows) {
    const th = headers.map((h) =>
      U.el('th', { class: h.num ? 'num' : '', text: h.label ?? h }));
    const trs = rows.map((cells) => U.el('tr', {},
      cells.map((c) => {
        // DOM 节点（按钮等）直接入格——Node 也是 object，须先于描述符分支判断
        if (c instanceof Node) return U.el('td', {}, c);
        if (c && typeof c === 'object' && !Array.isArray(c)) {
          return U.el('td', { class: (c.num ? 'num ' : '') + (c.cls || '') }, c.v);
        }
        return U.el('td', {}, c);
      })));
    return U.el('table', { class: 'grid' },
      U.el('thead', {}, U.el('tr', {}, th)),
      U.el('tbody', {}, trs));
  },

  stat(label, value, sub, cls = '') {
    return U.el('div', { class: 'stat' },
      U.el('div', { class: 'stat-l', text: label }),
      U.el('div', { class: 'stat-v ' + cls, text: value }),
      sub ? U.el('div', { class: 'stat-s', text: sub }) : null);
  },

  field(label, input) {
    return U.el('label', { class: 'f' }, U.el('span', { text: label }), input);
  },

  numInput(value, opts = {}) {
    return U.el('input', Object.assign({
      type: 'number', value: value,
      step: opts.step ?? 'any', min: opts.min, max: opts.max
    }, opts.attrs || {}));
  },

  sel(value, options) {
    const s = U.el('select', {},
      options.map(([v, l]) => U.el('option', { value: v, text: l, selected: v === value })));
    s.value = value;
    return s;
  },

  /** 深拷贝纯数据对象 */
  clone(o) {
    return o === null || o === undefined ? o : JSON.parse(JSON.stringify(o));
  },

  toast(msg, type = '') {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const t = U.el('div', { class: 'toast ' + type, text: msg });
    host.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  },

  /* ---------- Markdown（投资分析向）----------
   * 返回 HTML 字符串：所有动态文本先全量转义再逐层上样式，无 XSS 面。
   * 个性配置：价位/百分比数字高亮、多空语义词着色、紧凑表格、暗色代码块 */
  md(text) {
    if (text === null || text === undefined) return '';
    return mdBlock(String(text));
  }
};

function mdEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* 多空语义词（投资场景着色） */
const MD_UP = ['看多', '看涨', '做多', '开多', '多头', '买入', '开仓做多', '上涨', '上行', '走强',
  '突破', '利多', '利好', '支撑', '加仓', '止盈', '偏多', '反弹', '企稳', '新高', '多单', '金叉'];
const MD_DOWN = ['看空', '看跌', '做空', '开空', '空头', '卖出', '下跌', '下行', '走弱', '跌穿',
  '跌破', '利空', '阻力', '减仓', '止损', '偏空', '回落', '破位', '新低', '空单', '死叉'];

function mdStyleText(s) {
  let out = mdEsc(s);
  // 1) 数字与百分比（价位、涨跌幅、R 倍数）——先于其它规则，避免命中标签属性
  out = out.replace(/-?\b\d+(?:\.\d+)?(?:%|R)?\b/g, (m) => `<span class="md-num">${m}</span>`);
  // 2) 多空语义词着色
  for (const w of MD_UP) out = out.split(w).join(`<span class="up">${w}</span>`);
  for (const w of MD_DOWN) out = out.split(w).join(`<span class="down">${w}</span>`);
  // 3) 行内样式（strong/em 内仍可含上面的 span）
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  // 4) 链接（仅 http/https）
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

function mdInline(s) {
  // 行内代码单独处理，内部不着色不转数字
  return s.split(/(`[^`]+`)/g).map((p) => {
    if (p.length > 2 && p.startsWith('`') && p.endsWith('`')) {
      return `<code>${mdEsc(p.slice(1, -1))}</code>`;
    }
    return mdStyleText(p);
  }).join('');
}

function mdBlock(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);
      para.length = 0;
    }
  };

  while (i < lines.length) {
    const ln = lines[i];
    // 围栏代码块
    const fence = ln.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 跳过收尾 ```
      out.push(`<pre class="md-pre"><code>${mdEsc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // 表格
    if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara();
      const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(ln);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(cells(lines[i])); i++; }
      out.push(
        '<div class="md-tblwrap"><table class="md-table"><thead><tr>' +
        head.map((h) => `<th>${mdInline(h)}</th>`).join('') +
        '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + r.map((c) => `<td>${mdInline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>'
      );
      continue;
    }
    // 标题
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const lvl = Math.min(h[1].length + 3, 6); // # -> h4 ... 保持聊天内紧凑
      out.push(`<h${lvl}>${mdInline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) { flushPara(); out.push('<hr>'); i++; continue; }
    // 引用
    if (/^\s*>\s?/.test(ln)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${buf.map(mdInline).join('<br>')}</blockquote>`);
      continue;
    }
    // 无序列表
    if (/^\s*[-*+]\s+/.test(ln)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
      out.push(`<ul>${items.map((t) => `<li>${mdInline(t)}</li>`).join('')}</ul>`);
      continue;
    }
    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(ln)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
      out.push(`<ol>${items.map((t) => `<li>${mdInline(t)}</li>`).join('')}</ol>`);
      continue;
    }
    // 空行
    if (/^\s*$/.test(ln)) { flushPara(); i++; continue; }
    para.push(ln);
    i++;
  }
  flushPara();
  return out.join('\n');
}

/* ---------- API ---------- */
const API = {
  async req(path, opts = {}) {
    const res = await fetch(API_BASE + path, {
      cache: 'no-store',
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let j;
    try { j = await res.json(); }
    catch { throw new Error(`响应异常 (HTTP ${res.status})`); }
    if (!j.ok) throw new Error(j.error || '请求失败');
    return j.data;
  },
  health: () => API.req('/api/health'),
  settings: () => API.req('/api/settings'),
  saveSettings: (s) => API.req('/api/settings', { method: 'POST', body: s }),
  series: (iv, force = false) =>
    API.req(`/api/series?interval=${encodeURIComponent(iv)}${force ? '&force=true' : ''}`),
  indicators: (iv) => API.req(`/api/indicators?interval=${encodeURIComponent(iv)}`),
  spot: () => API.req('/api/spot'),
  signal: (strategyId) =>
    API.req(`/api/signal?strategy=${encodeURIComponent(strategyId || '')}`),
  signalAll: () => API.req('/api/signal?all=true'),
  signalEnhanced: (strategyId) =>
    API.req(`/api/signal/enhanced?strategy=${encodeURIComponent(strategyId || '')}`),
  positions: () => API.req('/api/positions'),
  open: (p) => API.req('/api/positions', { method: 'POST', body: p }),
  close: (id, price) => API.req('/api/positions/close', { method: 'POST', body: { id, price } }),
  closePartial: (id, pct, price) =>
    API.req('/api/positions/partial', { method: 'POST', body: { id, pct, price } }),
  setSL: (id, sl) => API.req('/api/positions/sl', { method: 'POST', body: { id, sl } }),
  stats: () => API.req('/api/stats'),
  resetDaily: () => API.req('/api/portfolio/reset-daily', { method: 'POST', body: {} }),
  ai: (prompt, strategyId, history) =>
    API.req('/api/ai', { method: 'POST', body: { prompt, strategy: strategyId || '', history: history || [] } }),
  agent: (prompt, chatId, interval) =>
    API.req(AGENT_BASE + '/api/agent', { method: 'POST', body: { prompt, chat_id: chatId || '', interval: interval || '5m' } }),
  aiPresets: () => API.req('/api/ai/presets'),
  aiLog: (limit = 30) => API.req(`/api/ai/log?limit=${limit}`),
  agentStatus: (chatId) => API.req(AGENT_BASE + `/api/agent/status?chat_id=${encodeURIComponent(chatId || '')}`),
  backtest: (payload) => API.req('/api/backtest', { method: 'POST', body: payload }),
  memList: (q) => API.req(`/api/memory?q=${encodeURIComponent(q || '')}`),
  memSave: (item) => API.req('/api/memory', { method: 'POST', body: item }),
  memDel: (id) => API.req(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 记忆插件（respire/rsrs）：状态、开启（必要时自动装 CLI 本体）、关闭
  memPlugin: () => API.req('/api/memory/plugin'),
  memEnable: () => API.req('/api/memory/plugin/enable', { method: 'POST', body: {} }),
  memDisable: () => API.req('/api/memory/plugin/disable', { method: 'POST', body: {} }),

  /* 统一能力绑定（下一批各模块直接用）：
    记忆读写走 8787 三路由——金秤内部代理到 8788 网关，判重/裁决在 agentd 收口
    （既有 memList/memSave/memDel 语义不变，同样是这条路）；
    能力任务口（回测解读/优化建议/亏损归因/研究总结/行为周报）直连 agentd。 */
  memoryList: (q) => API.req(`/api/memory?q=${encodeURIComponent(q || '')}`),
  memorySave: (item) => API.req('/api/memory', { method: 'POST', body: item }),
  memoryDel: (id) => API.req(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  agentTask: (task, context) =>
    API.req(AGENT_BASE + '/api/agent/task', { method: 'POST', body: { task, context: context || {} } })
};

/** token 用量摘要，附在 AI 回答末尾（AIChat 与各页共用） */
function metaLine(r, secs) {
  const parts = [
    '模型 ' + r.model,
    '上下文约 ' + fmtTok(r.context_tokens) + ' / 预算 ' + fmtTok(r.budget_tokens),
    '输入 ' + fmtTok(r.prompt_tokens),
    '输出 ' + fmtTok(r.completion_tokens)
  ];
  if (r.reasoning_tokens > 0) parts.push('其中思考 ' + fmtTok(r.reasoning_tokens));
  parts.push('耗时 ' + secs + 's');
  return '—— ' + parts.join(' · ');
}

function fmtTok(n) {
  if (n === null || n === undefined) return '--';
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
  return String(n);
}

/* ---------- 全局共享状态 ---------- */
const State = {
  settings: null,
  spot: null,
  spotState: 'idle',
  lastSpot: 0,
  signal: null,
  positions: [],
  stats: null,
  execIv: '5m',
  indicators: new Set(['ema20', 'boll']),

  get rrMin() { return this.settings?.strategy?.rr_min ?? 1.8; },
  get confFloor() {
    return this.settings?.personal_strategy?.confidence_floor
      ?? this.settings?.strategy?.confidence_floor ?? 44;
  },
  get contractSize() { return this.settings?.contract_size ?? 100; },
  get pointValue() { return this.settings?.point_value ?? 0.01; },
  get spreadPoints() { return this.settings?.spread_points ?? 28; }
};