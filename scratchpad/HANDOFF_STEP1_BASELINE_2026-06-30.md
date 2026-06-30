# 步骤 1 · 基线验证交接（给 Claude Code · 2026-06-30）

> **执行者：** Cursor Agent（应用户请求）  
> **背景：** 用户已将正式 `.env` 调整为基线（`JB_LLM_INTENT_CLASSIFIER=false` 或删行；`JB_DETERMINISTIC_DISPATCH` 未配置 = 关）  
> **详细 SSE 日志：** [`step1-baseline-2026-06-30.txt`](step1-baseline-2026-06-30.txt)

---

## 0. 一眼结论

| 层 | 结果 |
|---|---|
| 本地 `npm test` | ✅ 433 / 429 pass / 0 fail / 4 skip |
| 本地 `npm run agent:eval` | ✅ 37/37（100%） |
| 远程 `/health` + `/api/v3/db/ping` | ✅ 200，`dual.OK=1` |
| 远程 SSE `verify-handoff-steps.mjs all` | ✅ **5/5 PASS**（P-A～P-F） |

**基线（两 JB 开关均关）在真库 + Agent SSE 上闭环通过。** 可进入步骤 2：仅开 `JB_DETERMINISTIC_DISPATCH=true` 做 FLIP Test A。

---

## 1. 环境与开关状态

| 项 | 值 |
|---|---|
| 远程 API | `http://10.192.130.89:30008` |
| `/health` | `agentEnabled=true`, `agentJbDeterministicSummary=true`, `agentJbCacheVersion=6` |
| Oracle | `GET /api/v3/db/ping` → `ok:true`, `dual.OK=1` |
| **JB 开关（用户确认）** | `JB_LLM_INTENT_CLASSIFIER=false`（或已删行）；`JB_DETERMINISTIC_DISPATCH` 未写（= 关） |
| 验证时间（UTC） | 2026-06-30T11:52～12:10 |
| 脚本耗时 | ~17.9 min（5 场景 × LLM 多轮） |

---

## 2. 本地回归（Cursor 本机）

```bash
cd pcr-ai-api
npm test          # 429 pass / 0 fail
npm run agent:eval  # 37/37
```

Agent 相关：`agentEval.test.ts`（含阶段三派发 CI）、`agentJbDeterministicReply.test.ts`、`jbRouteResolver.test.ts` 等均绿。  
Live eval 未跑（需 `AGENT_EVAL_LIVE=1` + key，留步骤 2/3）。

---

## 3. 远程 SSE 严格复验（`verify-handoff-steps.mjs all`）

命令：

```bash
cd pcr-ai-api
VERIFY_OUT=../scratchpad/step1-baseline-2026-06-30.txt \
  node scripts/verify-handoff-steps.mjs all
```

| ID | Session | 判定 | 要点 |
|---|---|---|---|
| **P-A** | `v-f29c5f6f-…` | ✅ PASS | `get_filter_values` mask P11C → `totalDistinct=3`（WB01P11C 等） |
| **P-B** | `pb-8b3a6500-…` | ✅ PASS | `uflex 最近三天` → `都测试了什么lot` → ~50 lot 列表（非单 lot 逐片） |
| **P-C** | `pc-96905937-…` | ✅ PASS | 多卡对比 → 9416-01/02/03/04 跨卡 YM+JB 综述（非单 lot equipment 表） |
| **P-D** | `pd-1cd34b9f-…` | ✅ PASS | `哪个lot bin40最多` → lot+BIN40 排行表（非仅 BIN 无 lot） |
| **P-F** | `pf-6bdd0b5e-…` | ✅ PASS | `query_lot_dut_bin_agg` 集中度表仅 BIN79，无 BIN1/BIN55 |

**Summary: 5/5 passed**

---

## 4. 给 Claude Code 的下一步建议

1. **步骤 2（Test A）**：用户改 `.env` 为 `JB_DETERMINISTIC_DISPATCH=true`，`JB_LLM_INTENT_CLASSIFIER=false`，`pm2 reload` 后复跑：
   - `verify-handoff-steps.mjs` 中 P-B/P-C 仍应 PASS；
   - 额外手测 FLIP doc A1-1/A1-2（`n55z 哪个卡测出bin35 多`）期望 **首轮** `aggregate_jb_bins(groupBy:bin,cardId)` → BIN×卡表。
2. **A2 不误伤**：单 lot 概况 / wafermap / 跨 lot 坏 die 仍走原路由。
3. **阶段二 FLIP**：基线未开分类器；步骤 3 再测 `JB_LLM_INTENT_CLASSIFIER=true` + `AGENT_EVAL_LIVE=1`。
4. **ecosystem 透传（可选）**：`JB_*` 未在 `ecosystem.config.cjs` 白名单，但 `loadEnv.ts` 会从 `pcr-ai-api/.env` 直读，当前验证有效。若 PM2 仅依赖透传、不读磁盘 `.env`，需把两键加入 `ORACLE_FORWARD_KEYS`。

---

## 5. 异常 / 阻塞

无。SiliconFlow / Oracle / Agent 均正常；无 403 余额、无 CONFIG_ERROR。

---

## 6. 附件

- 完整 excerpt：[`scratchpad/step1-baseline-2026-06-30.txt`](step1-baseline-2026-06-30.txt)
