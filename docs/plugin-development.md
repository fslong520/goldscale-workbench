# 金秤插件开发手册

> 金秤的功能是插件。像 Minecraft 的 mod 一样：往 `plugins/` 里丢一个目录，产品就多一个页面；
> 打包成 `.gsp` 一个文件，就能给别人装。**不用重编译、不用改核心代码、不用等官方发版。**
>
> 本文分两部分：**页面插件**（给产品加页面，第一章到第八章）与 **agent 工具扩展**
> （给对话里的 agent 加工具，第九章）。案例全部取自本仓四个官方活插件，行号可对照源码。

适用范围：金秤 v1.0.0（`/api/health` 的 `data.version`）。

---

## 一、五分钟上手：从 `hello` 复制出一个插件

`plugins/hello/` 是活模板，最小骨架只有两个文件。照做四步：

**① 复制目录并改名**（插件名 = 目录名，只许小写字母、数字、连字符）：

```bash
cd /path/to/金秤-贵金属交易工作台
cp -r plugins/hello plugins/my-plugin
```

**② 改 `plugins/my-plugin/manifest.json`**：

```json
{
  "name": "my-plugin",
  "title": "我的插件",
  "order": 120,
  "desc": "一句话说清这页干什么",
  "version": "0.1.0",
  "author": "你的名字或主页",
  "min_app": "1.0.0"
}
```

**③ 改 `plugins/my-plugin/index.js` 的注册名与标题**（`key` 与目录名一致，见第四章）：

```js
window.Pages = window.Pages || {};

window.Pages['my-plugin'] = {
  key: 'my-plugin',
  title: '我的插件',

  render(view) {
    U.clear(view);
    const page = U.el('div', { class: 'page' });
    page.appendChild(U.card('Hello, plugin', U.el('div', {},
      U.el('div', { class: 'note ok', text: '插件加载成功：' + this.title }),
      U.el('div', { class: 'btns', style: 'margin-top:10px' },
        U.el('button', {
          class: 'btn gold', text: '点我',
          onclick: () => U.toast('插件 ' + this.key + ' 正常工作', 'ok')
        })))));
    view.appendChild(page);
  },

  destroy() {
    // 本页没有定时器/图表/监听器，故此处为空；
    // 有则必须在这里清干净（见第四章）
  }
};
```

**④ 在 `plugins/index.json` 登记一行**（浏览器不能列目录，后端也不扫 `plugins/`，注册表是唯一入口）：

```json
{
  "comment": "插件静态注册表：浏览器不能列目录，服务端也不扫 plugins/。新建插件请在此登记 {\"name\":\"<目录名>\",\"order\":<数字>}。app.js 启动时按此清单逐个加载 plugins/<name>/index.js。",
  "plugins": [
    { "name": "overview", "order": 5 },
    { "name": "hello", "order": 90 },
    { "name": "gold-glance", "order": 100 },
    { "name": "behavior-review", "order": 110 },
    { "name": "my-plugin", "order": 120 }
  ]
}
```

**自检与生效**：

```bash
node --check plugins/my-plugin/index.js     # 语法错在这里就拦住，别留到浏览器
```

然后浏览器 **硬刷新** `Ctrl+Shift+R`（静态 js 有启发式缓存，普通刷新可能仍跑旧脚本），
导航尾巴上就多出「我的插件」一项。打开控制台应见：

```
[plugins] 已加载 5 个：overview,hello,gold-glance,behavior-review,my-plugin
```

没有出现？看控制台里的 `[plugins]` 开头的 warn，对着第七章排查。

---

## 二、加载机制：`js/app.js` 究竟做了什么

事实来源：`js/app.js` 的 `loadPlugins()`（`js/app.js:103`–`156`）与 `loadPlugin()`
（`js/app.js:158`–`206`）。行号以当前快照为准——加载器会随插件管理器演进，读码为准，本文只记机制。

| 步骤 | 代码位置 | 行为 | 出差错时 |
| --- | --- | --- | --- |
| 读注册表 | `js/app.js:106` | `fetch plugins/index.json`（`cache: 'no-store'`，3 秒超时） | 整体不加载任何插件，仅 `console.warn`；启动流程照常（`js/app.js:108`） |
| 停用跳过 | `js/app.js:128` | `{"name":…, "enabled": false}` 的插件连 fetch 都不发（缺省 `true`，向后兼容） | 不算错误，不进错误台账 |
| 取产品版本 | `js/app.js:114`–`122` | `API.health()` 的 `version` 存进 `window.__gsAppVersion`，供 `min_app` 比对 | 拿不到版本 → 本次跳过 `min_app` 校验（只 warn） |
| 校验目录名 | `js/app.js:160` | 正则 `^[a-zA-Z0-9_-]{1,64}$` 不过即抛（错误阶段 `name`） | 丢该插件 |
| 清单先行 | `js/app.js:165`–`170` | 先取 `plugins/<name>/manifest.json`；读不到只 warn，回退注册表信息 | 不因此丢插件 |
| `min_app` 闸 | `js/app.js:171`–`174` | 产品版本低于 `manifest.min_app` 即抛（阶段 `version`）：**不取脚本、不执行** | 丢该插件并 warn「需要金秤 vX，本机 vY」 |
| 取脚本 | `js/app.js:178` | `fetch plugins/<name>/index.js`（文本） | 丢该插件（阶段 `fetch`） |
| 契约防呆 | `js/app.js:183` | 文本非空**且必须含 `window.Pages` 字样**，否则不执行 | 丢该插件（阶段 `contract`；注释里写了 `window.Pages` 也算通过，别指望它） |
| 执行 | `js/app.js:187` | `new Function(text)()` —— 在**函数作用域**内内联求值 | 语法/运行错在此抛出，只丢该插件（阶段 `exec`） |
| 取页面对象 | `js/app.js:192` | 读 `window.Pages[<目录名>]`，须有 `render` 函数 | 丢该插件（阶段 `contract`） |
| 合入路由 | `js/app.js:198`–`204` | `order` 回退链：manifest → index.json → **900**；`key` **强制等于目录名**；压 `page.plugin = true` | — |
| 排序挂载 | `js/app.js:146`–`154` | 插件之间按 `order` 升序，但**插件永远排在内置页之后** | — |
| 记错台账 | `js/app.js:19`–`39`、`140` | 每次跳过写 `window.__gsPluginErrors[name] = {stage, message}`，加载成功即清除 | 设置页「插件管理」据此显示「加载失败」红 chip |

