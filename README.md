# ☕ 山脊烘焙故事站 · Roast Story Station

一个把“**烘焙数据可比较性**”当作一等公民的咖啡故事站：产地与处理法页面关联批次曲线、术语与活动；
后台管理批次谱系与发布；**PostgreSQL 保存测量元数据与感官评语，曲线测点文件独立存储**。

## 为什么不直接把曲线叠在一起？

烘焙曲线只有在测量条件一致时才可比较。本站对每次比较执行显式的**可比条件检查**：

| 维度 | 不一致时的处理 |
|---|---|
| 温度探头型号 / 位置 | **BLOCK**：系统偏差未知，不叠合、不排名，逐项解释 |
| 采样间隔 | **WARN**：最近邻重采样到公共时间网格（**不插值**），图上标注“重采样” |
| 时间零点（下锅/回温点/一爆） | **BLOCK**：横轴原点不同，无法对齐 |
| 温度量纲 °C/°F | **WARN**：统一换算 °C（原始单位保留）；量纲错误（如 °F 数值伪装 °C）上传即**拒收** |
| 长缺测（>2 个采样点） | **永不插值**，曲线按缺口分段；共同覆盖度 <50% 判不可比 |
| 感官评分量表 | SCA 百分制 / 店内 10 分制 / 5 星**绝不混排**，仅同量表内排名 |

另有两条领域铁律：

- **豆款（品牌 SKU）≠ 批次**：豆款换批后，旧曲线仍绑定原批，不会迁移；品牌同名不视为实验条件相同。
- 比较提供两种入口：**按批次筛选**（逐曲线检查）与**按产品汇总**（自动展开到批次再下钻），不可比项给出人可读解释。

## 活动名额联动

- 有效名额 = min(活动场地名额, Σ 关联演示批次当前可供份数)。
- 库存撤回：已确认且超容的席位**保留并标注请联系确认**；未处理报名一律进入 `pending_confirmation`（**需确认，绝不静默取消**）。
- 报名使用 `idempotency_key`：网络重送/重复点击返回同一条记录，不重复占座。

## 验收场景（均有自动化测试覆盖）

1. **验收曲线晚到**：批次发布后仍可补挂 `acceptance` 曲线，永久属于原批次。
2. **量纲错误**：通道单位冲突 / 数值超物理范围 / 声明采样间隔与时间戳不符 → 422 拒收，文件原样留档 `storage/curves/rejected/`。
3. **下架批次历史链接**：公开页仍可访问且显著标注，保留全部曲线与谱系，但不进入新比较/活动候选。
4. **报名重送**：幂等去重，不产生第二条记录。
5. **下载可追原数据**：原始文件与批次 bundle（全部原始曲线 base64 + 元数据 + 评语 + 谱系）均写 `download_log`，响应头带 sha256；bundle 自身也落盘并记录哈希。

## 技术栈

- Node.js + Express，零前端框架（hash 路由 + 原生 SVG 曲线图，界面与图表均原创）。
- PostgreSQL：默认使用嵌入式 **PGlite**（真实 Postgres 引擎，数据在 `.pglite/`）；
  设置环境变量 `DATABASE_URL` 即切换到外部 PostgreSQL，业务代码不变。
- 曲线文件存 `storage/curves/<batchId>/`（.json/.csv），数据库只存测量元数据。

## 快速开始

```bash
npm install
npm run initdb          # 建表
npm run seed            # 写入演示数据（含各种可比/不可比场景）
npm start               # http://localhost:3000
# 管理员登录（后台 → 管理）：默认密码 roast-admin，可用 ADMIN_PASSWORD 覆盖
```

其他命令：

```bash
npm run reset           # 清空重建 + 重新播种
npm test                # 端到端验收测试（62 项断言，HTTP 黑盒）
node test/dom-smoke.js  # 前端资源/关键逻辑冒烟
```

连接外部 PostgreSQL：

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/roast npm run initdb
DATABASE_URL=postgres://user:pass@localhost:5432/roast npm start
```

## 曲线文件格式

JSON（也支持 CSV，首列 `time_s`，通道列形如 `bean_temp[C]`）：

```json
{
  "metadata": {
    "probe_model": "Phidget PT100",
    "probe_position": "bean",
    "temp_unit": "C",
    "sample_interval_s": 1,
    "time_zero": "charge"
  },
  "time_s": [0, 1, 2],
  "channels": {
    "bean_temp": { "unit": "C", "values": [196.0, 195.4, 195.8] },
    "gas": { "unit": "%", "values": [100, 100, 99] }
  }
}
```

缺测用 `null`；≤2 点短缺口仅在展示时插值（空心点标注），长缺口永不插值。

## 主要 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/origins/:slug` `/api/processes/:slug` | 产地/处理法：批次曲线、术语、活动联动 |
| GET | `/api/batches/:slug` | 批次详情、谱系、曲线元数据、评语（下架可访问） |
| GET | `/api/curves/:id/points` | 从文件读取测点（不入库） |
| GET | `/api/compare/batches?ids=1,2` | 按批次可比检查 |
| GET | `/api/compare/products?ids=1,2` | 按产品汇总比较 |
| POST | `/api/events/:slug/register` | 报名（幂等键） |
| GET | `/api/curves/:id/download` | 原始曲线（sha256 + 审计） |
| GET | `/api/batches/:slug/bundle` | 打包原始数据下载 |
| POST | `/api/admin/login` | 管理员登录 |
| POST | `/api/admin/batches` `/…/lineage` `/…/publish` `/…/delist` | 批次谱系与发布 |
| POST | `/api/admin/batches/:id/curves` | 上传曲线（量纲/间隔校验，验收晚到可补挂） |
| POST | `/api/admin/batches/:id/reviews` | 感官评语（必带量表） |
| POST | `/api/admin/events/:id/withdraw` | 库存撤回并联动报名 |

站内设计说明见站点页脚「站内设计说明」（`#/design`）。

## 目录结构

```
src/
  server.js            Express 路由（公共 + 管理 + 下载审计）
  db.js                PG/PGlite 统一查询层
  schema.sql           PostgreSQL 结构
  lib/curves.js        曲线解析/量纲校验/缺测处理/文件存储
  lib/comparability.js 可比条件引擎（批次 & 产品两种模式）
  lib/events.js        名额联动 / 撤回 / 幂等报名
scripts/initdb.js seed.js
public/                原创前端（index.html / styles.css / app.js）
storage/curves/        曲线文件（rejected/ 子目录留档）
storage/bundles/       打包下载落盘
test/e2e.js            端到端验收
```
