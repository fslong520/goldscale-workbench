/* 设置页：四个 tab —— AI 接口 / 显示 / 记忆与数据 / 关于
 * tab 只切 display、面板常驻，输入中的内容与状态不丢（同 strategy.js 的做法）。
 * 记忆在此页只读：状态行 + 「查看记忆」弹层；记忆的写入归 AI（agent 判重归档），
 * 插件管理整卡已迁到「插件」页（js/pages/plugins.js）。
 */

const PageSettings = {
  key: 'settings',
  title: '设置',
  tab: 'ai',                 // ai | display | memory | about
  _memMask: null,
  _memEsc: null,

  switchTab(k) {
    this.tab = k;
    if (this.tabEls) {
      for (const [key, el] of Object.entries(this.tabEls)) {
        el.classList.toggle('on', key === k);
        if (key === k) el.style.background = 'rgba(216,171,62,.13)';
        else el.style.background = '';
      }
    }
    if (this.panels) {
      for (const [key, el] of Object.entries(this.panels)) el.style.display = key === k ? '' : 'none';
    }
  },

  render(view) {
    // 重渲染前清空视图，否则旧内容会叠加，新页面被盖住
    U.clear(view);
    this.closeMemory();
    const page = U.el('div', { class: 'page' });
    const self = this;
    const s = State.settings;

// ---- AI ----
const keyIn = U.el('input', { type: 'password', placeholder: 'sk-...', value: s.ai.api_key || '' });
const urlIn = U.el('input', { type: 'text', value: s.ai.base_url });
const modelIn = U.el('input', { type: 'text', value: s.ai.model });
const tempIn = U.numInput(s.ai.temperature, { step: '0.1', min: '0', max: '2' });

const budgetSel = U.sel(String(s.ai.context_budget ?? 1), [
  ['0', '省 · 2 万 token'],
  ['1', '标准 · 10 万 token'],
  ['2', '深度 · 40 万 token'],
  ['3', '极限 · 90 万 token']
]);

// 思考三档：deepseek 思考模型专用（探针实测 reasoning_effort / thinking=disabled 生效）
const thinkSel = U.sel(s.ai.thinking || 'low', [
  ['low', '低强度思考（推荐）'],
  ['high', '高强度思考（更慢更费）'],
  ['off', '关闭思考（最快最省）']
]);

const presetBox = U.el('div', { class: 'ind-chips', style: 'margin-bottom:10px' });
API.aiPresets().then((list) => {
  for (const p of list) {
    presetBox.appendChild(U.el('div', {
      class: 'chip', text: p.name,
      title: `${p.url}  ·  ${p.model}`,
      onclick: () => {
        urlIn.value = p.url;
        modelIn.value = p.model;
        U.toast(`已填入 ${p.name}，模型 ${p.model}`);
      }
    }));
  }
}).catch(() => {});

const aiSave = U.el('button', { class: 'btn gold', text: '保存 AI 设置' });
const saveAI = async () => {
  await API.saveSettings({
    ...State.settings,
    ai: {
      api_key: keyIn.value.trim(),
      base_url: urlIn.value.trim() || 'https://api.deepseek.com',
      model: modelIn.value.trim() || 'deepseek-flash',
      temperature: parseFloat(tempIn.value) || 0.3,
      context_budget: parseInt(budgetSel.value) || 1,
      thinking: thinkSel.value
    }
  });
  await App.reloadSettings();
};

aiSave.addEventListener('click', async () => {
  aiSave.disabled = true;
  try {
    await saveAI();
    U.toast('AI 设置已保存', 'ok');
  } catch (e) { U.toast(e.message, 'err'); }
  finally { aiSave.disabled = false; }
});

const testBtn = U.el('button', { class: 'btn', text: '测试连通' });
const testOut = U.el('div', { class: 'note' });
testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  testOut.className = 'note';
  testOut.textContent = '测试中，通常 5-30 秒…';
  try {
    await saveAI();
    const r = await API.ai('用一句话说明当前黄金走势', State.settings.active_strategy);
    testOut.className = 'note ok';
    testOut.textContent = '连通成功\n\n' + r.text.slice(0, 400) +
      '\n\n—— 上下文 ' + r.context_tokens + ' token，耗时输入 ' +
      r.prompt_tokens + ' / 输出 ' + r.completion_tokens;
  } catch (e) {
    testOut.className = 'note err';
    testOut.textContent = '测试失败：' + e.message;
  } finally { testBtn.disabled = false; }
});

