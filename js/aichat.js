/* AI 模态对话：多会话管理 + 策略选择 + 工具步骤折叠，F2 随时唤起 */

/* 落盘/读入前的单条消息裁剪：思考全文过长则截断（内存中仍是全文） */
function trimChatMsg(m) {
  if (!m || typeof m !== 'object') return m;
  const t = m.thinking;
  if (typeof t === 'string' && t.length > 4000 && !t.endsWith('…（思考过长已截断）')) {
    return { ...m, thinking: t.slice(0, 4000) + '\n…（思考过长已截断）' };
  }
  return m;
}

const AIChat = {
  _built: false,
  _asking: false,
  _statusTimer: null,   // 流式思考字幕轮询计时器
  _statusChat: '',      // 轮询所属会话（防跨会话串台）
  _askChatId: '',       // 本轮发问所属会话
  _pend: null,          // 当前 pending 气泡的字幕节点引用

  // ---------- 容量上限（落盘与读入共用）----------
  // localStorage 无上限时涨爆即写失败＝历史全丢，故两级兜底：常态上限 50/200，
  // 配额告急时按瘦身档 20/50 重试一次，仍失败才明示（绝不静默）。
  LS_KEY: 'gs_chats_v1',
  MAX_CHATS: 50,
  MAX_MSGS: 200,
  SLIM_CHATS: 20,
  SLIM_MSGS: 50,

  /** 裁剪：会话留最近 maxChats 个、每会话留最近 maxMsgs 条；只告警计数，不动内存 State.chats */
  _trim(maxChats, maxMsgs) {
    const all = Array.isArray(State.chats) ? State.chats : [];
    const droppedChats = Math.max(0, all.length - maxChats);
    let droppedMsgs = 0;
    const list = all.slice(-maxChats).map((c) => {
      const msgs = Array.isArray(c.msgs) ? c.msgs : [];
      if (msgs.length > maxMsgs) droppedMsgs += msgs.length - maxMsgs;
      return { ...c, msgs: msgs.slice(-maxMsgs).map(trimChatMsg) };
    });
    if (droppedChats) console.warn(`[aichat] 会话数超上限 ${maxChats}，丢弃最旧 ${droppedChats} 个`);
    if (droppedMsgs) console.warn(`[aichat] 单会话消息超上限 ${maxMsgs}，共截断 ${droppedMsgs} 条`);
    return list;
  },

  // ---------- 会话数据（localStorage 持久化，刷新不丢） ----------
  _load() {
    if (State.chats) return;
    try {
      const raw = JSON.parse(localStorage.getItem(this.LS_KEY));
      State.chats = (Array.isArray(raw) ? raw : [])
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({ ...c, msgs: Array.isArray(c.msgs) ? c.msgs : [] }));
    } catch { State.chats = []; }
    // 迁移旧单会话
    if (!State.chats.length && State.chat && State.chat.length) {
      State.chats.push(this._newChat(State.chat));
    }
    // 旧档可能超上限：读入即按同一口径裁剪，防一个巨型档拖死内存与后续写入
    State.chats = this._trim(this.MAX_CHATS, this.MAX_MSGS);
    if (!State.chats.length) State.chats.push(this._newChat([]));
    State.chatIdx = 0;
  },

  _newChat(msgs) {
    const first = (msgs || []).find((m) => m.role === 'user');
    return {
      id: 'c' + Date.now(),
      title: first ? first.content.slice(0, 16) : '新会话',
      t: Date.now(),
      strategyId: '',
      msgs: msgs || []
    };
  },

  _save() {
    const write = (maxChats, maxMsgs) => localStorage.setItem(
      this.LS_KEY, JSON.stringify(this._trim(maxChats, maxMsgs)));
    try {
      write(this.MAX_CHATS, this.MAX_MSGS);
    } catch (e) {
      const quota = e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        e.code === 22 || e.code === 1014);
      // 非配额错误（隐私模式/被禁 localStorage 等）：同样明示，不吞
      if (!quota) {
        console.warn('[aichat] 历史保存失败：', e);
        U.toast('历史保存失败：' + ((e && e.message) || e), 'err');
        return;
      }
      // 配额告急：自动瘦身重试一次（会话砍到 20、消息砍到 50）
      try {
        write(this.SLIM_CHATS, this.SLIM_MSGS);
        console.warn(`[aichat] 本地存储已满，自动瘦身至 ${this.SLIM_CHATS} 会话 / 每会话 ${this.SLIM_MSGS} 条`);
      } catch (e2) {
        console.warn('[aichat] 瘦身后仍写入失败：', e2);
        U.toast('历史保存失败：本地存储已满', 'err');
      }
    }
  },

  // ---------- 复制（clipboard 优先，execCommand 兜底） ----------
  _copy(text) {
    const s = text === null || text === undefined ? '' : String(text);
    const okToast = () => U.toast('已复制');
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

  /** 气泡右上角「复制」小按钮（hover 显形） */
  _copyBtn(getText) {
    return U.el('button', {
      class: 'chat-copy', title: '复制这条回答', text: '复制',
      onclick: (e) => { e.stopPropagation(); this._copy(getText()); }
    });
  },

  /** 会话头部「复制全部」：问：… \n\n 答：… \n\n --- \n\n */
  copyAll() {
    const c = this.current();
    const msgs = (c && c.msgs) || [];
    if (!msgs.length) { U.toast('当前会话还是空的', 'warn'); return; }
    const body = msgs.map((m) =>
      (m.role === 'user' ? '问：' : '答：') + (m.content || '') + '\n\n').join('---\n\n');
    this._copy(body);
  },

  // ---------- 流式思考字幕（只更新字幕，不结束 pending） ----------
  _startStatus(chatId) {
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }
    this._statusChat = chatId || '';
    this._statusTimer = setInterval(() => { this._pollStatus(); }, 1200);
  },

  async _pollStatus() {
    const chatId = this._statusChat;
    if (!chatId) return;
    let st = null;
    try { st = await API.agentStatus(chatId); } catch (e) { return; }
    if (this._statusChat !== chatId) return;  // 期间已切会话/结束，丢弃本次结果
    const p = this._pend;
    if (p && this.log) {
      const tail = (st && st.think_tail) || '';
      if (tail) {
        p.txt.textContent = tail;
        p.tail.classList.add('on');
        p.tail.scrollTop = p.tail.scrollHeight;   // 只露尾部
      }
      const tool = st && st.tool ? String(st.tool) : '';
      if (tool) {
        p.tool.textContent = '⚙ 正在使用 ' + tool + '…';
        p.tool.classList.add('on');
      } else {
        p.tool.classList.remove('on');
      }
      this.log.scrollTop = this.log.scrollHeight;
    }
    // status 说跑完了但主请求还没回来：只停字幕，pending 由主请求收尾
    if (st && st.running === false) this._stopStatus();
  },

  _stopStatus() {
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }
    this._statusChat = '';
    this._pend = null;
  },

  current() {
    this._load();
    const i = State.chatIdx || 0;
    State.chatIdx = Math.min(i, State.chats.length - 1);
    return State.chats[State.chatIdx];
  },

  // ---------- 构建 ----------
  build() {
    if (this._built) return;
    this._built = true;
    this._load();

    const chips = U.el('div', { class: 'ind-chips', style: 'margin-bottom:2px' },
      ['现在该不该进场？', '关键价位在哪？', '当前设置最大的风险是什么？', '这个策略今天适不适合做？']
        .map((q) => U.el('div', { class: 'chip', text: q, onclick: () => { this.ta.value = q; this.ask(); } })));

    this.ta = U.el('textarea', {
      class: 'ai-input', rows: 3,
      placeholder: '直接问，可连续追问；Enter 发送，Shift+Enter 换行，Esc 关闭'
    });
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.ask(); }
      if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
    });

    this.log = U.el('div', { class: 'chat-log' });
    this.sessSel = U.el('select', { class: 'sess-sel', title: '历史会话' });
    this.sessSel.addEventListener('change', () => {
      this._stopStatus();   // 换会话先清字幕轮询，防串台
      State.chatIdx = parseInt(this.sessSel.value, 10) || 0;
      this.render();
    });
    this.stratSel = U.el('select', { class: 'sess-sel', title: '分析策略' });
    this.stratSel.addEventListener('change', () => {
      const c = this.current();
      c.strategyId = this.stratSel.value;
      this._save();
    });

    const newBtn = U.el('button', {
      class: 'btn sm', text: '＋新会话',
      onclick: () => {
        this._load();
        this._stopStatus();
        const cur = State.chats[State.chatIdx];
        // 当前会话还是空的就复用，避免堆一堆空会话
        if (cur && cur.msgs.length === 0) { this.render(); return; }
        State.chats.push(this._newChat([]));
        State.chatIdx = State.chats.length - 1;
        this._save();
        this.render();
        this.ta.focus();
      }
    });
    const delBtn = U.el('button', {
      class: 'btn sm', text: '删会话',
      onclick: () => {
        this._load();
        if (!window.confirm('删除当前会话？')) return;
        this._stopStatus();
        State.chats.splice(State.chatIdx, 1);
        if (!State.chats.length) State.chats.push(this._newChat([]));
        State.chatIdx = Math.min(State.chatIdx, State.chats.length - 1);
        this._save();
        this.render();
      }
    });

    this.sendBtn = U.el('button', { class: 'btn gold', text: '发送', onclick: () => this.ask() });
    const copyAllBtn = U.el('button', {
      class: 'btn sm', text: '复制全部', title: '复制整个会话（问/答纯文本）',
      onclick: () => this.copyAll()
    });

    const box = U.el('div', { class: 'modal ai-chat-modal' },
      U.el('div', { class: 'modal-head' },
        this.sessSel, newBtn, delBtn, copyAllBtn,
        U.el('div', { class: 'spacer' }),
        U.el('span', { class: 'dim', style: 'font-size:11px;flex:none', text: '策略' }),
        this.stratSel,
        U.el('button', { class: 'btn sm', text: '关闭', onclick: () => this.close() })),
      this.log,
      chips,
      this.ta,
      U.el('div', { class: 'btns' }, this.sendBtn));

    this.modal = U.el('div', { class: 'modal-mask', id: 'aiModal' }, box);
    this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this.close(); });
    document.body.appendChild(this.modal);

    const btn = document.getElementById('askAiBtn');
    if (btn) btn.addEventListener('click', () => this.toggle());

    window.addEventListener('keydown', (e) => {
      if (e.key === 'F2' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        this.toggle();
      } else if (e.key === 'Escape') {
        this.close();
      }
    });
  },

  // ---------- 策略上下文 ----------
  /** 会话选定的策略优先；否则信号页选中；否则当前生效 */
  strategyId() {
    const c = this.current && State.chats ? this.current() : null;
    if (c && c.strategyId) return c.strategyId;
    if (typeof PageSignal !== 'undefined' && PageSignal.activeId) return PageSignal.activeId;
    return (State.settings && State.settings.active_strategy) || '';
  },

  open() {
    this.build();
    this.render();
    this.modal.classList.add('on');
    document.body.classList.add('ai-open');   // 侧栏展开：主内容挤压让位
    this.ta.focus();
  },

  close() {
    if (this.modal) this.modal.classList.remove('on');
    document.body.classList.remove('ai-open');
  },

  toggle() {
    this.build();
    if (this.modal.classList.contains('on')) this.close();
    else this.open();
  },

  // ---------- 发问 ----------
  async ask() {
    if (this._asking) return;
    const q = this.ta.value.trim();
    if (!q) return;

    const c = this.current();
    c.msgs.push({ role: 'user', content: q, t: Date.now() });
    if (c.title === '新会话') c.title = q.slice(0, 16);
    this.ta.value = '';
    this._asking = true;
    this._askChatId = c.id;   // 记录发问会话：切走后不在此会话显示 pending
    this.sendBtn.disabled = true;
    this.sendBtn.textContent = '思考中…';
    this._save();
    this.render(true);
    this._startStatus(c.id);   // 主请求未回期间轮询思考字幕

    const t0 = Date.now();
    try {
      // 本地 pi agent：每会话一个常驻进程，上下文由 pi 自己维持
      const r = await API.agent(q, c.id, State.currentIv || '5m');
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const meta = '—— 工具 ' + (r.steps || []).length + ' 次 · 输入 ' + fmtTok(r.prompt_tokens) +
        ' · 输出 ' + fmtTok(r.completion_tokens) + ' · 耗时 ' + secs + 's';
      c.msgs.push({
        role: 'assistant', content: r.text, t: Date.now(),
        steps: r.steps || [], thinking: r.thinking || '', meta
      });
    } catch (e) {
      c.msgs.push({ role: 'assistant', content: '调用失败：' + e.message, t: Date.now(), err: true });
    } finally {
      this._asking = false;      // 先落 pending 标记，再清字幕轮询，最后重绘
      this._askChatId = '';
      this._stopStatus();
      this.sendBtn.disabled = false;
      this.sendBtn.textContent = '发送';
      this._save();
      this.render();
    }
  },

  // ---------- 渲染 ----------
  render(pending) {
    if (!this.log) return;
    this._load();

    // 会话下拉
    U.clear(this.sessSel);
    State.chats.forEach((c, i) => {
      const d = new Date(c.t);
      const label = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${c.title}`;
      this.sessSel.appendChild(U.el('option', { value: String(i), text: label, selected: i === State.chatIdx }));
    });

    // 策略下拉
    const strategies = (State.settings && State.settings.strategies) || [];
    U.clear(this.stratSel);
    const curStrat = this.strategyId();
    strategies.forEach((st) => {
      this.stratSel.appendChild(U.el('option', {
        value: st.id, text: st.name, selected: st.id === curStrat
      }));
    });

    U.clear(this.log);
    const c = this.current();
    const chat = c.msgs;
    const isPending = (!!pending || this._asking) &&
      (!this._askChatId || c.id === this._askChatId);   // 关窗再开也能接回 pending 气泡

    if (!isPending) this._pend = null;
    if (!chat.length && !isPending) {
      this.log.appendChild(U.el('div', {
        class: 'chat-empty',
        text: State.settings && State.settings.ai && State.settings.ai.api_key
          ? '带策略与行情上下文的多轮对话；历史会话在左上角切换，F2 随时唤起。'
          : 'AI 未配置，请到设置页填写 API 密钥。'
      }));
    }
    for (const m of chat) {
      // 工具过程：默认折叠，点头展开参数与结果
      if (m.steps && m.steps.length) {
        for (const st of m.steps) {
          this.log.appendChild(U.el('details', { class: 'chat-step' },
            U.el('summary', {},
              U.el('b', { text: '⚙ ' + st.name }),
              U.el('span', { class: 'args', text: st.args })),
            U.el('div', { class: 'step-out', text: st.output })));
        }
      }
      const isUser = m.role === 'user';
      const isAi = !isUser && !m.err;   // 错误/系统消息保持纯文本
      const bubble = U.el('div', {
        class: 'chat-msg ' + (isUser ? 'user' : m.err ? 'err' : 'ai')
      });
      if (isAi) {
        // Markdown 已在 U.md 内全量转义，直接塞 HTML
        bubble.appendChild(U.el('div', { class: 'chat-md', html: U.md(m.content) }));
      } else {
        bubble.textContent = m.content;
      }
      if (m.meta) bubble.appendChild(U.el('span', { class: 'meta', text: m.meta }));
      if (isAi && m.thinking) {
        bubble.appendChild(U.el('details', { class: 'ai-reason chat-recall' },
          U.el('summary', { text: '思考回顾' }),
          U.el('pre', { class: 'ai-reason-body', text: m.thinking })));
      }
      if (isAi) bubble.appendChild(this._copyBtn(() => m.content));
      this.log.appendChild(bubble);
    }
    if (isPending) {
      const txt = U.el('span', { class: 'chat-think-txt' });
      const tail = U.el('div', { class: 'chat-think-tail' }, txt,
        U.el('span', { class: 'chat-caret', text: '▍' }));
      const tool = U.el('div', { class: 'chat-think-tool' });
      this.log.appendChild(U.el('div', { class: 'chat-msg ai pending' },
        U.el('div', { class: 'chat-think-h', text: '思考中…' }), tail, tool));
      this._pend = { txt, tail, tool };   // 轮询只更新这几个节点，不结束 pending
    }
    this.log.scrollTop = this.log.scrollHeight;
  }
};

// 启动即建：顶栏按钮与 F2 快捷键在 build 里绑定，必须先 build 才能用
document.addEventListener('DOMContentLoaded', () => AIChat.build());