三条硬结论：

1. **插件层是外挂层**：注册表、清单、脚本、版本，任何异常都只丢自己，绝不阻塞启动、绝不动内置页
   （`js/app.js:71`–`77` 的注释是承诺，`js/app.js:132`–`141` 的逐插件 `try/catch` 是落实）。
2. **加载器不经后端**：`js/app.js` 只读静态注册表 `plugins/index.json` 与前端的
   `plugins/<name>/` 目录，不看 `/api/plugins`。设置页的插件管理另有一组后端路由
   （`/api/plugins/manage|install|export|toggle|remove`，实现在 `src/plugin_store.rs`），
   负责写盘、改登记、启停与备份——**两者互不依赖**：没有后端插件照样加载；有后端，装插件
   才不用手写登记（见第八章）。
3. **执行在函数作用域**：`new Function` 意味着 `index.js` 不是 ES 模块——
   **不能用 `import`/`export`，不能有顶层 `await`，不能是 TypeScript**；同时你在顶层写的
   `const`/`let` 不会泄漏到别的插件里（各插件各有作用域），但仍应把自己要保留的状态挂在自己的
   页面对象上（见第四章），别写裸全局变量。

---

## 三、`manifest.json` 字段表

清单是「文件夹即安装」的唯一真源：加载器读 `title`/`order`，并按 `min_app` 做装载前闸门；
其余字段供设置页「插件管理」与社区目录使用。第三列注明用途，缺省值照实现写。

| 字段 | 类型 / 取值 | 谁在用 | 缺失后果 |
| --- | --- | --- | --- |
| `name` | 字符串，目录名；**管理器规则**（装包时后端校验）`^[a-z0-9][a-z0-9-]{0,31}$`：1–32 位小写字母/数字/连字符，首位须字母或数字 | 加载器、装包校验、目录索引 | 加载器放行但管理页装不进 |
| `title` | 字符串，导航显示名 | 加载器（`js/app.js:202`）、装包校验（空即拒） | 回退注册表 `title` → 目录名 |
| `order` | 整数，导航排序 | 加载器（`js/app.js:198`）、装包校验（缺即拒） | 回退注册表 `order` → 900 |
| `desc` | 字符串，一句话简介 | 管理器列表、社区目录 | 管理器中以空简介显示 |
| `version` | 字符串，**semver**（如 `1.2.0`） | 管理器（导出文件名、升级比较、列表显示） | 列表与导出名显示 `v—` |
| `author` | 字符串，作者署名或主页 | 管理器列表、社区目录 | 视作未署名 |
| `min_app` | 字符串，最低金秤版本 | 加载器（`js/app.js:171`–`174`，取脚本前比对产品版本） | 缺省不限制，照载 |
| `homepage` | 字符串，可选，分享/仓库链接 | 管理器、社区目录 | 无链接可点 |

两条必须说清的事：

- **`min_app` 是真的闸门**：产品版本取自 `/api/health`（`src/main.rs:215`–`220`，当前
  `Cargo.toml` 的 `1.0.0`）。加载器取 `index.js` **之前**先读清单并比对：产品版本低于
  `min_app` 即抛阶段 `version`，跳过该插件、控制台 warn「需要金秤 vX，本机 vY」，
  设置页插件管理显示「加载失败」红 chip。比对是分段数字比（`js/app.js:42`–`52`），
  写规规矩矩的 `主.次.补`。**取不到产品版本时跳过校验**（只留一条 warn）。
- **`index.json` 的登记项仍是精简三键**：`{"name": "<目录名>", "order": 100, "enabled": false?}`。
  `enabled: false` 即停用（`js/app.js:128`；缺省启用），由管理器的启停开关写入。
  `title`/`desc`/`version`/`author`/`min_app`/`homepage` 一律以 `manifest.json` 为真源，
  注册表里再抄一份只会两处打架——管理页也按此口径合并显示（`src/plugin_store.rs` 的 `manage()`）。