const keyTip = U.el('div', { class: 'note', style: 'margin-bottom:10px' },
  '密钥只保存在本机 data/settings.json，请求由本地 Rust 服务发出，不经过浏览器。\n' +
  '点上方服务商可一键填入地址与模型名。DeepSeek 在 2026-07-24 下线了 ' +
  'deepseek-chat 与 deepseek-reasoner，当前可用 deepseek-flash 与 deepseek-v4-pro。');

// ---- 显示 ----
const hIn = U.numInput(s.chart_height, { step: '20', min: '240', max: '900' });
const hSave = U.el('button', { class: 'btn', text: '保存图表设置' });
hSave.addEventListener('click', async () => {
  try {
    await API.saveSettings({
      ...State.settings, chart_height: parseInt(hIn.value) || 460
    });
    await App.reloadSettings();
    U.toast('已保存', 'ok');
    this.render(view);
  } catch (e) { U.toast(e.message, 'err'); }
});

// ---- 记忆与数据（只读：读在弹层，写归 AI）----
const memHost = U.el('div', {});

/** 状态徽章：文字 + 可选色点 */
const memChip = (text, color, dot) => U.el('span', {
  class: 'chip', style: `cursor:default;color:${color}`
}, dot
  ? [U.el('span', {
      style: `display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;vertical-align:middle;background:${dot}`
    }), text]
  : text);

/** 状态行：CLI / Runtime / 开关 三枚徽章，右侧放主操作 */
const memStatusRow = (p, actions) => U.el('div', {
  style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px'
},
  memChip(p.installed ? `CLI ${p.version ? 'v' + p.version : '已装'}` : 'CLI 未安装',
    p.installed ? 'var(--fg-2)' : 'var(--warn)'),
  memChip(p.runtime_ok ? 'Runtime 在线' : 'Runtime 离线',
    p.runtime_ok ? 'var(--up)' : 'var(--warn)', p.runtime_ok ? 'var(--up)' : 'var(--warn)'),
  memChip(p.enabled ? '记忆已开启' : '记忆已关闭',
    p.enabled ? 'var(--gold)' : 'var(--fg-3)', p.enabled ? 'var(--gold)' : 'var(--fg-3)'),
  actions ? U.el('div', { style: 'margin-left:auto;display:flex;gap:8px' }, actions) : null);

/** 卡片说明：两态共用 */
const memIntro = () => U.el('div', {
  class: 'note', style: 'max-width:660px;margin-bottom:10px'
}, '与 agent 共用同一套本机记忆库（树形判重、云同步）：开启后金秤的记忆读写全部交给本机 rsrs CLI；' +
  '关闭只停用入口与注入，数据仍留在 rsrs 库。金秤不启停 rsrs 服务、不代管其数据。\n' +
  '记忆由 AI 自动读写：对话中按相关性召回注入，得出的结论由 agent 判重后归档；此处只提供查看。');

/** 手动安装指引：自动装不上时给用户照抄 */
const memHint = () => {
  const cmd = 'npm i -g --prefix ~/.local @rsrsai/cli@latest';
  const box = U.el('div', {
    class: 'note',
    style: 'border:1px dashed var(--line);border-radius:8px;padding:8px 10px;margin:8px 0;white-space:pre-wrap;user-select:all'
  }, '本机未装 rsrs 时，可手动执行（免 sudo）：\n' + cmd + '\n或：sudo npm i -g @rsrsai/cli@latest');
  const cp = U.el('button', { class: 'btn', text: '复制安装命令', style: 'margin-top:6px' });
  cp.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(cmd); U.toast('已复制安装命令', 'ok'); }
    catch { U.toast('复制失败，请手动选中命令文本', 'err'); }
  });
  box.appendChild(cp);
  return box;
};

/** 开态：状态行（右侧关闭）+ 说明 + 「查看记忆」（只读弹层） */
const memRenderOn = (p) => {
  U.clear(memHost);

  const offBtn = U.el('button', { class: 'btn', text: '关闭记忆' });
  offBtn.addEventListener('click', async () => {
    if (!confirm('关闭记忆插件？\n只关闭 agent 注入与金秤的记忆入口，已存数据仍留在本机 respire 记忆库。')) return;
    offBtn.disabled = true;
    try {
      const r = await API.memDisable();
      await App.reloadSettings();
      U.toast('已关闭，数据保留在 respire 库', 'ok');
      memRenderOff(r);
    } catch (e) { U.toast(e.message, 'err'); offBtn.disabled = false; }
  });

  const viewBtn = U.el('button', { class: 'btn gold', text: '查看记忆' });
  viewBtn.addEventListener('click', () => self.openMemory());

  memHost.appendChild(memIntro());
  memHost.appendChild(U.el('div', { class: 'note', style: 'margin-bottom:10px' },
    '已开启 · AI 自动读写（判重归档由 agent 完成）。'));
  memHost.appendChild(memStatusRow(p, [viewBtn, offBtn]));
  if (p.error) memHost.appendChild(U.el('div', { class: 'note err', style: 'max-width:660px;margin-bottom:8px', text: p.error }));
};

