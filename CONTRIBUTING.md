# 贡献指南

金秤的生态边界是**开源外围 + 闭源 AI 核心**（见 README）。外围的插件、文档、页面欢迎 PR；
核心（`src/`、agentd、灵魂规则）闭源另议，见本文末。

三类贡献最受欢迎：**新插件**（页面插件 / agent 工具扩展）、**官方插件改进**、**文档与范例修正**。

先读：[`docs/plugin-development.md`](docs/plugin-development.md)（开发手册）、
[`docs/plugins.md`](docs/plugins.md)（插件目录）。

---

## 一、目录结构与命名

```
plugins/
├── index.json               # 静态注册表：登记 {"name","order","enabled"?}
└── <name>/
    ├── manifest.json        # 清单（字段表见开发手册第三章）
    ├── index.js             # 页面实现：window.Pages['<name>'] = { … }
    ├── README.md            # 可选：用法说明（进 .gsp 的 files）
    └── preview.png          # 可选：截图（进 .gsp 的 files，可被打包）
```

- 目录名 = 插件名 = `window.Pages` 的键。命名按管理器（后端装包校验）的规则：
  `^[a-z0-9][a-z0-9-]{0,31}$`——**小写字母、数字、连字符，1–32 字符，首位须字母或数字**
  （如 `gold-glance`）。下划线、大写虽被前端加载器放行，装包会被拒，别用。
- 键名带连字符时用方括号写法：`window.Pages['gold-glance'] = { … }`。
- 一个插件一个目录，自带 README 与截图；不要往 `plugins/` 根放散文件。

## 二、`manifest.json` 必填字段

```json
{
  "name": "<目录名>",
  "title": "<导航显示名>",
  "order": 120,
  "desc": "<一句话简介>",
  "version": "0.1.0",
  "author": "<署名或主页>",
  "min_app": "1.0.0",
  "homepage": "<可选：仓库/主页链接>"
}
```

- `version` 用 semver；`min_app` 写你真正的下限（缺省不限制）；`homepage` 可选。
- 装包（`.gsp` 导入）时后端强制三项：`name` 合规、`title` 非空、`order` 为整数——缺一即拒。
- `index.json` 里只登记 `{"name", "order"}`（启停由管理器的 `enabled` 维护），
  其余字段以 `manifest.json` 为唯一真源——**不要两处抄**。

## 三、代码规范（审查重点）

1. **只用契约内的工具**：`U` / `API` / `State` / `App`（开发手册第五章）。不自己 `fetch`
   金秤接口，不引用未列出的内部函数。
2. **绝不假数据**：这是产品红线。取不到就 `'--'` + 原因，数据陈旧就标注陈旧，绝不填充、
   绝不编造。空态（`empty-tip`）、错误态（`note err`）、加载态（占位骨架）各就各位。
3. **生命周期干净**：`destroy()` 清掉所有定时器、图表实例、`document`/`window` 监听器与大对象
   引用；异步回来写 DOM 前判 `host.isConnected`。
4. **不污染全局**：除注册 `window.Pages['<name>']` 外不新增裸全局；不覆盖 `U`/`API`/`State`/
   `App`/`PAGES`；不动顶栏、`document.body` 与其它页的 DOM。
5. **不阻塞 `render`**：网络/AI/回测一律异步先占位后回填；`render` 里不做重活。
6. **失败给人话**：一切外部调用包 `try/catch`，错误明说且可重试（AI 类操作给「重试」按钮）。
7. **样式同构**：`U.card`/`U.stat`/`U.table`/`U.md` 组装，红涨绿跌用 `U.cls`，
   缺失走 `'--'`。别引第三方前端库（回测图表例外另有约定时，PR 里说明）。
8. **不读不回传密钥**：`data/settings.json` 含 `ai.api_key`，插件一律不得读取、回显、外传。

### 禁止项（直接拒收）

- 窃取或上报用户数据：任何把持仓/账本/记忆/设置发往第三方地址的行为；
- 外联上报／埋点／远程配置：插件不得引入未经说明的外部请求（含 CDN 脚本）；
- 破坏其它插件或内置页：改别人的 DOM、覆盖全局、清别人的 localStorage 键；
- 混淆代码：`eval`、`new Function`（加载器自己用是机制，插件里再用是红线）、
  压缩成不可读单行的代码；