- **装包另有一道必填闸**：`.gsp` 导入时后端校验 `name`（按上面规则）、`title`（非空）、
  `order`（整数）三项，缺一即拒收。手写目录不受此闸，但过一遍 `.gsp` 能提前发现缺字段。
- 插件名两边夹住的规则：管理器/后端（小写 + 数字 + 连字符，首位字母或数字，≤32）比加载器正则
  （`^[a-zA-Z0-9_-]{1,64}$`，下划线、大写也放行，≤64）更严。**按严的写**，两边都过。

---

## 四、页面对象契约

插件在一个全局词法变量 `window.Pages` 下注册自己，键为目录名：

```js
window.Pages['my-plugin'] = {
  key: 'my-plugin',        // 加载器会强制覆盖为目录名（js/app.js:201），写对是为了自洽
  title: '我的插件',        // 可被 manifest.title 覆盖
  home: false,             // 可选：true = 启动默认落点（js/app.js:82）；一个产品只该有一个
  render(view) { },        // 必需：往 view 里画整页
  destroy() { },           // 可选但强烈建议：切页前清理
  tick(view) { },          // 可选：go() 在 render 之后调用一次（js/app.js:292）
  onSpot() { }             // 可选：顶栏现价刷新后回调（js/app.js:231）
};
```

**渲染与生命周期**：

- `render(view)` 拿到的是已被清空的 `#view` 容器（`js/app.js:289`）。自己再 `U.clear(view)`
  防御一次无妨，但**不要**往 `document.body` 或顶栏塞东西（要挂顶栏得自己 `mount()` 并保证幂等，
  参见 `js/app.js:335` 的 `Coach.mount()` 写法）。
- 切换页面时 `App.go()` 先调用上一页的 `destroy?.()`，再清空并渲染新页（`js/app.js:276`–`294`）。
  所以：**定时器、`setInterval`、图表实例、`document`/`window` 事件监听，必须在 `destroy()`
  里清干净**。`plugins/hello/index.js:94` 与 `plugins/gold-glance/index.js:94` 都是清 timer 的范式。
- 异步回调可能落在切页之后：动手写 DOM 前先判 `host.isConnected`（范式见
  `plugins/overview/index.js:121`、`plugins/behavior-review/index.js:123`），否则你会往已卸载的
  节点里写内容，控制台干净但页面白。
- `tick(view)` 每次进入页面都会调用；`onSpot()` 与顶栏现价同源（15 秒一次，
  `js/app.js:86`、`225`），用于「同屏不打架」。

**样式语言（与内置页同构，不许自成一派）**：

- 用 `U.el`/`U.card`/`U.stat`/`U.table` 组装，别写一坨 `innerHTML`；文本一律走 `text:`，
  动态 HTML 只走 `html:` + `U.md()`（`U.md` 内部先全量转义，`js/core.js:150`）。
- 涨跌配色统一：`U.cls(v)` 给 `up`（涨/正）/`down`（跌/负）/`dim`（零或缺失），
  红涨绿跌是产品口径，别反过来。数字用 `U.money`（带正负号）、`U.px`、`U.fx(n, d)`；
  缺失一律 `'--'`。
- 空态、错误态、加载态各自明说：`empty-tip`（无数据）、`note err`（失败）、
  `note warn`（降级可用）、`stats` 里先摆 `'--'` 占位（范本
  `plugins/overview/index.js:59`）。
- **绝不假数据**：这是产品红线（`AGENTS.override.md` 第五节）。取不到就 `'--'`+原因，
  数据陈旧就标「数据陈旧」，宁可难看，不许好看地撒谎。`plugins/gold-glance/index.js:83`–`90`
  是标准做法。

---

## 五、API 手册

`js/core.js` 的 `U`、`API`、`State` 三个全局对象就是插件的全部工具箱（`index.html:28`
先加载 `js/core.js`，再加载 `js/app.js`，插件最后执行）。**不要**自己再 `fetch` 金秤接口，
也不要引用未在本文列出的函数——它们不是契约。

### 5.1 `U` 工具

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `U.el` | `U.el(tag, attrs = {}, ...kids)` | 建元素。`attrs` 支持 `class` / `html` / `text` / `on*`（函数）/ 其它属性；`kids` 自动 `flat(3)`，空值跳过 |
| `U.clear` | `U.clear(node)` | 清空并返回该节点 |
| `U.$` / `U.$$` | `U.$('sel', root?)` / `U.$$('sel', root?)` | `querySelector` / 数组化 `querySelectorAll` |
| `U.card` | `U.card(title, body, actions?)` | 卡片；`actions` 为节点数组，显示在卡头右侧 |
| `U.table` | `U.table(headers, rows)` | 表头项 `{label, num}`；单元格支持 Node、`{v, num, cls}` 描述符、字符串 |
| `U.stat` | `U.stat(label, value, sub, cls = '')` | 指标块（`stats` 容器里横排） |
| `U.field` | `U.field(label, input)` | 表单一行 |
| `U.numInput` | `U.numInput(value, opts)` | 数字输入（`step`/`min`/`max`/`attrs`） |
| `U.sel` | `U.sel(value, [[v, label], ...])` | 下拉选择 |
| `U.toast` | `U.toast(msg, type = '')` | 3 秒提示；`type` 有样式的只有 `'ok'`（绿）与 `'err'`（红，`css/main.css:220`–`221`），其余值走默认样式 |
| `U.md` | `U.md(text)` → HTML 字符串 | Markdown 子集：围栏代码块、表格、标题（降级 h4–h6）、引用、列表、行内代码、粗斜体、http(s) 链接；数字与多空词自动着色 |
| 格式化 | `U.fx(n, d=2)` / `U.px` / `U.money` / `U.signed` / `U.cls` | 千分位、两位价、带符号金额、涨跌样式类 |
| 时间 | `U.hhmmss(ts)` / `U.mdhm(ts)` / `U.full(ts)` / `U.ago(ts)` | `ts` 为**秒**级；`U.ago` 输出「3 分钟前」 |
| 杂项 | `U.ivLabel(iv)` / `U.clone(o)` | 周期名 `5m`→`M5`；纯数据深拷贝 |