/** 未开启态：状态行（右侧开启）+ 说明 + 手动安装指引；开启是配置，不是写记忆 */
const memRenderOff = (p) => {
  U.clear(memHost);

  const onBtn = U.el('button', { class: 'btn gold', text: p.installed ? '开启记忆' : '开启记忆（自动安装 rsrs）' });
  const out = U.el('div', { class: 'note', style: 'display:none;margin-top:10px' });
  onBtn.addEventListener('click', async () => {
    onBtn.disabled = true;
    onBtn.textContent = '正在检测/安装…';
    out.style.display = 'block';
    out.className = 'note';
    out.textContent = '正在检测本机 rsrs…（首次安装需下载约 64MB，请稍候）';
    try {
      const r = await API.memEnable();
      await App.reloadSettings();
      if (r.enabled) { U.toast('记忆插件已开启', 'ok'); memRenderOn(r); }
      else { U.toast(r.error || '开启失败', 'err'); memRenderOff(r); }
    } catch (e) {
      out.className = 'note err';
      out.textContent = '开启失败：' + e.message;
      onBtn.disabled = false;
      onBtn.textContent = '重试开启';
    }
  });

  const viewBtn = U.el('button', { class: 'btn', text: '查看记忆' });
  viewBtn.addEventListener('click', () => self.openMemory());

  memHost.appendChild(memIntro());
  memHost.appendChild(memStatusRow(p, [viewBtn, onBtn]));
  if (p.error) memHost.appendChild(U.el('div', { class: 'note err', style: 'max-width:660px;margin-bottom:8px', text: p.error }));
  memHost.appendChild(out);
  if (!p.installed || p.error) memHost.appendChild(memHint());
};

// ---- tab 头与四个常驻面板：切 tab 只换 display，输入中的内容不丢 ----
const mkTab = (k, label) => U.el('div', {
  class: 'iv-tab' + (this.tab === k ? ' on' : ''),
  style: 'font-size:13px;padding:5px 14px;letter-spacing:.4px' +
    (this.tab === k ? ';background:rgba(216,171,62,.13)' : ''),
  text: label,
  onclick: () => self.switchTab(k)
});
this.tabEls = {
  ai: mkTab('ai', 'AI 接口'),
  display: mkTab('display', '显示'),
  memory: mkTab('memory', '记忆与数据'),
  about: mkTab('about', '关于')
};
page.appendChild(U.el('div', {
  class: 'row',
  style: 'border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:12px'
}, U.el('div', { class: 'iv-tabs', style: 'gap:4px' },
  this.tabEls.ai, this.tabEls.display, this.tabEls.memory, this.tabEls.about)));

// ① AI 接口
const aiPanel = U.el('div', {}, U.card('AI 接口', U.el('div', {},
  keyTip,
  U.el('span', { style: 'display:block;margin-bottom:4px;font-size:11px;color:var(--fg-3)',
    text: '服务商预设' }),
  presetBox,
  U.field('API 密钥', keyIn),
  U.field('接口地址', urlIn),
  U.el('div', { class: 'g3' },
    U.field('模型', modelIn),
    U.field('温度', tempIn),
    U.field('上下文预算', budgetSel)),
  U.el('div', { class: 'g2' },
    U.field('思考模式', thinkSel),
    U.el('div', { class: 'note', style: 'align-self:center' },
      '思考与回答分开展示；关闭思考最快最省，低强度兼顾质量。')),
  U.el('div', { class: 'btns' }, aiSave, testBtn),
  U.el('div', { style: 'margin-top:10px' }, testOut))));

// ② 显示
const displayPanel = U.el('div', {}, U.card('图表', U.el('div', {},
  U.field('K 线高度（像素）', hIn),
  U.el('div', { class: 'btns' }, hSave))));

