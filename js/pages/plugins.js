/* 插件中心（内置页，key='plugins'）：模组管理器式一屏两区。
 * 上区：已装插件网格——每插件一张卡（title、desc、name v<version> · author、
 *       状态 chip、行内启停开关、打开 / 导出 / 删除）。
 * 下区：管理工具行——导入 .gsp、刷新、获取插件入口（docs/plugins.md）。
 *
 * 数据来源：/api/plugins/manage（注册表 × 磁盘 manifest 真值：version/author/enabled/min_app/has_error）
 *          + 各插件 plugins/<name>/manifest.json（只取 desc）。
 * 导航归属：本页与所有插件页在顶栏高亮时都归「插件」这一项（js/app.js 的 navItems.keys）。
 * 宁缺勿假：版本/作者缺失显示 —，desc 取不到就不显示；接口失败明说失败并给重试。
 */

const PagePlugins = {
  key: 'plugins',
  title: '插件',
  appVer: '',
  items: [],
  desc: {},        // name → manifest.desc（缓存，避免每次重渲染重复拉）

  render(view) {
    U.clear(view);
    const self = this;
    const page = U.el('div', { class: 'page' });

    const gridHost = U.el('div', {});
    // 无内容时不渲染（空 .note 会留下一只空框）
    const note = U.el('div', { class: 'note pg-note', style: 'display:none' });
    const say = (cls, text) => {
      note.className = 'note pg-note' + (cls ? ' ' + cls : '');
      note.textContent = text || '';
      note.style.display = text ? 'block' : 'none';
    };

    /* 内联 API 绑定：core.js 只读不改；路由形状见 src/main.rs 的 /api/plugins/* */
    const plApi = {
      manage: () => API.req('/api/plugins/manage'),
      install: (gsp) => API.req('/api/plugins/install', { method: 'POST', body: { gsp } }),
      exportOne: (name) => API.req(`/api/plugins/export?name=${encodeURIComponent(name)}`),
      toggle: (name, enabled) =>
        API.req('/api/plugins/toggle', { method: 'POST', body: { name, enabled } }),
      remove: (name) => API.req('/api/plugins/remove', { method: 'POST', body: { name } })
    };
    const verCmp = (typeof cmpVersion === 'function') ? cmpVersion : () => 0;

    const ensureVer = async () => {
      self.appVer = String(window.__gsAppVersion || self.appVer || '');
      if (!self.appVer) {
        try {
          const h = await API.health();
          self.appVer = String((h && h.version) || '');
          window.__gsAppVersion = self.appVer;
        } catch { self.appVer = ''; }   // 拿不到版本就不做 min_app 判定
      }
      return self.appVer;
    };

    /* ---------- 卡片 ---------- */

    const cardFor = (it) => {
      const errs = (window.__gsPluginErrors || {})[it.name];
      const broken = !!errs || !!it.has_error;
      const need = String(it.min_app || '');
      const badVer = !!need && !!self.appVer && verCmp(self.appVer, need) < 0;
      const usable = it.enabled && !broken && !badVer;   // 已加载的才算「可打开」

      const chips = U.el('div', { class: 'pl-row-chips' });
      if (broken) {
        const c = U.el('button', { class: 'chip bad', text: '加载失败', title: '点开看原因' });
        c.addEventListener('click', () => {
          whyEl.style.display = whyEl.style.display === 'none' ? 'block' : 'none';
        });
        chips.appendChild(c);
      } else if (!it.enabled) {
        chips.appendChild(U.el('span', { class: 'chip', style: 'color:var(--fg-3)', text: '已停用' }));
      } else {
        chips.appendChild(U.el('span', { class: 'chip', style: 'color:var(--gold)', text: '启用中' }));
      }
      if (badVer) {
        chips.appendChild(U.el('span', {
          class: 'chip warn', title: `插件要求金秤 v${need}，本机 v${self.appVer || '未知'}`, text: '需 v' + need
        }));
      }

      const why = errs ? `${errs.stage}：${errs.message}` : '插件目录缺失或缺 index.js';
      const whyEl = U.el('div', {
        class: 'note err pl-err', style: 'display:none', text: broken ? why : ''
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
          paint();
        } catch (e) { U.toast('切换失败：' + e.message, 'err'); }
        finally { sw.disabled = false; }
      });

      const openBtn = U.el('button', {
        class: 'btn gold', text: '打开',
        title: usable ? `打开「${it.title}」` : '该插件未加载（已停用 / 加载失败 / 版本不兼容），无法打开'
      });
      openBtn.disabled = !usable;
      openBtn.addEventListener('click', () => App.go(it.name));

      const expBtn = U.el('button', { class: 'btn', text: '导出' });
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

      const delBtn = U.el('button', { class: 'btn', style: 'color:var(--down)', text: '删除' });
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

      const desc = String(self.desc[it.name] || '');
      return U.el('div', { class: 'card pg-card' },
        U.el('div', { class: 'card-body' },
          U.el('div', { class: 'pg-card-head' },
            U.el('span', { style: 'font-weight:600', text: it.title }),
            chips),
          U.el('div', { class: 'pl-sub mono', text: `${it.name} v${it.version || '—'} · ${it.author || '—'}` }),
          desc ? U.el('div', { class: 'pg-desc', text: desc }) : null,
          whyEl,
          U.el('div', { class: 'pg-card-acts' }, sw, openBtn, expBtn, delBtn)));
    };

    const paint = () => {
      U.clear(gridHost);
      const items = self.items;
      if (!items.length) {
        gridHost.appendChild(U.el('div', { class: 'note' },
          '还没有装插件。点「导入 .gsp」装上第一个，或照 docs/plugins.md 手写一个目录' +
          '（建 plugins/<name>/ 两个文件 + 在 plugins/index.json 登记一行）。'));
        return;
      }
      const grid = U.el('div', { class: 'pg-grid' });
      for (const it of items) grid.appendChild(cardFor(it));
      gridHost.appendChild(grid);
    };

    /* ---------- 数据 ---------- */

    /** 卡片 desc 只在缺缓存时补拉；拉到新值就重绘一次 */
    const ensureDesc = async (items) => {
      const missing = items.filter((x) => !(x.name in self.desc));
      if (!missing.length) return false;
      await Promise.all(missing.map(async (x) => {
        try {
          const r = await fetch(`plugins/${x.name}/manifest.json`, { cache: 'no-store' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const m = await r.json();
          self.desc[x.name] = String((m && m.desc) || '');
        } catch { self.desc[x.name] = ''; }   // 取不到就不显示，不编
      }));
      return true;
    };

    const load = async () => {
      U.clear(gridHost);
      gridHost.appendChild(U.el('div', { class: 'note', text: '读取插件清单…' }));
      try {
        await ensureVer();
        const data = await plApi.manage();
        self.items = (data && data.items) || [];
        paint();
        if (await ensureDesc(self.items)) paint();
      } catch (e) {
        U.clear(gridHost);
        gridHost.appendChild(U.el('div', { class: 'note err', text: '插件清单读取失败：' + e.message }));
        const retry = U.el('button', { class: 'btn', text: '重试' });
        retry.addEventListener('click', () => load());
        gridHost.appendChild(U.el('div', { class: 'btns', style: 'margin-top:8px' }, retry));
      }
    };

    /* ---------- 管理工具行：导入 .gsp ---------- */

    const fileIn = U.el('input', { type: 'file', accept: '.gsp,application/json', class: 'pl-file' });
    const impBtn = U.el('button', { class: 'btn gold', text: '导入 .gsp' });
    impBtn.addEventListener('click', () => fileIn.click());
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files && fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      say('', '正在导入 ' + f.name + '…');
      let gsp = null;
      try {
        gsp = JSON.parse(await f.text());
      } catch (e) {
        say('err', '导入失败：不是合法的 .gsp（JSON 解析错误）——' + e.message);
        return;
      }
      if (!gsp || gsp.format !== 'gsp1') {
        say('err', '导入失败：不是金秤插件包（format 须为 gsp1，实际 ' +
          JSON.stringify(gsp && gsp.format) + '）');
        return;
      }
      const man = (gsp.plugin && gsp.plugin.manifest) || {};
      const old = self.items.find((x) => x.name === String(man.name || ''));
      if (old) {
        const nv = man.version ? 'v' + man.version : 'v—';
        if (!confirm(`插件「${old.title}」已存在（v${old.version || '—'} → ${nv}），继续将覆盖升级？\n` +
            `旧目录会先备份为 plugins/${old.name}.bak-<时间戳>，升级失败可回退。`)) {
          say('', '');
          return;
        }
      }
      try {
        const r = await plApi.install(gsp);
        say('ok', `已${r.upgraded ? '覆盖升级' : '安装'}插件 ${r.installed} · ` +
          '硬刷新（Ctrl+Shift+R）后并入顶栏「插件」入口（停用的插件不会被加载）。');
        U.toast(`已${r.upgraded ? '升级' : '安装'} ${r.installed}`, 'ok');
        load();
      } catch (e) {
        say('err', '安装失败：' + e.message);
      }
    });

    const refreshBtn = U.el('button', { class: 'btn', text: '刷新' });
    refreshBtn.addEventListener('click', () => load());

    page.appendChild(U.card('插件中心', U.el('div', {},
      U.el('div', { class: 'note pg-note' },
        '文件夹即安装：一个插件就是 plugins/<name>/ 两个文件（manifest.json + index.js）加 ' +
        'index.json 一行登记，无需重编译。这里管启停开关、.gsp 包导入导出、覆盖升级（先备份旧目录）与删除；' +
        '启停 / 升级 / 删除都硬刷新（Ctrl+Shift+R）后生效。'),
      U.el('div', { class: 'pg-tools' }, impBtn, fileIn, refreshBtn),
      gridHost,
      note,
      U.el('div', { class: 'note pg-note', style: 'margin-top:9px' },
        '获取插件：插件目录、包格式与开发规范见 ',
        U.el('a', {
          href: '../../docs/plugins.md', target: '_blank', rel: 'noopener',
          title: '本地服务未挂载 docs/ 静态目录；本机可直接打开文件 docs/plugins.md，GitHub 上的该链接即仓库文档',
          style: 'color:var(--gold)', text: 'docs/plugins.md'
        }),
        '（GitHub 仓库内可点；本地请用编辑器打开本项目的 docs/plugins.md）。'))));

    view.appendChild(page);
    load();
  },

  destroy() { /* 无轮询、无图表实例，无需清理 */ }
};