### 5.2 `API.*` 绑定清单

`API.req()` 统一拆信封：`!res.ok`、非 JSON、`ok !== true` 都 **throw** 一个 `Error`，
`message` 即服务端 `error`（`js/core.js:285`–`297`）。所以调用处一律 `try/catch`，把
`e.message` 说给用户听。

**主服务 8787（开源部分，必装）**：

| 绑定 | 端点 | 说明 |
| --- | --- | --- |
| `API.health()` | `GET /api/health` | `{name, version}`，版本比对用 |
| `API.settings()` / `API.saveSettings(s)` | `GET/POST /api/settings` | 全局设置（含策略库）。**里面可能有 `ai.api_key`，永不回显、永不上报** |
| `API.series(iv, force?)` | `GET /api/series?interval=` | K 线 `{bars, stale, simulated, source, fetched_at}`；周期 `5m/15m/1h/4h/1d` |
| `API.indicators(iv)` | `GET /api/indicators?interval=` | 指标序列 |
| `API.spot()` | `GET /api/spot` | 现货 `{price, prev_close, silver, gold_silver_ratio, source, t, fresh, ...}` |
| `API.signal(id)` / `API.signalAll()` / `API.signalEnhanced(id)` | `GET /api/signal`、`/api/signal/enhanced` | 信号与 AI 结构化研判 |
| `API.positions()` | `GET /api/positions` | 模拟盘全部持仓与历史 |
| `API.open(p)` / `API.close(id, price)` / `API.closePartial(id, pct, price)` / `API.setSL(id, sl)` | `POST /api/positions`、`/close`、`/partial`、`/sl` | 写操作：**下单前必须有人确认**，别做成自动开仓 |
| `API.stats()` / `API.resetDaily()` | `GET /api/stats`、`POST /api/portfolio/reset-daily` | 账本摘要、重置当日 |
| `API.backtest(payload)` | `POST /api/backtest` | 回测/参数优化 |
| `API.ai(prompt, sid?, history?)` | `POST /api/ai` | 一问一答式 AI（非 agent）；失败可重试 |
| `API.aiPresets()` / `API.aiLog(limit?)` | `GET /api/ai/presets`、`GET /api/ai/log` | 预设 prompt、研判记录 |
| `API.memList(q)` / `API.memSave(item)` / `API.memDel(id)` | `GET /api/memory?q=`、`POST /api/memory`、`DELETE /api/memory/:id` | 记忆读写；别名 `memoryList/memorySave/memoryDel` 同义 |
| `API.memPlugin()` / `API.memEnable()` / `API.memDisable()` | `GET /api/memory/plugin`、`POST .../enable`、`.../disable` | 记忆插件状态与开关；未开启时记忆接口报「记忆插件未开启」 |

**agent 宿主 8788（闭源核心，可选安装）**——没装时这些 `fetch` 直接失败，必须降级成
「AI 核心未安装」的空态，不许崩：

| 绑定 | 端点 | 说明 |
| --- | --- | --- |
| `API.agent(prompt, chatId?, interval?)` | `POST /api/agent` | 多轮 agent 会话 |
| `API.agentStatus(chatId?)` | `GET /api/agent/status?chat_id=` | 会话状态 |
| `API.agentTask(task, context?)` | `POST /api/agent/task` | 能力任务口：回测解读、优化建议、亏损归因、研究总结、行为周报 |
| （参考）`window.Coach` | `GET http://127.0.0.1:8788/api/coach?since=<ms>` | 行为教练动态（闭源核心）；前端直连范式见 `js/app.js:317`–`503` |

### 5.3 `State` 共享状态

只读为主，插件可读可写但**别乱改**（顶栏与别的页同读它，改了要负责同步其后）：

| 字段 | 含义 |
| --- | --- |
| `State.settings` | 设置快照（`App.reloadSettings()` 拉取，`js/app.js:208`） |
| `State.spot` / `State.spotState` / `State.lastSpot` | 现价 / `live`\|`stale`\|`err`\|`idle` / 时间戳（秒） |
| `State.positions` / `State.stats` | 持仓与账本摘要（`App.refreshPositions()` 更新） |
| `State.signal` / `State.execIv` / `State.indicators` | 信号缓存、当前周期、图上的指标集合 |
| getter | `rrMin`、`confFloor`、`contractSize`、`pointValue`、`spreadPoints`（带缺省值） |

