# Agent 回答质量评测台

把 agent 的"回答质量"从一次性轶事变成**可累积、可回归的分数**。每改一步(Prompt 精简、加规则、改路由)前后各跑一次,直接看分数变化,避免按下葫芦浮起瓢。

## 跑分

```bash
npm run agent:eval              # 确定性评分表(零成本、零网络)
AGENT_EVAL_LIVE=1 npm run agent:eval   # 额外跑真实大模型层(需 API key)
```

确定性场景**同时**进 `npm test`(见 `test/agentEval.test.ts`)——质量回归会直接让 CI 红。

## 四类痛点

| 类别 | 测什么 | 断言的确定性函数 |
| --- | --- | --- |
| `routing` | 路由/scope 推断:意图分类、pending 工具、时间窗继承 | `classifyIntent` / `detectPendingQuery` / `buildJbScopeArgs` / `canRun*Route` |
| `factcheck` | 防幻觉:编造 lot/卡号/良率、跨域张冠李戴 | `buildFactSheetFromHistory` + `factCheckSummaryText` |
| `summary` | 确定性总结分流:问题→回复模式映射对不对 | `isTesterMachineQuestion` / `isProbeCardQuestion` / `isLotListingQuestion` … |
| `empty` | 空结果识别 + 不过早强制总结 | `isLastToolEmptyResult` / `historyAwaitingToolSummary` |

## 加一个场景(标准动作)

发现一个"它老答不好"的 case 时:

1. 在 `scenarios/<类别>.scenarios.ts` 里加一个 `EvalScenario`,`run()` 调真实函数并断言**正确**行为。
2. 先跑 `npm run agent:eval` 看它**红**(证明确实有问题)。
3. 改代码,直到它**绿**。这个场景从此永久守住。

```ts
{
  id: "kebab-唯一-id",
  category: "routing",
  title: "一句话说明什么是正确的",
  seed: "来源:session-log id / bug commit / 痛点",   // 可选,保持可追溯
  run: () => expectEqual(classifyIntent("……"), "platform_query", "intent"),
}
```

断言工具在 `evalTypes.ts`:`expectEqual` / `expectTrue` / `expectFalse` / `expectContainsAll` / `expectExcludesAll`,或直接返回 `{ pass, detail }`。

## 原则

- **会话日志是输入,不是标准答案**:`session-logs/` 里记录的是 agent **当时**的输出(可能本身就是错的)。我们用它的**问题**做种子,但**正确**由领域规则定义。
- **确定性优先**:绝大多数痛点(路由、字段完整、防幻觉)落在确定性代码里,不调大模型就能精确断言;大模型那两段叙述用可选 live 层做属性检查。
- **纯净**:确定性场景内联固定工具 JSON,不碰 Oracle/dummy,完全可复现。
