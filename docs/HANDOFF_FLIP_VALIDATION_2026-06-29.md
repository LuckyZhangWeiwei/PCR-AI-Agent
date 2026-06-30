# 交接:真库验证 + FLIP 决策(给 Cursor，2026-06-29)

> **执行者：Cursor（真实 Oracle 环境）。** Claude 在无库沙箱完成了全部代码 + dark-launch，
> 但两个质量开关**默认 OFF**，本环境跑不了真 LLM/真库。请在真库做以下验证，并按 §5 把结果回给 Claude。

---

## 0. TL;DR

- 已建成（全部藏开关后，默认 OFF，生产行为零变更）：
  - **阶段二** `JB_LLM_INTENT_CLASSIFIER`：语义路由（渲染/bail 收敛到单一决策 `classifyJbIntent`）。
  - **阶段三** `JB_DETERMINISTIC_DISPATCH`：高置信跨实体问句在 **LLM 之前**服务端直发查询，根治 turn1 选错工具。
- **要你做两件事**：
  - **Test A（优先）**：开 `JB_DETERMINISTIC_DISPATCH`，真库手测 turn1 是否被根治 + 不误伤其它问句。
  - **Test B（其次）**：`AGENT_EVAL_LIVE=1` 跑 live eval 拿误分类率；可选开 `JB_LLM_INTENT_CLASSIFIER` 对比长尾。
- **目标**：决定这两个开关能不能 FLIP（翻默认开）来真正提升回答质量。**Claude 不翻开关，由你/用户根据本验证决定。**

相关文档：
- spec：`docs/superpowers/specs/2026-06-29-jb-deterministic-dispatch-design.md`、`…-jb-semantic-router-design.md`
- plan：`docs/superpowers/plans/2026-06-29-jb-deterministic-dispatch.md`、`…-jb-semantic-router.md`
- DEV_LOG / TODO：见顶部「阶段三」「FLIP」条目。

---

## 1. 前置检查（重要，先做）

1. **真 Thick / 真库**：确认 `db/ping` 正常、不是 Thin 的 NJS-116（否则 `runTool` 取数会失败，派发路径无法验证）。
2. **API key**：`AGENT_API_KEY`（或 `SILICONFLOW_API_KEY`）+ `AGENT_SUBAGENT_MODEL` 已配，Agent 能正常出中文结论。
3. **⚠️ flag 是否真传进了运行进程（最易踩坑）**：生产走 `dist + pm2`，`ecosystem.config.cjs` 只把**白名单 env 键**合并进 PM2 子进程。请确认 `JB_DETERMINISTIC_DISPATCH` 和 `JB_LLM_INTENT_CLASSIFIER` 在该透传白名单里；**若不在，光改 `.env` 不生效**——需把这两个键加进 `ecosystem.config.cjs` 的透传列表，再 reload。验证办法：在路由里临时 `console.log(process.env.JB_DETERMINISTIC_DISPATCH)`，或确认 reload 后行为确实变化。
4. 代码读取逻辑：`JB_DETERMINISTIC_DISPATCH !== "true"` 即视为关；只有精确等于字符串 `"true"` 才开。

---

## 2. Test A — 阶段三确定性派发（优先，直接验 turn1 根治）

**只开 `JB_DETERMINISTIC_DISPATCH`，`JB_LLM_INTENT_CLASSIFIER` 仍关**（这样派发走纯正则、不引入新的 LLM 抖动，最干净）。

### A0. 基线复现（开关全关，先拍一张「病态」照片）
确保两个开关都关、reload。**新开聊天**，逐条提问并记录：
| # | 问句 | 记录什么 |
|---|---|---|
| A0-1 | `n55z 哪个卡测出bin35 多` | **首轮**调了哪个工具？回复是「单 lot 概况/逐片表」(病) 还是「BIN×探针卡 表」(好)？贴回复前 20 行 |

> 预期基线：首轮可能调 `query_jb_bins` 出单 lot 表 = 所答非所问（即用户报的 bug）。也可能偶发正常（模型抖动）。如实记录。

### A1. 开派发后复测
设 `JB_DETERMINISTIC_DISPATCH=true`、reload。**每条都新开聊天**（避免历史污染），记录「首轮工具 + 回复前 20 行 + 是否 BIN×卡表」：

| # | 问句 | 期望 |
|---|---|---|
| A1-1 | `n55z 哪个卡测出bin35 多` | **首轮**直发 `aggregate_jb_bins(mask:N55Z, groupBy:bin,cardId)` → 直出 **BIN×探针卡** 表 |
| A1-2 | `BIN35 集中在哪张卡` | 同上（BIN×卡 表） |
| A1-3 | `各探针卡 BIN35 颗数对比` | BIN×卡 表（这条正则未必命中→可能落 LLM，记录实际） |
| A1-4 | `WC13N55Z 各 lot 良率 top5` | 派发 `query_jb_bins` → lot 良率排名表（mask/device 兜底） |
| A1-5 | `这两张卡哪张良率更差`（先给两张真卡号或带 device） | card 良率对比表 |