### 5.4 跨页约定

- **跳转**：`App.go(key)`（`js/app.js:276`）；先确认目标页存在——
  `PAGES.some(p => p.key === key)`。`PAGES`（含已加载插件页、`plugin` 标记）是全局词法变量，
  插件可直接读（`plugins/overview/index.js:322` 就靠它过滤掉插件页避免自指）。
- **现价广播**：`document` 上的 `CustomEvent('gs:spot')`，`detail` 为现货对象
  （`js/app.js:225`；`js/alerts.js` 用它做到价提醒）。插件若要跟随现价，**优先实现 `onSpot()`**，
  监听事件留给跨页全局功能。
- **本地存储**：键名统一 `gs_` 前缀（如 `gs_alerts`、`gs_cooldown_min`），
  读写一律 `try/catch`（隐私模式会抛）。别动别人的键。
- **设置页的插件管理器**（设置 → 插件管理）：列出注册表里的插件，合并 `manifest.json` 的展示
  字段（`title`/`order`/`version`/`author`/`min_app`），显示加载错误（读
  `window.__gsPluginErrors[name]` 的 `stage`/`message`）与 `min_app` 不满足的警示，并提供
  启停、导出、导入、删除。背后的后端路由（实现在 `src/plugin_store.rs`）：

  | 路由 | 作用 |
  | --- | --- |
  | `GET /api/plugins/manage` | 清单：`items`（含 `version`/`author`/`min_app`/`enabled`/`has_error`）+ 原始 `registry` |
  | `POST /api/plugins/install` | 装 `.gsp`：写 `plugins/<name>/`、改写 `index.json` 登记；覆盖前备份 |
  | `GET /api/plugins/export?name=` | 读目录拼回 `.gsp` 包 |
  | `POST /api/plugins/toggle` | 启停（写 `index.json` 的 `enabled`） |
  | `POST /api/plugins/remove` | 删目录并去掉登记 |

  这组路由属**管理器能力**：插件运行时不依赖它们（加载器只读静态注册表）。要在自己的页面里
  判断产品版本或加载错误，直接读 `window.__gsAppVersion` 与 `window.__gsPluginErrors`，
  别去调这组接口。

---

## 六、容错纪律

加载器对外挂层是宽容的（第二章），但**你自己写插件不能反向污染主流程**：

1. **一切外部调用包 `try/catch`**：`API.*`、`fetch`、`JSON.parse`、`localStorage`。失败要
   「明说 + 可重试」，不要静默吞掉，也不要 `throw` 到 `render` 之外。
2. **不污染全局**：不新增 `window.xxx` 裸挂载点（除注册自己的 `window.Pages[...]`），
   不覆盖 `U`/`API`/`State`/`App`/`PAGES`，不动 `document.body`、不动顶栏与别的页的 DOM。
3. **不阻塞 `render`**：耗时任务（网络、回测、AI）异步做，先渲染占位骨架再回填
   （`plugins/overview/index.js:52`）。渲染函数里放 `await` 会拖慢整个导航切换。
4. **无数据的三种态各就各位**：加载中 → `'--'`+「读取中…」；失败 → `note err`+原因；
   无数据 → `empty-tip`。红线是**绝不假数据**。
5. **`destroy()` 必须清副作用**：`setInterval`/`setTimeout`、图表实例、`document` 监听器、
   大对象引用。范例 `plugins/gold-glance/index.js:94`–`99` 连 DOM 引用都置 `null`。
6. **依赖可选能力前先探测**：如 `window.Behavior?.todayBudget?.()` 这类用法
   （`plugins/overview/index.js:186`），能力不在就退化成 `'--'`，别假设它一定在。

---

## 七、调试

| 手段 | 怎么做 |
| --- | --- |
| 语法自检 | `node --check plugins/<name>/index.js`（`index.js` 必须是可解析脚本，不是模块） |
| 加载日志 | 控制台搜 `[plugins]`：`已加载 N 个：…` 是成功；`加载失败，已跳过：<name> <原因>` 是失败 |
| 契约防呆 | 脚本里必须出现 `window.Pages` 字样（`js/app.js:183`）；注册键必须等于目录名（`js/app.js:192`） |
| 缓存骗人 | 静态 js 有启发式缓存，改完必 **硬刷新 `Ctrl+Shift+R`**；仍不对就开 DevTools 的
  「Disable cache」再刷 |
| 断点 | 源码里 `debugger;` 或 DevTools Sources 面板按目录找 `plugins/<name>/index.js` |
| 网络 | Network 面板看 `plugins/index.json` 是否 200、`plugins/<name>/index.js` 是否 404 |
| 故障注入自测 | **故意**在 `index.js` 里写一行语法错和一行运行错（如 `null.x`），刷新后确认：只丢你这一个插件、其余插件与内置页照常、控制台有一条 warn——这是插件层容错的验收方法，改完记得删掉 |
| 生命周期自测 | 进页开定时器 → 切到别的页 → 在 `destroy` 里打个 `console.log` 或给 `document` 计数器加一，确认切页确实清理（`plugins/hello` 的走秒钟就是给人看的） |
| 加载失败定位 | 设置页「插件管理」点开红 chip 看原因；或控制台读 `window.__gsPluginErrors`，`stage` 取值 `name`／`version`／`fetch`／`contract`／`exec`，一眼分出是名字、版本、网络还是代码问题 |