// ③ 记忆与数据
const memoryPanel = U.el('div', {},
  U.card('记忆 · respire（只读）', memHost),
  U.card('数据与隐私', U.el('div', {},
    U.el('div', { class: 'note' },
      '所有持仓、成交记录保存在本机 data/portfolio.json；\n' +
      '所有设置保存在本机 data/settings.json。\n' +
      '不上传任何数据，不接券商，不需要登录。\n\n' +
      '想清空重来：直接删除 data/ 目录下的文件，重启服务即可。'))));

// ④ 关于
const _aboutNow = new Date();
const _aboutDate = _aboutNow.getFullYear() + '-' +
  String(_aboutNow.getMonth() + 1).padStart(2, '0') + '-' +
  String(_aboutNow.getDate()).padStart(2, '0');
const aboutPanel = U.el('div', {},
  U.card('数据源', U.el('div', { class: 'note' },
    'K 线：xaus.com（多周期 OHLC）\n' +
    '现价：xaus.com → gold-api.com → standardbullion.com 依次降级\n' +
    '三个源全部不可用时，有旧缓存就显示旧数据并明确标注，\n' +
    '没有缓存则直接报错——绝不显示模拟或编造的数据。')),
  U.card('Agent（pi）', U.el('div', { class: 'note' },
    'Agent 运行时是 pi（项目内 agent/pi），每个对话会话一个常驻进程，上下文、技能、MCP 全由 pi 自主调度。\n' +
    '家目录 ~/.goldscale/：skills/ 自有技能库（已链入 pi 扫描的 ~/.agents/skills/），config.json 备用。\n' +
    '全局指令：~/AGENT.md（项目根 AGENTS.md 已软链指向它，pi 启动即读，改完即生效）。\n' +
    '记忆：pi 经 bash 调用 rsrs 读写本机记忆库；MCP 服务器用 pi 自带命令管理（pi mcp list）。\n' +
    '上方模型/密钥/思考档由金秤注入 pi（--model/--thinking，密钥仅进程环境变量不落盘）。')),
  U.card('关于', U.el('div', { class: 'note' },
    '金秤 v' + '1.0.0' + ' · Rust + Axum 后端，TradingView Lightweight Charts 前端\n' +
    '定位：本地贵金属行情分析与模拟交易工具。不构成投资建议。\n\n' +
    '本产品由 pi agent 自主迭代维护 · ' + _aboutDate)));

this.panels = {
  ai: aiPanel, display: displayPanel, memory: memoryPanel, about: aboutPanel
};
page.appendChild(aiPanel);
page.appendChild(displayPanel);
page.appendChild(memoryPanel);
page.appendChild(aboutPanel);
this.switchTab(this.tab || 'ai');

