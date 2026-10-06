/* 插件 · 金价速览
 * 契约：window.Pages.<目录名> = { key, title, render(view), destroy() }
 * 数据来源：现成 /api/spot（经 U/API 封装），宁缺毋假——无值即 '--'，不用假数据填充。
 * 加新插件：① 建 plugins/<name>/ 两个文件 ② 登记 plugins/index.json ③ node --check 自检
 */
window.Pages = window.Pages || {};

window.Pages['gold-glance'] = {
  key: 'gold-glance',
  title: '金价速览',
  _timer: null,

  render(view) {
    U.clear(view);
    const page = U.el('div', { class: 'page' });

    // 承载实时数据的卡片，刷新时只重绘 body，避免整页闪动
    const statsHost = U.el('div', { class: 'stats' });
    const metaHost = U.el('div', { class: 'note', style: 'margin-top:10px' });
    const body = U.el('div', {}, statsHost, metaHost);
    this._stats = statsHost;
    this._meta = metaHost;

    const refreshBtn = U.el('button', { class: 'btn gold', text: '立即刷新' });
    refreshBtn.addEventListener('click', () => this.load(refreshBtn));

    page.appendChild(U.card('现货速览', body,
      [U.el('span', { class: 'chip', text: '10s 自动刷新' }), refreshBtn]));

    page.appendChild(U.card('说明', U.el('div', {},
      U.el('div', { class: 'note' },
        '数据来自金秤 /api/spot 接口，直接展示上游返回值，不加工、不填充。' +
        '金银比 = 金价 / 银价，由接口一并给出。'),
      U.el('div', { class: 'note', style: 'margin-top:8px' },
        '若上游断更，这里会明示「数据陈旧」并显示最后一次更新时间。'))));

    view.appendChild(page);

    this._render(null, null);           // 先出占位骨架
    this.load(refreshBtn);

    // 自动刷新；destroy 清掉，切页即停
    this._timer = setInterval(() => this.load(null, true), 10000);
  },

  async load(btn, silent = false) {
    if (btn) btn.disabled = true;
    try {
      const sp = await API.spot();
      State.spot = sp;
      this._render(sp, null);
    } catch (e) {
      if (!silent) U.toast('行情读取失败：' + e.message, 'err');
      this._render(null, e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  _render(sp, err) {
    const stats = this._stats;
    if (!stats) return;                 // 视图已卸载
    U.clear(stats);

    if (err || !sp) {
      stats.appendChild(U.stat('现货金价 (XAU/USD)', '--', err || '读取中…', 'dim'));
      stats.appendChild(U.stat('现货银价 (XAG/USD)', '--', '读取中…', 'dim'));
      stats.appendChild(U.stat('金银比', '--', '金价 / 银价', 'dim'));
      U.clear(this._meta);
      this._meta.appendChild(U.el('span', { class: 'down', text: err ? '数据获取失败' : '正在获取…' }));
      return;
    }

    const live = sp.fresh === true;
    stats.appendChild(U.stat('现货金价 (XAU/USD)', U.px(sp.price),
      sp.source ? '来源 ' + sp.source : '', 'mono'));
    stats.appendChild(U.stat('现货银价 (XAG/USD)', U.px(sp.silver),
      sp.silver === null || sp.silver === undefined ? '上游未提供' : '美元/盎司', 'mono'));
    stats.appendChild(U.stat('金银比', sp.gold_silver_ratio === null || sp.gold_silver_ratio === undefined
      ? '--' : U.fx(sp.gold_silver_ratio, 2), '金价 / 银价', 'mono'));

    U.clear(this._meta);
    this._meta.appendChild(U.el('span', { class: live ? 'up' : 'down' },
      live ? '● 数据正常' : '● 数据陈旧'));
    this._meta.appendChild(U.el('span', { style: 'margin-left:12px' },
      '更新时间 ' + (sp.t ? U.full(sp.t) : '--') + (sp.t ? '（' + U.ago(sp.t) + '）' : '')));
    if (sp.prev_close !== null && sp.prev_close !== undefined) {
      const chg = sp.price - sp.prev_close;
      this._meta.appendChild(U.el('span', { class: ' ' + U.cls(chg), style: 'margin-left:12px' },
        '较上次 ' + U.signed(chg)));
    }
  },

  destroy() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._stats = null;
    this._meta = null;
    this._refreshBtn = null;
  }
};
