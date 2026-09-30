# 烘焙故事站 Roast Story Station

咖啡烘焙故事站：产地/处理法故事页关联批次曲线、术语与活动；后台管理批次谱系、发布与撤回；
PostgreSQL 保存测量元数据与感官评语，曲线文件按 SHA-256 独立内容存储。
比较豆子时对温度探头、采样间隔、时间零点做可比条件检查，长缺测不填补，感官评分跨量表不混排。

## 快速开始（本沙箱，Debian arm64 无 root）

便携 PostgreSQL 已解压到 `/tmp/pglocal`、数据目录 `/tmp/pgdata`（端口 5439）：

```bash
./scripts-dev-start.sh        # initdb(如需) + 启动 PG + migrate + seed + API
# 或分步：
node server/src/migrate.js
node server/src/seed.js
node server/src/index.js       # http://127.0.0.1:3000
```

标准环境（自有 PostgreSQL）用环境变量覆盖：

```bash
PGHOST=... PGPORT=5432 PGUSER=... PGPASSWORD=... PGDATABASE=roaststory \
  node server/src/migrate.js && node server/src/seed.js && npm start
```

后台演示账号：`admin / roast2026`（页面右上「后台」）。

## 验收测试

```bash
npm test          # 先重置种子，再跑 45 项端到端断言（需要服务器在 3000）
```

覆盖：谱系、可比/不可比检查、按产品汇总、长缺测不插值、短缺口显示插值、
跨量表不排名、发布前置、量纲错误拦截/override 留痕、曲线晚到、
库存撤回→报名转待确认、报名重送幂等、下架历史链接、下载 sha256 追溯头、无演示批次报名关闭。

后台「验收演练」页提供同序列的可视化一键演练。

## 页面

| 路由 | 内容 |
| --- | --- |
| `#/` | 产地、处理法、入口 |
| `#/origin/:slug` / `#/process/:slug` | 故事 + 术语 + 关联批次曲线 + 相关活动 |
| `#/products` / `#/product/:id` / `#/batch/:id` | 豆款、批次谱系、曲线（缺测/插值标识）、感官评语、原始下载 |
| `#/compare` | 按批次筛选 / 按豆款汇总；可比检查与不可比项解释；感官分量表排名 |
| `#/events` / `#/event/:id` | 名额×演示批次联动、报名（幂等重送） |
| `#/glossary` | 术语 |
| `#/admin/*` | 批次谱系/发布/撤回、曲线提交与验收、感官录入、活动与报名、验收演练 |
| `#/design` | 站内设计说明（口径、模型、边界） |

## 关键口径（摘要）

- 曲线 CSV 列：`time_s,et_c,bt_c`（缺测留空或 `na`）。连续缺测 **≤2 点**仅在前端**虚线显示插值**并逐点标记；
  更长的缺口保留空段、不参与任何比较。
- 比较硬性条件：探头类型+位置相同、采样间隔差 ≤10%、时间零点相同、温度单位相同；
  零点不同只允许叠加查看（图顶警告），不做时刻差。
- 感官按量表分组，组内排名；SCA 百分制/5 分制/10 分制绝不混排。
- 豆款换批：`products.current_batch_id` 换指针；曲线外键始终指向**原批次**，不迁移。
- 撤回：`batches.status='withdrawn'`，历史链接只读保留；关联活动的已确认报名 → `pending_confirmation`
  （占位防超卖，写事件日志），重发后仍需人工确认。
- 下载：原始 CSV + `X-Source-SHA256` 等测量元数据响应头，可追到原数据。

## 技术栈

Node.js 20 + Express + `pg`；PostgreSQL 15（递归 CTE 谱系、JSONB 缺口/元数据）；
前端无框架、无图表库——手写 hash router、组件与 Canvas 曲线；曲线独立文件存储 `storage/curves/`。
