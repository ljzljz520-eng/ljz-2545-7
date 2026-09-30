async function designPage(view) {
  view.innerHTML = `<article class="design-doc">
  <h1>站内设计说明</h1>
  <p class="meta">本页是站点的一部分，说明数据模型、比较口径与边界处理，便于烘焙师与评审对齐认知。</p>

  <h2>1. 信息架构</h2>
  <ul class="clean">
    <li><b>产地 Origin</b> 与 <b>处理法 Process</b> 多对多；各自关联术语与已发布批次，从故事页可直达批次曲线。</li>
    <li><b>豆款 Product（品牌+品名）</b> 有当前批次指针 <code>current_batch_id</code>；<b>批次 Batch</b> 通过 <code>parent_id</code> 自引用形成谱系（递归 CTE 查询祖先/后代）。</li>
    <li><b>曲线 RoastCurve</b>：测量元数据在 PostgreSQL，数据本体在独立文件存储 <code>storage/curves/&lt;sha前2位&gt;/&lt;sha256&gt;.csv</code>，内容寻址去重。</li>
    <li><b>感官评语 SensoryEvaluation</b> 强制外键到量表 SensoryScale；<b>活动 Event</b> 与演示批次多对多，报名带状态与幂等键。</li>
  </ul>

  <h2>2. 为什么这些条件“不可比”</h2>
  <ul class="clean">
    <li><b>温度探头</b>：ET（环境）与 BT（豆温）响应曲线完全不同；同为 BT 而安装位置不同（豆堆中心 vs 滚筒前壁）也有系统偏差。</li>
    <li><b>采样间隔</b>：1.5s 与 5s 采样不可逐点对齐；容差设为 ≤10%，超出即判定不可比，而非静默重采样。</li>
    <li><b>时间零点</b>：下豆 / 烘焙开始 / 回温点 / 一爆是不同锚点。零点不同只允许叠加<b>查看</b>（图顶有警告），不计算时刻差值。</li>
    <li><b>温度单位</b>：°C/°F 必须一致；上传时做量纲合理性检查（声明 °C 却出现 &gt;260 的数值判为疑似华氏）。</li>
    <li><b>缺测</b>：连续 ≤2 点缺口才在图上以<b>虚线插值显示</b>，并逐点打 <code>interpolated</code> 标记；长缺测保留空段，不填补、不参与比较。</li>
    <li><b>感官量表</b>：SCA 百分制、店内 5 分制、WCR 10 分制口径不同，严格分组、组内排名；不提供跨量表混合排名。</li>
  </ul>

  <h2>3. 两种比较模式的区别</h2>
  <div class="flow">
    <span class="step">按批次筛选：选具体批次 → 取每批最新“已验收”曲线 → 逐对检查</span>
  </div>
  <div class="flow">
    <span class="step">按豆款汇总：选豆款 → 展开其全部批次曲线 → 批对批检查并列出元数据表</span>
  </div>
  <p>汇总模式不做跨批平均：<b>豆款换批后旧曲线仍绑定原批</b>；品牌同名（甚至品牌+品名相同）也不被当作实验条件相同的依据——条件以每条曲线记录的探头/位置/间隔/零点元数据为准。</p>

  <h2>4. 批次生命周期与活动联动</h2>
  <ul class="clean">
    <li>批次：<code>draft → published → withdrawn</code>。发布前置条件是至少一条 <code>accepted</code> 曲线。</li>
    <li>曲线验收：<code>pending → accepted / needs_fix / rejected</code>。量纲可疑或缺测/数值异常默认 <code>needs_fix</code>；可疑量纲禁止直接接受，须修正文件或带 <code>override</code> 人工豁免留痕。</li>
    <li><b>曲线晚到</b>：已发布批次后补录的曲线 <code>is_late=true</code>，状态 <code>needs_fix</code>，验收后才成为依据，不回写篡改历史结论。</li>
    <li><b>撤回联动</b>：批次下架时，引用它的活动把已确认报名批量转为 <code>pending_confirmation</code>，并写事件日志；绝不静默取消。重新上架后，积压报名仍需人工确认（不自动恢复）。</li>
    <li>名额 = capacity −（registered + pending_confirmation），待确认也占位，避免库存波动期间超卖。</li>
    <li>报名重送：同活动 + 同 <code>idempotency_key</code> 视为同一次提交（更新信息、不新建名额），日志记录 resend。</li>
  </ul>

  <h2>5. 可追溯性</h2>
  <ul class="clean">
    <li>每次下载返回原始 CSV，并在响应头附带 <code>X-Source-SHA256</code>、批次号、探头、采样间隔、零点、单位、接收时间。</li>
    <li>文件按内容哈希独立存储：元数据删除不会立即销毁原文件；相同上传去重，避免“复制一份假装新曲线”。</li>
    <li>下架批次的历史链接保持只读可访问，页面显著标注撤回状态。</li>
  </ul>

  <h2>6. 技术与原创性说明</h2>
  <ul class="clean">
    <li>后端 Node.js + Express，数据库 PostgreSQL（JSONB 存缺口窗口/通道元数据，递归 CTE 存谱系），无外部图表库：曲线用原生 Canvas 绘制，空段/虚线插值/零点警告均为自绘。</li>
    <li>界面为原创咖啡色系设计（espresso/crema/caramel），手写组件与路由（hash router）。</li>
    <li>演示数据刻意覆盖：探头位置换、采样间隔换、零点换、长缺测、量纲错误、晚到曲线、下架批次、同品牌换批、跨量表评语、库存撤回报名。</li>
  </ul>

  <h2>7. 明确不做的事</h2>
  <ul class="clean">
    <li>不对长缺测做任何“智能补全”；不跨零点计算具体时刻差；不跨量表排名。</li>
    <li>不因为豆款同名而合并曲线；不在批次撤回后删除历史页或静默取消报名。</li>
  </ul>
  </article>`;
}
