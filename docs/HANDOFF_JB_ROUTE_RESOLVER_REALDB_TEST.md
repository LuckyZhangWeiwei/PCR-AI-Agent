# 真机测试任务（给 Cursor）— JB 路由收敛 resolveJbRoute

> **执行者：** Cursor Agent（有真库访问）
> **被测分支：** `feat/jb-route-resolver`（已推送 origin，未并 main）
> **背景：** 把 JB 确定性表路由收敛为单一真相源 `resolveJbRoute` + 混合(正则快路 / LLM 兜底)。spec/plan 见 `docs/superpowers/specs/2026-06-28-jb-route-resolver-design.md`、`docs/superpowers/plans/2026-06-28-jb-route-resolver.md`。
> **结论先行（给 Claude Code 回填）：** 见末尾「回传格式」。**把每一 Pass 的实际 SSE 片段 + pm2 日志关键行 + PASS/FAIL 写回 `scratchpad/realdb-jb-route-<日期>.txt` 或直接贴回对话。**

---

## 0. 这次要回答的两个问题

1. **开关关（默认）= 没改坏。** `JB_LLM_INTENT_CLASSIFIER` 未设/false 时,新代码必须与重构前**行为等价**——之前真库验过的 5/5 闭环(P-A~F)要照旧通过。**这是回归测试,最重要。**
2. **开关开 = 真能治本。** `JB_LLM_INTENT_CLASSIFIER=true` 时,口语/模糊问句应由便宜模型分类器兜底正确路由(不再误吐单 lot 表);且分类器失败(超时/403/乱码)必须**安全降级回 generic**(交回完整 LLM),不报错、不崩。

---

## 1. 部署被测分支

```bash
git fetch origin && git checkout feat/jb-route-resolver && git pull
git log --oneline -3   # 顶部应含 b3887f5(最终评审 Minor 清理)
cd pcr-ai-api && npm ci && npm run build
# 确认 .env 里 JB_LLM_INTENT_CLASSIFIER 未设或 =false(Pass A 用)
pm2 reload <进程名> && pm2 logs <进程名> --lines 5   # 确认刚 reload
```

> `<API_HOST>` = 服务器内网 IP 或 localhost;curl 走 LLM 的需服务器已配 `AGENT_API_KEY` / `SILICONFLOW_API_KEY`,否则在 body 的 `agentConfig.apiKey` 填。

---

## 2. Pass A — 开关关（回归 / 等价,必须全过）

**前提：`JB_LLM_INTENT_CLASSIFIER` 未设或 false。**

### A0. 单测 + eval（不经真库,先自证没退化）
```bash
cd pcr-ai-api && npm test && npm run typecheck
npx tsx test/eval/runEval.ts        # 期望:总计 37/37,routing 11/11,1 个 live 场景 skip
```

### A1. SQL 探针（不经 LLM）
```bash
PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-device-by-mask.ts P11C
```
**期望：** `yield/full`、`jb/full` 两段 `rowCount > 0`（与之前一致）。

### A2. 五条历史痛点真库 curl（与之前 5/5 闭环同一组,逐条对照）

| # | 多轮问句（按序,带同一 sessionId 续问） | ✅ 通过标准 |
|---|---|---|
| P-A | `P11C 最近的测试情况` | `get_filter_values(domain:both,field:device,mask:P11C)` JSON `totalDistinct>0`(含 WB01P11C) |
| P-B | ①`uflex 最近三天的测试情况` → ②`都测试了什么lot` | 第②问出 **lot 列表**,非单 lot 概况 |
| P-C | ①`9416 卡的测试情况` → ②`把这4张probecard的测试情况做对比` | 第②问**不 0.0s 秒回单 lot 卡表**;跨 9416-0x 综述;pm2 见 `[jbDeterministic/multiCardCompareBail]` |
| P-D | ①`uflex 最近三天的测试情况` → ②`哪个lot bin40最多` | 第②问出 **bin+lot 关联表** |
| P-F | ①`NF13322.1J 哪一片 wafer bin79 最多` → ②`哪个卡 哪个dut 测试出的 bin79 最多` | DUT 集中度表**只剩 BIN79**,无 BIN1/BIN55 |

curl 模板：
```bash
curl -N -X POST http://<API_HOST>:30008/api/v4/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"P11C 最近的测试情况"}],"agentConfig":{"maxRounds":5}}'
```
多轮：第二问带上同一 `sessionId`（用第一问响应里返回的 sessionId）。