### A2. 不误伤（回归）—— 确认派发**没抢**不该抢的问句
仍开 `JB_DETERMINISTIC_DISPATCH=true`，新开聊天逐条问，确认行为与「关」时**一致**（这些不在 3 个派发 mode 内，应照旧走原路由/LLM）：

| # | 问句 | 期望 |
|---|---|---|
| A2-1 | `<真实lot号> 概况` | 单 lot 概况表照旧（lot_overview 路由，不被新派发劫持） |
| A2-2 | `<真实lot号> 第3片 wafermap 画出来` | 晶圆图照旧 |
| A2-3 | `<真实device> 总的坏die` | 跨 lot 坏 bin 汇总照旧 |
| A2-4 | 一句**查不到数据**的派发类问句（如不存在的 mask `哪个卡测出bin99多`） | 应**优雅落回 LLM**说明无数据，**不**卡死/不空白 |

### A3. 体感
- 派发是否更快（少一轮 LLM 选工具）？大概省多少秒？
- 有没有任何 Oracle 报错 / 异常 / 空表（尤其 A1-4/A1-5 的 `query_jb_bins` 派发路径，这条 CI 没覆盖过）？

---

## 3. Test B — 阶段二语义路由（其次，验长尾 + 误分类率）

### B1. live eval 误分类率（决定阶段二能否 FLIP 的硬指标）
```bash
cd pcr-ai-api
AGENT_EVAL_LIVE=1 AGENT_API_KEY=<key> AGENT_SUBAGENT_MODEL=<model> \
  npx tsx --test test/agentEval.test.ts
```
记录：
- 「混合路由零 mode 回退」live 测试结果（pass/fail）；
- 「误分类率 ≤ 2%」live 测试结果 + **实际误分类率数字** + **回退/误分类的问句清单**（assert 失败信息里会列出）。
- 「纯正则 baseline 零回退」CI 测试是否仍绿。

### B2.（可选）开分类器对比长尾
设 `JB_LLM_INTENT_CLASSIFIER=true`、reload，新开聊天问几条**口语/同义**问法（正则接不住、LLM 该接住的），与关时对比路由是否更准：
- `各张探针卡 bin8 分布怎么样`
- `近期哪几批良率掉得厉害`
- `哪片卡 bin35 出得最多`
记录开/关各自的回复是否答到点上。注意：开分类器会**加一次 LLM 调用**，留意延迟。

---

## 4. FLIP 判据（你据此决定翻不翻）

- **阶段三可 FLIP** 当：A1 核心句（A1-1/2）首轮稳定直出 BIN×卡 表，且 A2 全部无误伤、无 Oracle 报错。
- **阶段二可 FLIP** 当：B1 误分类率 ≤2% 且 baseline 零回退，且 B2 长尾确有改善、延迟可接受。
- 任一项不达标 → 该开关**保持 OFF**，把现象回报 Claude 调整。两个开关相互独立，可只翻其一。

---

## 5. 请回报给 Claude 的信息（按此结构）

1. **前置**：Thick/真库 OK？flag 透传确认过没（§1.3）？
2. **Test A**：A0/A1/A2 每条的【首轮工具 + 回复前若干行 + 是否符合期望】；A3 体感（速度/报错）。**尤其 A1-1 开关前后的对比** + **A1-4/A1-5 的 query_jb_bins 派发有没有出错**。
3. **Test B**：B1 的三项结果 + 实际误分类率数字 + 误分类问句清单；（若做了 B2）开/关对比。
4. **你的判断**：阶段三 / 阶段二 各建议 FLIP 还是再等？为什么？
5. **任何异常**：报错栈、空表、卡死、延迟异常、或答非所问的新案例（贴问句 + 回复）——这些是 Claude 下一轮修的输入。

> 把第 5 点里任何「新的答非所问案例」原样贴回，Claude 会把它标注进黄金集（`test/eval/scenarios/routing-golden.ts`），走"加 case → eval → 修 → 闸门防回退"的闭环，而不是临时打补丁。

---

## 6. 安全提醒

- 这两个开关**秒回退**：改回 `false` + reload 即恢复今天行为，无数据风险（纯只读 GET + 路由层）。
- 不要在未确认 §1.3（flag 透传）前就下「无效果」结论——很可能是 flag 没进进程。
- Claude 端不翻开关；FLIP 是真库验证通过后由你/用户执行的独立 commit。