// 状态以服务端为准（settings.memory_enabled + rsrs 检测）
(async () => {
  U.clear(memHost);
  memHost.appendChild(U.el('div', { class: 'note', text: '读取记忆状态…' }));
  try {
    const p = await API.memPlugin();
    p.enabled ? memRenderOn(p) : memRenderOff(p);
  } catch (e) {
    U.clear(memHost);
    memHost.appendChild(U.el('div', { class: 'note err', text: '记忆状态读取失败：' + e.message }));
  }
})();

    view.appendChild(page);
    this.hosts = {};
  },

  /* ---------- 记忆只读弹层 ----------
   * 纯读：搜索（防抖 300ms → /api/memory?q=）+ 条目展开正文。
   * 无新增、无删除、无编辑——写入归 AI（agent 判重归档）。
   * 未开启态：提示 + 开启按钮（开启是配置，不是写记忆）。
   */
  openMemory() {
    if (document.getElementById('memModal')) return;   // 不叠第二个
    const self = this;
    const listHost = U.el('div', { class: 'mem-list' });

    const close = U.el('button', { class: 'btn', text: '关闭' });
    close.addEventListener('click', () => self.closeMemory());

    const search = U.el('input', {
      type: 'text', placeholder: '搜索记忆（语义召回）…', style: 'margin-bottom:8px'
    });

    const box = U.el('div', { class: 'mem-modal' },
      U.el('div', { class: 'modal-head' },
        U.el('span', { text: '记忆（只读）' }), U.el('div', { class: 'spacer', style: 'flex:1' }), close),
      search,
      listHost,
      U.el('div', { class: 'note', style: 'margin-top:8px;font-size:11px' },
        '这里只读：新增、判重、归档由 AI 在对话中完成；与 agent 共用同一套本机 rsrs 记忆库。'));

    const mask = U.el('div', { class: 'modal-mask on', id: 'memModal' }, box);
    mask.addEventListener('click', (e) => { if (e.target === mask) self.closeMemory(); });
    this._memEsc = (e) => { if (e.key === 'Escape') self.closeMemory(); };
    document.addEventListener('keydown', this._memEsc);
    document.body.appendChild(mask);
    this._memMask = mask;

    /** updated 兼容：秒/毫秒皆可，缺字段就不显示时间 */
    const stamp = (it) => {
      const n = Number(it.updated || it.updated_at || it.modified_at || 0);
      if (!isFinite(n) || n <= 0) return '';
      return U.mdhm(n > 1e11 ? Math.floor(n / 1000) : n);
    };

    const render = (items) => {
      U.clear(listHost);
      if (!items.length) {
        listHost.appendChild(U.el('div', { class: 'note' },
          search.value.trim() ? '无匹配记忆' : '暂无记忆。存下的内容与 agent 共用，AI 对话时按相关性自动注入上下文。'));
        return;
      }
      for (const it of items) {
        const body = U.el('div', {
          class: 'mem-body', style: 'display:none', text: it.body || '（无正文）'
        });
        const row = U.el('div', { class: 'mem-item' },
          U.el('div', { class: 'row', style: 'align-items:center;gap:8px' },
            U.el('span', { style: 'font-weight:600;flex:1', text: it.title || '(无标题)' }),
            stamp(it) ? U.el('span', { class: 'dim mono', style: 'font-size:11px', text: stamp(it) }) : null),
          (it.tags && it.tags.length)
            ? U.el('div', { style: 'margin-top:4px' },
                it.tags.map((t) => U.el('span', { class: 'chip', style: 'margin-right:5px;cursor:default', text: String(t) })))
            : null,
          body);
        row.addEventListener('click', () => {
          body.style.display = body.style.display === 'none' ? 'block' : 'none';
        });
        listHost.appendChild(row);
      }
    };

    const load = async (q) => {
      try {
        render(await API.memList(q || ''));
      } catch (e) {
        U.clear(listHost);
        listHost.appendChild(U.el('div', { class: 'note err', text: '记忆读取失败：' + e.message }));
      }
    };

    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => load(search.value.trim()), 300);
    });

    // 先看开关：关着就只给提示 + 开启按钮，不发查询
    (async () => {
      U.clear(listHost);
      listHost.appendChild(U.el('div', { class: 'note', text: '读取记忆状态…' }));
      let p = null;
      try { p = await API.memPlugin(); }
      catch (e) {
        U.clear(listHost);
        listHost.appendChild(U.el('div', { class: 'note err', text: '记忆状态读取失败：' + e.message }));
        return;
      }
      if (p.enabled) {
        await load('');
        return;
      }
      U.clear(listHost);
      search.style.display = 'none';
      const onBtn = U.el('button', { class: 'btn gold', text: p.installed ? '开启记忆' : '开启记忆（自动安装 rsrs）' });
      const out = U.el('div', { class: 'note', style: 'margin-top:8px' });
      onBtn.addEventListener('click', async () => {
        onBtn.disabled = true;
        onBtn.textContent = '正在检测/安装…';
        out.className = 'note';
        out.textContent = '正在检测本机 rsrs…（首次安装需下载约 64MB，请稍候）';
        try {
          const r = await API.memEnable();
          await App.reloadSettings();
          if (r.enabled) {
            U.toast('记忆插件已开启', 'ok');
            self.closeMemory();
            self.render(U.clear(document.getElementById('view')));
          } else {
            U.toast(r.error || '开启失败', 'err');
            onBtn.disabled = false;
            onBtn.textContent = '重试开启';
          }
        } catch (e) {
          out.className = 'note err';
          out.textContent = '开启失败：' + e.message;
          onBtn.disabled = false;
          onBtn.textContent = '重试开启';
        }
      });
      listHost.appendChild(U.el('div', { class: 'note' },
        '记忆插件未开启，暂时没有可查看的记忆。开启后 AI 的读写与这里的查看共用同一套本机记忆库。'));
      listHost.appendChild(U.el('div', { style: 'margin-top:8px' }, onBtn));
      if (!p.installed) listHost.appendChild(memHint());
      listHost.appendChild(out);
    })();
  },

  closeMemory() {
    if (this._memEsc) { document.removeEventListener('keydown', this._memEsc); this._memEsc = null; }
    if (this._memMask) { this._memMask.remove(); this._memMask = null; }
    const old = document.getElementById('memModal');
    if (old) old.remove();
  },

  destroy() {
    this.closeMemory();
    this.hosts = null;
  }
};