**判定：A 段全部应与重构前一致。任一条与历史结果不同 → 记为回归,贴出实际 SSE + 期望差异。**

---

## 3. Pass B — 开关开（LLM 兜底是否真的接住长尾）

**改 `.env`：`JB_LLM_INTENT_CLASSIFIER=true`,然后 `pm2 reload`。**

### B0. live eval（走真模型分类器）
```bash
AGENT_EVAL_LIVE=1 npx tsx test/eval/runEval.ts
```
**期望：** routing 类含 `route-llm-fallback-colloquial` 场景**不再 skip 且 PASS**（口语「这几张卡最近咋样」**不被判 lot_overview**）。

### B1. 口语/模糊问句 开/关对照
对下列每条,**分别在开关关、开关开各发一次**(不同 session),对照回答：

| 问句 | 开关关(基线) | 开关开(期望改善) |
|---|---|---|
| `这几张卡最近咋样` | 可能答非所问/泛泛 | 不误吐单 lot 表;走跨卡综述/澄清 |
| `最近测得怎么样` | — | 合理路由(概况或澄清范围),不报错 |
| `看看这几个批次的情况` | — | 不锁单 lot;多 lot 视角或澄清 |

> 兜底是否真触发:`resolveJbRouteAsync` 默认**不打印** source。若想确证「这条走了 LLM 分类」,可临时在 `pcr-ai-api/src/lib/agent/jbRouteResolver.ts` 的 `resolveJbRouteAsync` 里、`callJbIntentClassifier` 返回后加一行
> `console.warn('[jbRoute/source]', decision-or-r.source, JSON.stringify({q, mode}))`,重启复测,**测完还原**。否则仅凭回答质量对照判断。

---

## 4. Pass C — 降级安全（开关开 + 分类器故障)

**目的：证明 LLM 分类器挂了也不会把现状搞坏。** 任选一种制造故障：
- `.env` 里把 `AGENT_API_KEY`/`SILICONFLOW_API_KEY` 临时改成无效值(造 403),或
- 断网/把 `SILICONFLOW_API_BASE` 指到不可达地址(造超时)。

`pm2 reload` 后,发一条**模糊** + 一条**明确**问句：
```
模糊：这几张卡最近咋样
明确：P11C 最近的测试情况
```
**期望：**
- 模糊问句:分类器失败 → **降级回 generic → 完整 LLM ReAct**(或正常澄清),**不**出现 500 / 未捕获异常 / 空回复崩溃。
- 明确问句(走正则快路,不依赖分类器):**照常**出表(证明快路不被分类器故障牵连)。

**测完把 key / API base 改回。**

---

## 5. 回传格式（写回给 Claude Code）

写入 `scratchpad/realdb-jb-route-<日期>.txt` 或贴回对话,包含：

```
环境：分支 commit = <git rev-parse --short HEAD>，pm2 已 reload(时间)
Pass A（开关关/回归）
  A0 单测+eval：<npm test 计数> / eval <37/37?>
  A1 探针：yield/full rowCount=__ , jb/full rowCount=__
  A2 五条：P-A __ / P-B __ / P-C __ / P-D __ / P-F __（PASS/FAIL，FAIL 贴实际 SSE 片段）
Pass B（开关开/兜底）
  B0 live eval：route-llm-fallback-colloquial = PASS/FAIL
  B1 三条 开/关对照：各贴关键回答片段 + 是否改善
  （可选）[jbRoute/source] 日志若加了，贴几行
Pass C（降级）
  模糊问句：是否降级 generic 且无崩溃 = __
  明确问句：正则快路是否照常出表 = __
总判：开关关=是否等价(无回归)？ 开关开=兜底是否有效？ 降级是否安全？
```

---

## 6. 给 Cursor 的纪律提醒

- **不改运行时逻辑**;只允许 §3 的**临时**调试 `console.warn`(测完还原)与 `.env` 开关/key 改动(测完还原)。
- 不提交 `.claude/settings.local.json`、真实 `.env`、key。
- 若 A 段出现回归 → **优先**把实际 SSE + pm2 日志(尤其 `[jbDeterministic/*]`、`[equipmentRoute/skip:*]`)贴回,不要自行猜改路由代码;路由是单一真相源 `resolveJbRoute`,回归多半在收口点透传或有序数组顺序,交回 Claude Code 定位。
