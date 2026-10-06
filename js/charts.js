/* 图表封装：K 线主图 + 指标叠加 + RSI/MACD 副图 + 画线标记 */

const Charts = {
  _cache: new Map(),

  // ---------- 画线系统 ----------
  // 存储：State.drawings[interval] = [{type:'h',price} | {type:'t',t1,p1,t2,p2}]
  // 水平线用原生 createPriceLine（价格轴带标签），趋势线用 SVG 叠加随视口重算坐标
  _dwgStore() {
    if (!State.drawings) {
      try { State.drawings = JSON.parse(localStorage.getItem('gs_drawings_v1')) || {}; }
      catch { State.drawings = {}; }
    }
    return State.drawings;
  },

  _dwgSave() {
    try { localStorage.setItem('gs_drawings_v1', JSON.stringify(this._dwgStore())); } catch { /* 忽略 */ }
  },

  /** 给图表挂画线交互与渲染 */
  _setupDrawings(chart, candle, host, iv) {
    const store = this._dwgStore();
    const list = () => (store[iv] = store[iv] || []);

    // 水平线的 PriceLine 对象（用于移除重建）
    let plines = [];
    // 趋势线 SVG 层
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:4');
    host.appendChild(svg);

    const redraw = () => {
      // 水平线：先移除旧的再重建
      plines.forEach((p) => { try { candle.removePriceLine(p); } catch { /* 已移除 */ } });
      plines = [];
      // 趋势线：按当前视口重算坐标
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const ts = chart.timeScale();
      for (const d of list()) {
        if (d.type === 'h') {
          plines.push(candle.createPriceLine({
            price: d.price,
            color: '#f0a020',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: '标记'
          }));
        } else if (d.type === 't') {
          const x1 = ts.timeToCoordinate(d.t1);
          const x2 = ts.timeToCoordinate(d.t2);
          const y1 = candle.priceToCoordinate(d.p1);
          const y2 = candle.priceToCoordinate(d.p2);
          if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
          const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          ln.setAttribute('x1', x1); ln.setAttribute('y1', y1);
          ln.setAttribute('x2', x2); ln.setAttribute('y2', y2);
          ln.setAttribute('stroke', '#4a9eff');
          ln.setAttribute('stroke-width', '1.5');
          svg.appendChild(ln);
        }
      }
    };

    // 视口变化（拖动/缩放）时趋势线跟着走
    chart.timeScale().subscribeVisibleTimeRangeChange(redraw);
    chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);

    // 点击画线：水平线单击即画；趋势线两点成线
    let pendingT = null;
    chart.subscribeClick((p) => {
      const mode = State.drawMode;
      if (!mode || !p.point || !p.time) return;
      const price = candle.coordinateToPrice(p.point.y);
      if (price == null) return;
      if (mode === 'h') {
        list().push({ type: 'h', price: Math.round(price * 100) / 100 });
      } else if (mode === 't') {
        if (!pendingT) {
          pendingT = { t: p.time, p: price };
          return;
        }
        if (p.time === pendingT.t) return;
        list().push({
          type: 't',
          t1: pendingT.t, p1: Math.round(pendingT.p * 100) / 100,
          t2: p.time, p2: Math.round(price * 100) / 100
        });
        pendingT = null;
      } else {
        return;
      }
      this._dwgSave();
      redraw();
      if (typeof PageWatch !== 'undefined' && PageWatch.syncDrawBtns) PageWatch.syncDrawBtns();
    });

    redraw();
  },

  /** 撤销当前周期最后一笔 / 清除全部 */
  undoDraw(iv) {
    const s = this._dwgStore();
    if (s[iv] && s[iv].length) { s[iv].pop(); this._dwgSave(); }
  },
  clearDraw(iv) {
    this._dwgStore()[iv] = [];
    this._dwgSave();
  },

  /**
   * 渲染 K 线主图
   * @param {HTMLElement} host 容器
   * @param {object} barData {bars, times}
   * @param {object} ind 指标序列
   * @param {Set<string>} onIndicators 已开启的指标
   */
  main(host, barData, ind, onIndicators) {
    U.clear(host);

    if (!barData || !barData.bars || !barData.bars.length) {
      host.appendChild(U.el('div', { class: 'chart-loading loading-dots', text: '加载行情' }));
      return;
    }

    const chart = LightweightCharts.createChart(host, {
      layout: {
        background: { type: 'solid', color: '#141922' },
        textColor: '#97a5b5',
        fontSize: 11,
        fontFamily: 'ui-monospace, monospace'
      },
      grid: {
        vertLines: { color: '#1e2632' },
        horzLines: { color: '#1e2632' }
      },
      rightPriceScale: { borderColor: '#2a3441', scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: {
        borderColor: '#2a3441',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: '#4a9eff', width: 1, style: 2, labelBackgroundColor: '#1f5fa8' },
        horzLine: { color: '#4a9eff', width: 1, style: 2, labelBackgroundColor: '#1f5fa8' }
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true }
    });

    const bars = barData.bars;
    const times = barData.times || bars.map((b) => b.t);

    // 价格格式：黄金两位小数
    const priceFmt = { type: 'price', precision: 2, minMove: 0.01 };

    // K 线
    const candle = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      priceFormat: priceFmt
    });
    candle.setData(bars.map((b, i) => ({
      time: times[i],
      open: b.o, high: b.h, low: b.l, close: b.c
    })));

    // 指标线
    const line = (data, color, width = 1) => chart.addLineSeries({
      color, lineWidth: width, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false
    });

    const overlay = [];
    if (onIndicators.has('ema20') && ind?.ema20) {
      overlay.push(['EMA20', line(ind.ema20, '#d8ab3e', 2)]);
    }
    if (onIndicators.has('ema50') && ind?.ema50) {
      overlay.push(['EMA50', line(ind.ema50, '#4a9eff', 2)]);
    }
    if (onIndicators.has('boll') && ind?.boll_up) {
      overlay.push(['BOLL上', line(ind.boll_up, '#7a6ba8', 1)]);
      overlay.push(['BOLL中', line(ind.boll_mid, '#5d5480', 1)]);
      overlay.push(['BOLL下', line(ind.boll_dn, '#7a6ba8', 1)]);
    }

    overlay.forEach(([name, s]) => {
      // 逐序列取数
      const key = name === 'EMA20' ? 'ema20'
        : name === 'EMA50' ? 'ema50'
        : name === 'BOLL上' ? 'boll_up'
        : name === 'BOLL中' ? 'boll_mid' : 'boll_dn';
      const arr = ind[key] || [];
      const data = [];
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] !== null && arr[i] !== undefined) {
          data.push({ time: times[i], value: arr[i] });
        }
      }
      s.setData(data);
    });

    // 悬停读数
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) return;
      const i = times.indexOf(param.time);
      if (i < 0) return;
      const b = bars[i];
      const parts = [
        `<span class="dim">${U.full(b.t)}</span>`,
        `开 <b>${U.px(b.o)}</b>`,
        `高 <b>${U.px(b.h)}</b>`,
        `低 <b>${U.px(b.l)}</b>`,
        `收 <b class="${U.cls(b.c - b.o)}">${U.px(b.c)}</b>`
      ];
      if (onIndicators.has('rsi') && ind?.rsi14?.[i] != null) {
        parts.push(`RSI <b>${U.fx(ind.rsi14[i], 1)}</b>`);
      }
      let el = host.querySelector('.chart-readout');
      if (!el) {
        el = U.el('div', { class: 'chart-readout' });
        el.style.cssText =
          'position:absolute;top:6px;left:10px;font-family:var(--mono);' +
          'font-size:11px;pointer-events:none;background:rgba(20,25,34,.9);' +
          'padding:3px 7px;border-radius:4px;color:#e8eef5;white-space:nowrap;z-index:5';
        host.appendChild(el);
      }
      el.innerHTML = parts.join('&nbsp;');
    });

    chart.timeScale().fitContent();
    // 初始显示最近约 150 根，左侧更长历史可拖回看；
    // 用户拖过的位置按周期记住，30 秒自动刷新重建图表时恢复，不弹回
    const total = bars.length;
    const vkey = 'gs_view_' + (barData.interval || 'x');
    const saved = State._viewRange && State._viewRange[vkey];
    if (saved && saved.to <= total + 30 && saved.from > -total) {
      chart.timeScale().setVisibleLogicalRange(saved);
    } else {
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - 150), to: total + 4 });
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (!r) return;
      State._viewRange = State._viewRange || {};
      State._viewRange[vkey] = { from: r.from, to: r.to };
    });

    // 画线系统：水平线/趋势线标记
    this._setupDrawings(chart, candle, host, barData.interval || '5m');

    this._cache.set(host, chart);
    return chart;
  },

  /** 副图：RSI 或 MACD */
  sub(host, kind, ind, times) {
    U.clear(host);
    if (kind === 'none' || !ind) return;

    const chart = LightweightCharts.createChart(host, {
      layout: {
        background: { type: 'solid', color: '#141922' },
        textColor: '#64717f', fontSize: 10, fontFamily: 'ui-monospace, monospace'
      },
      grid: { vertLines: { color: '#1e2632' }, horzLines: { color: '#1e2632' } },
      rightPriceScale: { borderColor: '#2a3441' },
      timeScale: { visible: false },
      height: 96,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
    });

    if (kind === 'rsi' && ind.rsi14) {
      const s = chart.addLineSeries({
        color: '#9b7fd4', lineWidth: 2, priceLineVisible: false, lastValueVisible: true
      });
      const data = [];
      for (let i = 0; i < ind.rsi14.length; i++) {
        if (ind.rsi14[i] != null) data.push({ time: times[i], value: ind.rsi14[i] });
      }
      s.setData(data);
      s.createPriceLine({ price: 70, color: '#ef5350', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
      s.createPriceLine({ price: 30, color: '#26a69a', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
    } else if (kind === 'macd' && ind.macd_hist) {
      const h = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      const hd = [];
      for (let i = 0; i < ind.macd_hist.length; i++) {
        if (ind.macd_hist[i] != null) {
          hd.push({
            time: times[i],
            value: ind.macd_hist[i],
            color: ind.macd_hist[i] >= 0 ? 'rgba(38,166,154,.7)' : 'rgba(239,83,80,.7)'
          });
        }
      }
      h.setData(hd);
      const d1 = chart.addLineSeries({ color: '#d8ab3e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const d2 = chart.addLineSeries({ color: '#4a9eff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const dd1 = [], dd2 = [];
      for (let i = 0; i < times.length; i++) {
        if (ind.macd_dif?.[i] != null) dd1.push({ time: times[i], value: ind.macd_dif[i] });
        if (ind.macd_dea?.[i] != null) dd2.push({ time: times[i], value: ind.macd_dea[i] });
      }
      d1.setData(dd1); d2.setData(dd2);
    }

    chart.timeScale().fitContent();
    return chart;
  },

  /** 盈亏曲线（ECharts） */
  equity(host, trades) {
    U.clear(host);
    if (!trades.length) {
      host.appendChild(U.el('div', { class: 'empty-tip', text: '暂无平仓记录' }));
      return;
    }
    const sorted = [...trades].filter((t) => t.status === 'closed')
      .sort((a, b) => (a.closed_at || 0) - (b.closed_at || 0));
    let cum = 0;
    const xs = [], ys = [];
    sorted.forEach((t) => {
      cum += t.pnl || 0;
      xs.push(U.full(t.closed_at).slice(5));
      ys.push(U.fx(cum, 2));
    });

    const chart = echarts.init(host);
    chart.setOption({
      grid: { left: 52, right: 16, top: 20, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#1a212c',
        borderColor: '#374354',
        textStyle: { color: '#e8eef5', fontSize: 11 }
      },
      xAxis: {
        type: 'category', data: xs,
        axisLine: { lineStyle: { color: '#2a3441' } },
        axisLabel: { color: '#64717f', fontSize: 10 }
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#1e2632' } },
        axisLabel: { color: '#64717f', fontSize: 10 }
      },
      series: [{
        type: 'line', data: ys, smooth: true, showSymbol: false,
        lineStyle: { width: 2, color: '#d8ab3e' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(216,171,62,.22)' },
            { offset: 1, color: 'rgba(216,171,62,0)' }
          ])
        }
      }]
    });
    window.addEventListener('resize', () => chart.resize(), { once: true });
  }
};