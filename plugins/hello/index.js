/* 示例插件 · 活模板
 * 契约：window.Pages.<目录名> = { key, title, render(view), destroy() }
 * 本文件由 js/app.js 在启动时 fetch 后内联执行；单个插件抛错只丢本页，不动内置页。
 * 加新插件：① 建 plugins/<name>/ 两个文件 ② 登记 plugins/index.json ③ node --check 自检
 */
window.Pages = window.Pages || {};

window.Pages.hello = {
  key: 'hello',
  title: '示例插件',
  _timer: null,

  render(view) {
    // 与内置页同构：重渲染前先清空视图
    U.clear(view);
    const page = U.el('div', { class: 'page' });
    const clock = U.el('span', { class: 'mono', text: this.stamp() });

    /* 身份行：全部为运行时真实数据（PAGES 由 app.js 维护） */
    const has = typeof PAGES !== 'undefined';
    const idx = has ? PAGES.indexOf(window.Pages.hello) + 1 : 0;
    page.appendChild(U.el('div', { class: 'stats' },
      U.stat('插件名', 'hello', '目录 plugins/hello/'),
      U.stat('注册来源', 'index.json', 'order 90'),
      U.stat('导航位置', has ? `${idx} / ${PAGES.length}` : '--', '排在内置页之后'),
      U.stat('已加载插件', has ? String(PAGES.filter((p) => p.plugin).length) : '--', '本次会话')));

    /* 主卡：这是什么 + 两份文件的最小骨架 */
    page.appendChild(U.card('插件已就位', U.el('div', {},
      U.el('div', { class: 'note ok' },
        '本页不是内置页面：js/app.js 启动时读 plugins/index.json，再取本目录的 manifest.json 与 index.js，' +
        '注册进导航与路由。新建一个目录 = 产品多一个页面，无需重编译、无需改核心代码。'),
      U.el('div', { class: 'row', style: 'margin-top:10px' },
        U.el('span', { class: 'chip', text: 'plugins/hello/manifest.json' }),
        U.el('span', { class: 'chip', text: 'plugins/hello/index.js' })),
      U.el('div', { class: 'g2', style: 'margin-top:9px' },
        U.el('div', { class: 'chat-md', html: U.md(
          '```json\n' +
          '{ "name": "hello", "title": "示例插件",\n' +
          '  "order": 90, "desc": "一句话" }\n' +
          '```') }),
        U.el('div', { class: 'chat-md', html: U.md(
          '```js\n' +
          'window.Pages.hello = {\n' +
          "  key: 'hello', title: '示例插件',\n" +
          '  render(view) { … }, destroy() { … }\n' +
          '};\n' +
          '```') })))));

    /* 操作单：给 agent 的三步 */
    page.appendChild(U.card('加插件三步（agent 照做）', U.el('div', {},
      U.el('ol', { style: 'margin:0;padding-left:20px;font-size:12px;line-height:1.9;color:var(--fg-2)' },
        U.el('li', {}, '新建 ', U.el('span', { class: 'mono', text: 'plugins/<name>/' }),
          '，写 manifest.json 与 index.js（key 一律等于目录名）'),
        U.el('li', { text: 'index.js 注册 window.Pages.<name> = { key, title, render(view), destroy() }' }),
        U.el('li', {}, '在 ', U.el('span', { class: 'mono', text: 'plugins/index.json' }),
          ' 登记 ', U.el('span', { class: 'mono', text: '{ "name": "<name>", "order": 100 }' }))),
      U.el('div', { class: 'note', style: 'margin-top:10px' },
        '自检：node --check plugins/<name>/index.js；页面硬刷新（Ctrl+Shift+R）后看导航尾部。' +
        'order 只决定插件之间的先后，插件永远排在内置页之后。'))));

    /* 时间 + 容错并排 */
    const btn = U.el('button', { class: 'btn gold', text: '点我一下' });
    btn.addEventListener('click', () => {
      U.toast('插件 hello 正常工作 · ' + this.stamp(), 'ok');
    });

    page.appendChild(U.el('div', { class: 'g2' },
      U.card('当前时间', U.el('div', {},
        U.el('div', { class: 'row' },
          U.el('span', { class: 'dim', text: '浏览器本地时间' }), clock),
        U.el('div', { class: 'note', style: 'margin-top:10px' },
          '切页时 destroy() 会清掉走秒计时器；再点回来重新计时，导航与路由行为与内置页一致。'),
        U.el('div', { class: 'btns', style: 'margin-top:10px' }, btn))),
      U.card('插件层容错（硬约束）', U.el('div', {},
        U.el('ul', { style: 'margin:0;padding-left:18px;font-size:12px;line-height:1.85;color:var(--fg-2)' },
          U.el('li', { text: '注册表读不到 → 本次不加载插件，启动流程照常' }),
          U.el('li', { text: '清单缺失/非法 → 回退注册表信息或跳过该插件' }),
          U.el('li', { text: '脚本语法或运行错 → 只丢这一个插件，console.warn 留痕' }),
          U.el('li', { text: '内置页与 App.go 路由不受插件层影响' }))))));

    view.appendChild(page);

    // 每秒走秒；destroy 清掉，可验证切页清理确实执行
    this._timer = setInterval(() => { clock.textContent = this.stamp(); }, 1000);
  },

  stamp() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },

  destroy() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
};