- 违反产品红线（假数据、开外网监听、擅自放宽风控参数）；
- 在插件里直接改内置页文件来“顺便实现”——那属核心改动，另走流程（见第七节）。

## 四、自测清单（PR 里请附结果）

```bash
node --check plugins/<name>/index.js          # 语法
node -e "JSON.parse(require('fs').readFileSync('plugins/<name>/manifest.json'))"   # 清单可解析
```

- [ ] 硬刷新后导航出现本插件，控制台 `[plugins] 已加载 …` 含本插件名；
- [ ] 各态都试过：正常数据、接口失败（停服或断网）、陈旧数据、空数据；
- [ ] 切页无残留（进页 → 切走 → 一分钟内不再有本插件的网络/日志活动）；
- [ ] **故障隔离自测**：故意在 `index.js` 写一行运行错，确认只丢本插件、其余插件与内置页
      照常、控制台仅一条 `console.warn`，改回后复测；
- [ ] `.gsp` 导出自测（见下节）：导出、清掉目录、再导入，行为一致。

## 五、打包 `.gsp`

- 格式契约见开发手册第八章：`{"format":"gsp1","plugin":{"manifest":{…},"files":{…}}}`。
- 包内硬约束（后端 `validate()`，越界即拒）：文件数 ≤ 10、单文件文本 ≤ 200 KB、
  `files` 键只许 `[A-Za-z0-9_./-]`（禁 `..`、绝对路径、反斜杠、空段）。
- 覆盖升级：同名插件再导入即覆盖，旧目录先备份为 `plugins/<name>.bak-<时间戳>`（只留最近一份）。
- 设置页 → 插件管理 → 「导出」生成 `<name>-v<version>.gsp`；PR 里附上该文件（或说明无法导出
  的原因），便于核验 `files` 清单与实际目录一致。
- `files` 含 `index.js`（必需）与可选的 `README.md`、`preview.png`；**不要把 `manifest.json`
  再塞进 `files`**（`manifest` 对象已是它）。
- 截图放 `plugins/<name>/preview.png`，会随 `.gsp` 的 `files` 一并打包，并在插件管理器里
  作为预览——请注意体积，别把 `.gsp` 撑成二进制大包。

## 六、PR 流程

1. Fork → 分支命名 `plugin/<name>` 或 `fix/<name>-<要点>`；
2. 提交信息一句话说清做了什么与效果（例：`Add plugin rsi-alert: RSI 超卖超买到价提醒卡`）；
   一个插件一个提交（一个大 PR 里塞多个无关插件会被要求拆分）；
3. PR 描述请包含：插件用途、manifest 全文、自测清单勾选结果、`.gsp` 附件、
   截图（或说明为何无图）；
4. 审查要点：`node --check` 通过、manifest 字段齐、无外联上报/无混淆、生命周期干净、
   红线遵守、`docs/plugins.md` 登记行已加；
5. 合并后维护者会同步进 `docs/plugins.md` 的社区插件表（若你未加，PR 里说明也可）。

## 七、改动的边界

| 范围 | 态度 |
| --- | --- |
| `plugins/`（新增或改官方插件） | **PR 欢迎**，按本文规范走 |
| 文档（`docs/`、`CONTRIBUTING.md`、README 修正） | **PR 欢迎** |
| 前端外围（`js/` 里非核心工具、`css/` 样式、内置页小修小补） | 可提 PR，改动面大者先开 issue 说明动机与方案 |
| 后端主服务（`src/*.rs` 除核心件） | 可提 PR，须 `cargo build --release`（零警告）+ `cargo test --release` 全绿 |
| AI 核心（agentd / pi 托管 / 记忆网关 / 灵魂规则 `AGENTS.override.md` / 官方 pi extension） | **闭源另议**：不直接收 PR，请在 issue 里描述需求，或做成第三方扩展（开发手册第九章） |

提交一律显式路径 `git add <你的文件>`；不要 `git add -A`（库里可能躺着别人的未完成改动），
不要 force push，回退用 `git revert`。

---

有疑问先开 issue，附上你的插件骨架与疑问点；我们更愿意回答「这样写会不会撞契约」，
而不是事后拒收一整份 PR。
