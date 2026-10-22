# 真实 MCP 接入

服务：`https://mcp.mcd.cn`，Streamable HTTP，Bearer `MCD_MCP_TOKEN`。客户端以 `initialize` 协商协议、发送 initialized 通知、分页读取 `tools/list`，处理 JSON 与 SSE。只使用下列白名单工具；参数按服务实时 schema 检查，HTTP/业务失败停止该调用，不自动重复业务操作。

| Tool | 实际用途 |
|---|---|
| now-time-info | 判断官方日期，辅助活动时效 |
| query-nearby-stores | 根据城市地标查门店和预约营业时段 |
| query-meals | 获取门店/时段可售菜单和上新标签 |
| query-meal-detail | 确认真实套餐轮次、默认选择和允许替换项 |
| query-store-coupons | 内存中筛选当前门店、当前账户可匹配顶层商品的券 |
| calculate-price | 核算原餐及仅换一项后的整单实付金额；比较套餐、验证过的同份量单点路径和单券 |
| campaign-calendar | 展示当日活动/预告；精确出现候选名称的当日活动关联到候选 |
| list-nutrition-foods | 解析官方 TOON/CSV 营养表，按完整名称和份量精确累计 |

所有价格计算均用返回的整数分 `data.price`；不是菜单 `currentPrice`。原餐也会比较相同内容的可验证购买路径，差价不会刻意用贵的基线放大“省钱”。每次固定主食等未选中轮次，保留默认特调参数；商品券仅绑定明确匹配的顶层商品。对照卡中的差额是两份整餐应付价差，不是优惠券金额。

券标识和原始账户返回不落盘、不进网页或公开证据。仅输出券标题、核价路径和金额。公开历史记录中的核价属于测试时点，不代表其他账户优惠。未使用订单历史、支付、创建/取消订单、领券或抽奖。

营养缺失、名称/份量不符、重复记录冲突或额外糖奶无法核实时，整餐营养对应项为 null。未知营养单独展示，不能通过热量上限筛选。没有官方上新标签的普通替换不能被包装为官方新品。

## 本地调用示例

在真实查询结果中选择编码，再构建 JSON。以下仅为 2026-10-22 的测试参数，未来日期/供给需重新查询：

```json
{
  "context": {"storeCode":"1450713","reservationDate":"2026-10-22 12:00"},
  "baseCode":"9900005453",
  "baselineCodes":["1450","4810","3050"],
  "swapRound":"2",
  "constraints":{"maxExtraCents":500,"maxTotalCents":3500,"maxKcal":700}
}
```

`node scripts/cli.mjs plan request.json`。临时文件不含 Token。查询返回 `mode: live`、报价时间、覆盖范围、候选排除原因及仅含工具名/耗时/成功状态的 audit。

## 本机服务

`GET /api/bootstrap` 建立 HttpOnly、SameSite=Strict 会话并获取 CSRF nonce；POST 的门店/菜单/原餐/计划接口必须同源及携带 nonce。每个会话独立 Planner，菜单十分钟失效，会话一小时失效，请求限 16KiB，拒绝并发修改同一会话。Host 限制本机，静态文件白名单，不提供任意工具代理或 Token 输入接口。CSP 禁止外部脚本与嵌入。

这是本地个人工具，不是多租户生产系统；凭证由运行进程持有。公开分享的是无账户标识的对照卡，不是可复用账户会话。网络异常、401/429、工具错误、格式变化或核价失败都会显式反馈；部分辅助数据失败时说明降级，不编造替代数据。