---

## 八、打包与分享：`.gsp`

插件目录拷给人也能用（放进 `plugins/` + 登记 `index.json`），但分享一个**目录**费事，
于是有单文件格式 `.gsp`（GoldScale Plugin）。**格式契约如下，写者照此，读者是设置页插件管理器**：

```json
{
  "format": "gsp1",
  "plugin": {
    "manifest": {
      "name": "my-plugin",
      "title": "我的插件",
      "order": 120,
      "desc": "一句话说清这页干什么",
      "version": "0.1.0",
      "author": "你的名字或主页",
      "min_app": "1.0.0",
      "homepage": "https://example.com/my-plugin"
    },
    "files": {
      "index.js": "window.Pages['my-plugin'] = { /* 全文，字符串原样 */ };",
      "README.md": "可选：用法说明",
      "preview.png": "可选：截图（files 值一律是字符串，二进制需自行编码为文本）"
    }
  }
}
```

- **导出**：设置页 → 插件管理 → 对应插件行的「导出」按钮：后端读 `plugins/<name>/` 拼回包
  （`GET /api/plugins/export?name=`），浏览器存为 `<name>-v<version>.gsp`；`version` 未声明时
  文件名显示 `v—`。
- **导入**：设置页 → 插件管理 → 「导入 .gsp」（`POST /api/plugins/install`）——写盘
  `plugins/<name>/`、改写 `plugins/index.json`、必要时备份旧目录；也可手工解出目录放进
  `plugins/<name>/` 再登记 `plugins/index.json`。
- **`files` 里放什么**：加载器只 `fetch` `plugins/<name>/index.js`（`js/app.js:178`），
  所以 `index.js` 必备；`README.md`、`preview.png` 是给人看的附件。**别把 `manifest.json`
  再塞一份进 `files`**——`manifest` 对象已经是它，两处真源必然打架。
- **装包硬闸**（后端 `validate()`，不满足直接拒收）：单包文件数 **≤ 10**；单文件文本
  **≤ 200 KB**；`files` 的键是相对路径，只许 `[A-Za-z0-9_./-]`，**禁 `..`、禁绝对路径、
  禁反斜杠、禁空段**（zip-slip 面）；`manifest.name`/`title`/`order` 必填（规则同第三章）。
- **覆盖升级**：同名插件再导入即覆盖——落盘前把旧目录改名 `plugins/<name>.bak-<时间戳>`
  （只留最近一份），升级失败可回退。
- **安全声明**：`.gsp` 里的 `index.js` 是**可执行前端代码**，加载器会直接执行它。
  Minecraft 装 mod 的规矩同此：**只装可信来源**，别装来路不明的 `.gsp`；装前可以打开文件读一遍
  ——它不是二进制，读得懂。导入第三方插件的风险自负（能读你的持仓、能调 AI 接口、能发网络请求）。

---

## 九、给 agent 写工具扩展（pi extension）

页面插件给**产品**加页面；pi extension 给**对话里的 agent** 加工具。两者互不相干：
前者跑在浏览器里，后者跑在 agent 宿主进程里，用 TypeScript 写。

### 9.1 注册的三条路

pi 的扩展发现有三条路（金秤实测口径见 `agent/pi/extensions/README.md:16`–`36`）：

| 路径 | 级别 | 门控 |
| --- | --- | --- |
| `<cwd>/.pi/extensions/` | 项目级 | **受项目信任门控**；RPC 模式没有交互式信任提示，`defaultProjectTrust` 缺省 `ask` 时整批跳过 |
| `<agent-dir>/extensions/`（缺省 `~/.pi/agent/extensions`） | 用户级 | 无需项目信任 |
| settings 的 `extensions: ["<绝对路径>"]`（`<agent-dir>/settings.json`） | 用户级 | 不受项目信任门限制 |

**官方扩展怎么进去的**：`agent/pi/extensions/goldscale.ts` 是版本化真源，被
`include_str!` 编进闭源 agentd 二进制；agentd 启动时把它**播种**到
`~/.goldscale/pi-ext/goldscale.ts`，再把播种位的绝对路径**幂等**补进 `<agent-dir>/settings.json`
的 `extensions` 数组（只增不删，解析失败只告警）。用户机器上没有源码，扩展照样随二进制走。

**第三方扩展最省事的注册法**（金秤闭源核心不拦你）：把自己的 `.ts` 放进
`~/.pi/agent/extensions/`，或在 `<agent-dir>/settings.json` 写一行
`{"extensions": ["/绝对/路径/my-tool.ts"]}`，下一次 pi 会话即生效。
（项目的 `.pi/extensions/` 需要项目信任，agentd 起 pi 时不传 `--approve`，所以那条路在
金秤里默认不通，别选它。）

### 9.2 工具规范（照 `goldscale.ts` 抄）

