/* 设置页：数据源、AI 接口、外观 */

const PageSettings = {
  key: 'settings',
  title: '设置',

  render(view) {
    // 重渲染前清空视图，否则旧内容会叠加，新页面被盖住
    U.clear(view);
    const page = U.el('div', { class: 'page' });
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

    // ---- 图表 ----
    const hIn = U.numInput(s.chart_height, { step: '20', min: '240', max: '900' });
    const hSave = U.el('button', { class: 'btn', text: '保存图表设置' });
    hSave.addEventListener('click', async () => {
      try {
        await API.saveSettings({
          ...s, chart_height: parseInt(hIn.value) || 460
        });
        await App.reloadSettings();
        U.toast('已保存', 'ok');
        this.render(view);
      } catch (e) { U.toast(e.message, 'err'); }
    });

    page.appendChild(U.el('div', { class: 'g2' },
      U.card('AI 接口', U.el('div', {},
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
        U.el('div', { style: 'margin-top:10px' }, testOut))),

      U.el('div', { style: 'display:flex;flex-direction:column;gap:11px' },
        U.card('图表', U.el('div', {},
          U.field('K 线高度（像素）', hIn),
          U.el('div', { class: 'btns' }, hSave))),

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
          '上方模型/密钥/思考档由金秤注入 pi（--model/--thinking，密钥仅进程环境变量不落盘）。'))
    )));

    // ---- 记忆插件 · respire（与 agent 共用同一套本机 rsrs 记忆库）----
    const memHost = U.el('div', {});
    const memQ = { value: '' };

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
      '关闭只停用入口与注入，数据仍留在 rsrs 库。金秤不启停 rsrs 服务、不代管其数据。');

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

    /** 开启态：状态行（右侧关闭）+ 管理卡（搜索/列表/新增/删除） */
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

      memHost.appendChild(memIntro());
      memHost.appendChild(memStatusRow(p, [offBtn]));
      if (p.error) memHost.appendChild(U.el('div', { class: 'note err', style: 'max-width:660px;margin-bottom:8px', text: p.error }));

      const listHost = U.el('div', {});
      const render = (items) => {
        U.clear(listHost);
        if (!items.length) {
          listHost.appendChild(U.el('div', { class: 'note', text: memQ.value ? '无匹配记忆' : '暂无记忆。存下的内容与 agent 共用，AI 对话时按相关性自动注入上下文。' }));
          return;
        }
        for (const it of items) {
          const del = U.el('button', { class: 'btn', text: '删除', style: 'flex:none;padding:2px 10px;font-size:11px' });
          del.addEventListener('click', async () => {
            try { await API.memDel(it.id); U.toast('已删除'); load(); }
            catch (e) { U.toast(e.message, 'err'); }
          });
          listHost.appendChild(U.el('div', {
            style: 'border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:8px'
          },
            U.el('div', { class: 'row', style: 'align-items:center;gap:8px' },
              U.el('span', { style: 'font-weight:600;flex:1', text: it.title }),
              del),
            it.body ? U.el('div', {
              class: 'note',
              style: 'white-space:pre-wrap;margin:4px 0 0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden',
              text: it.body
            }) : null,
            (it.tags && it.tags.length)
              ? U.el('div', { style: 'margin-top:4px' }, it.tags.map((t) => U.el('span', { class: 'chip', style: 'margin-right:5px', text: t })))
              : null));
        }
      };
      const load = async () => {
        try { render(await API.memList(memQ.value)); }
        catch (e) { U.clear(listHost); listHost.appendChild(U.el('div', { class: 'note err', text: '记忆读取失败：' + e.message })); }
      };

      const search = U.el('input', { type: 'text', placeholder: '搜索记忆（语义召回）…', style: 'margin-bottom:8px' });
      let timer = null;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { memQ.value = search.value.trim(); load(); }, 250);
      });

      const titleIn = U.el('input', { type: 'text', placeholder: '标题（必填），如：我的交易纪律' });
      const bodyIn = U.el('textarea', { rows: '3', placeholder: '正文，如：单笔风险不超过本金 1%；亏损日即停手…', style: 'resize:vertical' });
      const tagsIn = U.el('input', { type: 'text', placeholder: '标签，逗号分隔（可空）' });
      const saveBtn = U.el('button', { class: 'btn gold', text: '存入记忆' });
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          await API.memSave({
            title: titleIn.value.trim(),
            body: bodyIn.value,
            tags: tagsIn.value.split(',').map((t) => t.trim()).filter(Boolean)
          });
          titleIn.value = ''; bodyIn.value = ''; tagsIn.value = '';
          U.toast('已存入 respire 记忆库', 'ok');
          load();
        } catch (e) { U.toast(e.message, 'err'); }
        finally { saveBtn.disabled = false; }
      });

      memHost.appendChild(search);
      memHost.appendChild(listHost);
      memHost.appendChild(U.el('div', { style: 'border-top:1px dashed var(--line);padding-top:10px;margin-top:4px' },
        U.field('标题', titleIn),
        U.field('正文', bodyIn),
        U.field('标签', tagsIn),
        U.el('div', { class: 'btns' }, saveBtn)));
      load();
    };

    /** 未开启态：状态行（右侧开启）+ 说明 + 手动安装指引 */
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

      memHost.appendChild(memIntro());
      memHost.appendChild(memStatusRow(p, [onBtn]));
      if (p.error) memHost.appendChild(U.el('div', { class: 'note err', style: 'max-width:660px;margin-bottom:8px', text: p.error }));
      memHost.appendChild(out);
      if (!p.installed || p.error) memHost.appendChild(memHint());
    };

    page.appendChild(U.card('记忆插件 · respire', memHost));

    // ---- 插件管理 · 文件夹即安装（启停 / .gsp 导入导出 / 覆盖升级 / 删除）----
    // 插件 = plugins/<name>/（manifest.json + index.js）+ index.json 一行登记；后端读写，这里只发指令。
    const plHost = U.el('div', {});
    const plList = U.el('div', {});
    const plNote = U.el('div', { class: 'note pl-note', style: 'margin:8px 0 0' });
    const plState = { items: [] };

    /** 内联 API 绑定：core.js 只读不改，插件管理接口写在这里 */
    const plApi = {
      manage: () => API.req('/api/plugins/manage'),
      install: (gsp) => API.req('/api/plugins/install', { method: 'POST', body: { gsp } }),
      exportOne: (name) => API.req(`/api/plugins/export?name=${encodeURIComponent(name)}`),
      toggle: (name, enabled) =>
        API.req('/api/plugins/toggle', { method: 'POST', body: { name, enabled } }),
      remove: (name) => API.req('/api/plugins/remove', { method: 'POST', body: { name } })
    };

    let plAppVer = String(window.__gsAppVersion || '');
    const plEnsureVer = async () => {
      if (!plAppVer) {
        try {
          const h = await API.health();
          plAppVer = String((h && h.version) || '');
          window.__gsAppVersion = plAppVer;
        } catch (e) { plAppVer = ''; }   // 拿不到版本就不做 min_app 判定
      }
      return plAppVer;
    };
    const verCmp = (typeof cmpVersion === 'function') ? cmpVersion : () => 0;

    const plRender = () => {
      U.clear(plList);
      const items = plState.items;
      if (!items.length) {
        plList.appendChild(U.el('div', { class: 'note' },
          '还没有装插件。点上方「导入 .gsp」装上第一个，或照 docs/plugins.md 手写一个目录' +
          '（建 plugins/<name>/ 两个文件 + 在 plugins/index.json 登记一行）。'));
        return;
      }
      for (const it of items) {
        const errs = (window.__gsPluginErrors || {})[it.name];
        const broken = !!errs || !!it.has_error;
        const need = String(it.min_app || '');
        const badVer = !!need && !!plAppVer && verCmp(plAppVer, need) < 0;

        const chips = U.el('div', { class: 'pl-row-chips' });
        if (broken) {
          const c = U.el('button', { class: 'chip bad', text: '加载失败', title: '点开看原因' });
          c.addEventListener('click', () => {
            errsBox.style.display = errsBox.style.display === 'none' ? 'block' : 'none';
          });
          chips.appendChild(c);
        } else if (!it.enabled) {
          chips.appendChild(U.el('span', { class: 'chip', style: 'color:var(--fg-3)', text: '已停用' }));
        } else {
          chips.appendChild(U.el('span', { class: 'chip', style: 'color:var(--gold)', text: '启用中' }));
        }
        if (badVer) {
          chips.appendChild(U.el('span', {
            class: 'chip warn', title: `插件要求金秤 v${need}，本机 v${plAppVer}`, text: '需 v' + need
          }));
        }

        const why = errs
          ? `${errs.stage}：${errs.message}`
          : '插件目录缺失或缺 index.js';
        const errsBox = U.el('div', {
          class: 'note err pl-err', style: 'display:none;flex-basis:100%', text: broken ? why : ''
        });

        const sw = U.el('button', {
          class: 'pl-sw' + (it.enabled ? ' on' : ''),
          title: it.enabled ? '点击停用' : '点击启用'
        }, U.el('span', { class: 'pl-knob' }));
        sw.addEventListener('click', async () => {
          const next = !it.enabled;
          sw.disabled = true;
          try {
            await plApi.toggle(it.name, next);
            it.enabled = next;
            U.toast(next ? '已启用 · 硬刷新（Ctrl+Shift+R）后生效'
                        : '已停用 · 硬刷新（Ctrl+Shift+R）后该页不再加载', 'ok');
            plRender();
          } catch (e) { U.toast('切换失败：' + e.message, 'err'); }
          finally { sw.disabled = false; }
        });

        const expBtn = U.el('button', { class: 'btn', style: 'padding:2px 10px;font-size:11px', text: '导出' });
        expBtn.addEventListener('click', async () => {
          expBtn.disabled = true;
          try {
            const r = await plApi.exportOne(it.name);
            const gsp = (r && r.gsp) ? r.gsp : r;
            const v = String(it.version || '0').replace(/[^a-zA-Z0-9._-]/g, '_');
            const fname = `${it.name}-v${v}.gsp`;
            const url = URL.createObjectURL(new Blob([JSON.stringify(gsp, null, 2)], { type: 'application/json' }));
            const a = U.el('a', { href: url, download: fname });
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            U.toast('已导出 ' + fname, 'ok');
          } catch (e) { U.toast('导出失败：' + e.message, 'err'); }
          finally { expBtn.disabled = false; }
        });

        const delBtn = U.el('button', {
          class: 'btn', style: 'padding:2px 10px;font-size:11px;color:var(--down)', text: '删除'
        });
        delBtn.addEventListener('click', async () => {
          if (!confirm(`删除插件「${it.title}」？\n将删除插件目录 plugins/${it.name}/，不可恢复。`)) return;
          delBtn.disabled = true;
          try {
            await plApi.remove(it.name);
            U.toast('已删除 ' + it.name + ' · 硬刷新后生效', 'ok');
            load();
          } catch (e) { U.toast('删除失败：' + e.message, 'err'); }
          finally { delBtn.disabled = false; }
        });

        plList.appendChild(U.el('div', { class: 'pl-row' },
          U.el('div', { class: 'pl-row-main' },
            U.el('div', { class: 'pl-row-title' },
              U.el('span', { style: 'font-weight:600', text: it.title }),
              U.el('span', { class: 'pl-sub mono', text: `${it.name} v${it.version || '—'}` }),
              U.el('span', { class: 'pl-sub', text: '· ' + (it.author || '—') })),
            chips),
          U.el('div', { class: 'pl-row-acts' }, sw, expBtn, delBtn),
          errsBox));
      }
    };

    const load = async () => {
      U.clear(plList);
      plList.appendChild(U.el('div', { class: 'note', text: '读取插件清单…' }));
      try {
        await plEnsureVer();
        const data = await plApi.manage();
        plState.items = (data && data.items) || [];
        plRender();
      } catch (e) {
        U.clear(plList);
        plList.appendChild(U.el('div', { class: 'note err', text: '插件清单读取失败：' + e.message }));
        const retry = U.el('button', { class: 'btn', text: '重试' });
        retry.addEventListener('click', () => load());
        plList.appendChild(U.el('div', { class: 'btns', style: 'margin-top:8px' }, retry));
      }
    };

    const plFile = U.el('input', { type: 'file', accept: '.gsp,application/json', class: 'pl-file' });
    const plImp = U.el('button', { class: 'btn gold', text: '导入 .gsp' });
    plImp.addEventListener('click', () => plFile.click());
    plFile.addEventListener('change', async () => {
      const f = plFile.files && plFile.files[0];
      plFile.value = '';
      if (!f) return;
      plNote.className = 'note pl-note';
      plNote.textContent = '正在导入 ' + f.name + '…';
      let gsp = null;
      try {
        gsp = JSON.parse(await f.text());
      } catch (e) {
        plNote.className = 'note pl-note err';
        plNote.textContent = '导入失败：不是合法的 .gsp（JSON 解析错误）——' + e.message;
        return;
      }
      if (!gsp || gsp.format !== 'gsp1') {
        plNote.className = 'note pl-note err';
        plNote.textContent = '导入失败：不是金秤插件包（format 须为 gsp1，实际 ' +
          JSON.stringify(gsp && gsp.format) + '）';
        return;
      }
      const man = (gsp.plugin && gsp.plugin.manifest) || {};
      const old = plState.items.find((x) => x.name === String(man.name || ''));
      if (old) {
        const nv = man.version ? 'v' + man.version : 'v—';
        if (!confirm(`插件「${old.title}」已存在（v${old.version || '—'} → ${nv}），继续将覆盖升级？\n` +
            `旧目录会先备份为 plugins/${old.name}.bak-<时间戳>，升级失败可回退。`)) {
          plNote.textContent = '';
          return;
        }
      }
      try {
        const r = await plApi.install(gsp);
        plNote.className = 'note pl-note ok';
        plNote.textContent = `已${r.upgraded ? '覆盖升级' : '安装'}插件 ${r.installed} · ` +
          '硬刷新（Ctrl+Shift+R）后出现在导航尾部（停用的插件不会被加载）。';
        U.toast(`已${r.upgraded ? '升级' : '安装'} ${r.installed}`, 'ok');
        load();
      } catch (e) {
        plNote.className = 'note pl-note err';
        plNote.textContent = '安装失败：' + e.message;
      }
    });

    plHost.appendChild(U.el('div', { class: 'note', style: 'max-width:660px' },
      '文件夹即安装：一个插件就是 plugins/<name>/ 两个文件（manifest.json + index.js）加 ' +
      'index.json 一行登记，无需重编译。这里管启停开关、.gsp 包导入导出、覆盖升级（先备份旧目录）与删除；' +
      '启停/升级/删除都硬刷新（Ctrl+Shift+R）后生效。插件目录与包格式说明见 docs/plugins.md。'));
    plHost.appendChild(U.el('div', { class: 'btns', style: 'margin:9px 0' }, plImp, plFile));
    plHost.appendChild(plList);
    plHost.appendChild(plNote);
    load();

    page.appendChild(U.card('插件管理 · plugins/', plHost));
    // 状态以服务端为准（settings.memory_enabled + rsrs 检测）；关闭后刷新页面即回未开启态
    (async () => {
      U.clear(memHost);
      memHost.appendChild(U.el('div', { class: 'note', text: '读取插件状态…' }));
      try {
        const p = await API.memPlugin();
        p.enabled ? memRenderOn(p) : memRenderOff(p);
      } catch (e) {
        U.clear(memHost);
        memHost.appendChild(U.el('div', { class: 'note err', text: '插件状态读取失败：' + e.message }));
      }
    })();

    page.appendChild(U.card('数据与隐私', U.el('div', {},
      U.el('div', { class: 'note' },
        '所有持仓、成交记录保存在本机 data/portfolio.json；\n' +
        '所有设置保存在本机 data/settings.json。\n' +
        '不上传任何数据，不接券商，不需要登录。\n\n' +
        '想清空重来：直接删除 data/ 目录下的文件，重启服务即可。'))));

    var _aboutNow = new Date();
    var _aboutDate = _aboutNow.getFullYear() + '-' +
      String(_aboutNow.getMonth() + 1).padStart(2, '0') + '-' +
      String(_aboutNow.getDate()).padStart(2, '0');
    page.appendChild(U.card('关于', U.el('div', { class: 'note' },
      '金秤 v' + '1.0.0' + ' · Rust + Axum 后端，TradingView Lightweight Charts 前端\n' +
      '定位：本地贵金属行情分析与模拟交易工具。不构成投资建议。\n\n' +
      '本产品由 pi agent 自主迭代维护 · ' + _aboutDate)));

    view.appendChild(page);
    this.hosts = {};
  },

  destroy() { this.hosts = null; }
};
