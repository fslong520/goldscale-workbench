# 金秤插件目录

> 这里是插件索引：官方插件（随产品发布）+ 社区插件（你投稿，我登记）。
> 开发入门见 [`plugin-development.md`](plugin-development.md)，贡献规范见
> [`../CONTRIBUTING.md`](../CONTRIBUTING.md)。
>
> 字段口径与 `manifest.json` 一致（见开发手册第三章）。本表 `order`、`title`、`desc` 取自
> 各插件 `plugins/<name>/manifest.json` 真值；`version`/`author`/`homepage` 官方四件
> **尚未声明**（`—`）——加载器只核 `title`/`order`，这三个字段由设置页插件管理器读取，
> 补写时会同步本表。

## 一、官方插件

| name | title | order | version | author | 说明 | homepage |
| --- | --- | --- | --- | --- | --- | --- |
| `overview` | 总览 | 5 | — | — | 驾驶舱首页：现货价、账户概览、生效策略与最新 AI 研判、最近平仓、功能快捷入口 | — |
| `hello` | 示例插件 | 90 | — | — | 插件机制活模板：新建目录 + 登记注册表，产品就多一个页面 | — |
| `gold-glance` | 金价速览 | 100 | — | — | 实时现货金价、白银价与金银比，含数据更新时间与新鲜度 | — |
| `behavior-review` | 行为周报 | 110 | — | — | 把记忆里的亏损归因与近期平仓摊开成本周/本月行为报告：亏损笔数、错误词频、总盈亏、胜率，并可让 AI 用大白话总结 TOP 错误与一条下周纪律 | — |

`order` 只决定插件之间的先后；**所有插件一律排在内置页之后**（`js/app.js:89`）。
官方插件的源码就在 `plugins/<name>/`，结构讲解见开发手册第十章：
`hello` = 最小骨架，`gold-glance` = 单接口消费，`overview` = 多接口聚合卡片网格，
`behavior-review` = 记忆 + AI 组合。

## 二、社区插件

| name | title | version | author | 说明 | homepage | 安装 |
| --- | --- | --- | --- | --- | --- | --- |
| （空位，等你） | | | | | | |

社区插件按投稿顺序登记；状态一栏标明是否已在官方仓内。表格暂无内容不代表生态空无一人，
只是你还没来投。

### 投稿方式

1. Fork 本仓，把插件目录放进 `plugins/<name>/`（`manifest.json` + `index.js`，规范见
   [`../CONTRIBUTING.md`](../CONTRIBUTING.md)）；
2. 在设置页导出 `.gsp`，随 PR 一并附上（便于核验打包后的文件清单）；
3. 在上表加一行（name 用反引号包住，字段照 manifest 填真值）；
4. 提 PR。审查要点：`node --check` 通过、`manifest` 必填字段齐、无外联上报、故障隔离自测过。

### 安装第三方插件

- **推荐**：设置页 → 插件管理 → 「导入 .gsp」——写盘 `plugins/<name>/` 并自动改写
  `plugins/index.json` 登记；同名插件再导入即覆盖升级（旧目录先备份为
  `plugins/<name>.bak-<时间戳>`）。包内硬约束见 [`plugin-development.md`](plugin-development.md) 第八章。
- **手工**：把目录放进 `plugins/<name>/`，在 `plugins/index.json` 的 `plugins` 数组登记
  `{"name": "<name>", "order": 120}`（可选 `"enabled": false` 停用），硬刷新（`Ctrl+Shift+R`）。
- **管理**：插件管理页可启停、删除、导出复刻（导出即读目录拼回 `.gsp`），并显示加载失败原因
  与 `min_app` 不满足（本机版本过低）的警示。

> **安全声明**：插件是**可执行前端代码**，装进浏览器后能读你的持仓、能调 AI 接口、能发网络
> 请求。与 Minecraft 装 mod 同理——**只装可信来源**；装前可以打开 `index.js` 读一遍，它不是
> 二进制，读得懂。官方插件随产品源码发布、可评审；第三方插件由作者负责，风险自负。