1. **只读优先**：能只读就不写。写操作要留人工确认，注解里别冒充只读。
2. **注解**：`annotations: { readOnlyHint: true, openWorldHint: false }`；权限类扩展据此免确认。
3. **超时**：所有外部请求给死线，`AbortSignal.timeout(5000)`。本地服务 5 秒足够。
4. **失败返回、不 throw**：把错误转成**中文文本**返回（模型看得懂、会话不炸），并说清
   「服务没起来该去跑 `./start-all.sh`，不要改用别的数据源编造」（原话见
   `agent/pi/extensions/goldscale.ts:45`–`56`）。
5. **参数校验快失败**：非法取值别当服务故障，回一条说明合法取值的错误
   （`goldscale.ts:58`–`62`）。
6. **绝不返回密钥**：返回体**逐字段挑选**，`settings.ai.api_key` 一类绝不进返回值
   （`goldscale.ts:210`–`221`）。同理不返回整份 `data/settings.json`。
7. **描述写清触发场景**：工具描述里写明数据来源与「用户问什么时调用」，模型据此决定调用时机
   （`goldscale.ts:76`–`79`）。

### 9.3 `goldscale.ts` 逐段讲

```ts
const GOLDSCALE_BASE = "http://127.0.0.1:8787";   // 只读、写死回环，绝不出网
const TIMEOUT_MS = 5000;                          // 单次请求上限
const INTERVALS = ["5m", "15m", "1h", "4h", "1d"];// 合法周期，供参数校验与描述共用
```

- `getData(path)`（`goldscale.ts:28`–`37`）：统一取数——`AbortSignal.timeout` 控时，
  非 200 抛 `HTTP <status>`，`ok !== true` 抛服务端 `error`；**拆信封这一步只做一次**。
- `okResult` / `failResult` / `badParamResult`（`39`–`62`）：三种返回体。成功把 payload
  同时写进 `content`（给模型看）与 `details`（给程序看）；失败是**人话**，并附
  `details.error = true`。
- 参数用 `Type.Object`（`64`–`70`）：`interval` 可选、描述里列出合法值；无参工具用空的
  `Type.Object({})`。
- `export default function goldscaleExtension(pi: ExtensionAPI)`（`72`）：扩展入口，
  里面三次 `pi.registerTool({...})`。每个工具的形状固定：
  `name` / `label` / `description` / `parameters` / `annotations` / `async execute()`。
- `goldscale_market`（`73`–`118`）：`/api/spot` + `/api/series` 并发取，
  返回现价与**末 3 根 K 线**——只给模型够用的量，`bars_total` 告诉它还有多少；
  `stale`/`simulated` 如实透出（宁缺毋假的产品原则，工具层同样守）。
- `goldscale_portfolio`（`120`–`180`）：持仓与账本；`slim()` 逐字段挑选，
  只回模型判断所需的字段，历史只取最近 5 笔。
- `goldscale_strategies`（`182`–`227`）：策略清单；`slim()` 白名单挑字段，
  注释里明写「`settings.ai`（含 `api_key`）绝不进返回值」。

一句话总结范式：**入口单函数、取数单函数、返回体三形态、字段白名单、错误给人话**。

---

## 十、官方案例逐个讲

### 10.1 `plugins/hello` —— 最小骨架 + 自证机制

文件：`plugins/hello/index.js`（97 行）、`manifest.json`。

- 头注释（`index.js:1`–`5`）：契约、执行方式、三步操作单，全写在同一处——新插件抄它最省事。
- 页面三件：身份行（`13`–`26`）、最小骨架卡（`28`–`48`）、给 agent 的三步单（`51`–`60`）。
- 亮点是**自证**：身份行读 `PAGES` 显示自己在导航里的位置与「本次会话已加载插件数」
  （`index.js:20`–`26`）——一眼看出加载顺序与插件层是否活着，比任何日志都直观。
- 走秒计时器（`85`）配 `destroy()`（`94`–`96`）：**生命周期的最小可验证样本**，切页就停。
- 适合当模板的原因：只有一个按钮、一个定时器，没有网络，读一遍就懂契约。

### 10.2 `plugins/gold-glance` —— 消费一个 API 的标准姿势

文件：`plugins/gold-glance/index.js`（100 行）。

- 注册键用**方括号**写法 `window.Pages['gold-glance']`（`index.js:8`）——名字带连字符时
  只能这么写，这是 new 手最常见的坑。
- 局部重绘：`render` 只建两个挂载点 `statsHost`/`metaHost`（`18`–`22`），刷新只重画它们，
  整页不闪（`60`–`92`）。
- 数据态全覆盖：先渲染占位骨架（`39`），再 `load()`；失败时 `silent` 参数决定要不要弹 toast
  （`46`–`58`），自动刷新走 `silent = true`（`43`），避免每 10 秒弹一次错误。
- 新鲜度如实标注：`sp.fresh === true` 才显示「● 数据正常」，否则「● 数据陈旧」并给
  更新时间与 `U.ago`（`83`–`90`）；`silver` 上游没给就写「上游未提供」（`78`），
  金银比缺失给 `'--'`（`79`）。
- `destroy()` 清 timer 并把 DOM 引用置 `null`（`94`–`99`）。
- 想学「只消费一个接口」的插件，这份是标准答案。

### 10.3 `plugins/overview` —— 多 API 聚合的卡片网格

文件：`plugins/overview/index.js`（338 行）。它是产品默认首页（`home: true`，`index.js:13`）。

- 五个挂载点一次建好（`21`–`26`），五张卡：实时现货、模拟盘账户、生效策略 · 最新研判、
  最近平仓、快捷入口。
- **并发取数 + 单项失败不拖累**：`load()` 把三个请求装进 `tasks`，用 `Promise.all` +
  每项自 `try/catch` 的**信封**（`{v}` 成功 / `{e}` 失败）收口（`93`–`103`）——
  一个接口挂了，其余卡片照常显示，挂掉的那张写清原因（`168`、`234`）。
- **与顶栏同源**：现货不自己取，读 `State.spot` / `State.spotState`（`119`–`155`），
  并实现 `onSpot()`（`158`–`160`）跟随顶栏刷新——同屏两个数字永不打架。
- **可选能力探测**：今日可亏走 `window.Behavior?.todayBudget?.()`，不在就显示 `'--'` +
  原因（`185`–`195`）。
- **口径一致**：「今日平仓 N 笔」与「最近平仓」卡都从同一份 `/api/positions` 按本地日历日算
  （`173`、`199`–`208`），不各算各的。
- **不自指**：快捷入口用 `PAGES` 过滤掉 `plugin` 页（`322`），插件页不给自己导流。
- 想学「聚合多接口、拼一屏卡片」，照这份抄结构：挂载点 → 并发信封 → 分部渲染 → `isConnected` 守卫。

### 10.4 `plugins/behavior-review` —— 记忆 + AI 组合

文件：`plugins/behavior-review/index.js`（288 行）。它把「本地成交」与「记忆库归因」两源拼成
周报，再让 AI 总结。

- **状态跨渲染保留**：`_days`（周期）、`_summary`（上次 AI 总结）挂在页面对象上，
  `destroy()` 只清 DOM 引用、**保留这两个**（`283`–`287`）——切页回来不必重新烧 token。
- **两个数据源各自捕获**：`collect()` 里成交与记忆分开 `try/catch`（`74`–`100`）；
  记忆插件未开启时不报错，只提示去设置页开启，成交照统计（`95`–`98`、`135`–`141`）。
- **跨页契约**：只认复盘页写的归因条——标题以「亏损归因」开头，或 `tags` 里精确等于
  「亏损归因」（`isAttr`，`66`–`72`）。**改别的页的存储格式前先看这里**，这是插件与被复用
  页面之间的真实约定。
- **词频是纯 DOM**：不引图表库，按宽度百分比画条形（`164`–`183`），最高频一条用告警色。
- **AI 才用真数据**：`buildPrompt()` 只喂本页统计到的真数据，并写明「不得编造」（`215`–`239`）；
  失败**绝不塞假总结**，明说不成并给「重试」（`241`–`274`）。
- **切页后不写空**：异步回来后先查 `isConnected` 再写（`123`）。
- 想学「记忆 + AI」的组合拳，这份是范式：真数据打底、AI 只做解释、失败可重试。

---

## 十一、常见坑速查

| 症状 | 病因 | 解法 |
| --- | --- | --- |
| 导航里没出现 | 没登记 `index.json`、`enabled:false`、名字拼错、`index.js` 里没有 `window.Pages` 字样、`min_app` 高于本机版本 | 三步逐项核（`js/app.js:124`–`195`），再看设置页插件管理的红 chip |
| 更新了代码但页面没变 | 静态 js 启发式缓存 | 硬刷新 `Ctrl+Shift+R`，或 DevTools 勾 Disable cache |
| `U is not defined` | 在 `js/core.js` 之前执行或写成了模块 | 插件一律由加载器在 `core.js` 之后注入，不要自己 `<script type="module">` |
| 控制台报语法错但其它页正常 | 正常现象——插件层故障隔离 | 修自己那份即可（这正是容错设计） |
| 切页后仍每 10 秒报错 | `destroy()` 没清 `setInterval` | 见第四章生命周期 |
| 页面白但无报错 | 异步回调写进了已卸载的 DOM | 写 DOM 前 `isConnected` 守卫（`overview/index.js:121`） |
| 数字穿帮（明明是旧价却显示正常） | 没看 `fresh`/`stale` | 陈旧就标注，缺失给 `'--'`——红线 |
| 两个页面数字不一致 | 各取各的现价 | 读 `State.spot` + 实现 `onSpot()` |

---

## 附：开发自检清单

- [ ] 目录名合规（小写 + 数字 + 连字符），`key` 与目录名一致
- [ ] `manifest.json` 写全 `title`/`order`/`desc`/`version`/`author`/`min_app`
- [ ] `plugins/index.json` 登记 `{"name": "<name>", "order": N}`
- [ ] `node --check plugins/<name>/index.js` 通过
- [ ] 硬刷新后导航出现，控制台 `[plugins] 已加载 …` 含本插件
- [ ] 切页 `destroy()` 无残留（定时器/监听器/图表）
- [ ] 断网或接口失败时：明说原因 + 可重试，不假数据
- [ ] 无新增裸全局，无改写 `U`/`API`/`State`/`App`/内置页 DOM
- [ ] 故障注入自测过一轮（故意写错一行，确认只丢自己）
- [ ] 要分享就导 `.gsp`，并在 `docs/plugins.md` 登记一行（见 `CONTRIBUTING.md`）
