# PCR AI Agent 功能测试提问集

> 直接复制粘贴到 AI Agent 对话框即可。
>
> **Excel 测试数据说明（Dummy 模式）**
> | 数据源 | 时间范围 | 行数 | 设备（部分） |
> |---|---|---|---|
> | Yield Monitor | 2026-05-10 ~ 2026-05-13 | 200 条 | WA03P02G、WD08N87J、WA01P33R… |
> | JB STAR | 2026-05-12 ~ 2026-05-13 | 200 条 | WA03P02G、WD08N87J、WB10N57U… |
>
> 真实生产数据中请将以下示例值替换为实际存在的值。

---

## 1. get_filter_values — 查询可选值（新功能）

> **通俗理解：**
> 工程师刚接手一批数据，往往不知道有哪些探针卡编号、哪些机台、哪些 lot 可以查。过去只能靠记忆或猜，猜错了查出来是空的。这个工具专门解决"我不知道有什么可以选"的问题——在正式查数据之前，先问 AI "Yield Monitor 里现在有哪些探针卡"，它就会列出所有探针卡并告诉你每张卡触发了多少次，帮你快速锁定分析目标。
>
> **能查什么：**
> - Yield Monitor：`probeCard`（具体卡号）、`probeCardType`（卡类型前缀）、`hostname`（机台）、`lotId`（批次）
> - JB STAR：`cardId`（具体卡号）、`probeCardType`（卡类型前缀）、`testerId`（测试机）、`lot`（批次）
>
> **不需要用它查的：** device 列表和时间范围——这两项已经在 AI 的系统提示词数据快照中了，直接问就行。

**1a. 查 Yield Monitor 有哪些探针卡**

```
Yield Monitor 里现在有哪些探针卡？每张卡触发了多少次？
```

**1b. 查特定设备下有哪些 lot**

```
WA03P02G 这个设备的 Yield Monitor 数据里有哪些批次（lot）？
```

**1c. 查 JB STAR 有哪些测试机台**

```
JB STAR 里有哪些测试机台（tester）？每台测了多少条记录？
```

**1d. 查特定设备下 JB 有哪些探针卡**

```
WD08N87J 设备在 JB STAR 里用过哪些探针卡（cardId）？
```

---

## 2. query_yield_triggers — 查询 Yield Monitor 触发记录列表

> **通俗理解：**
> Yield Monitor 会对每片晶圆实时监控，一旦 bin 分布相对上片发生异常漂移，就产生一条"触发记录"（delta_diff 类型）。工程师每天要翻这些触发记录，判断是偶发还是系统性漂移。这个工具按条件筛出原始记录列表：可以按设备、批次、晶圆号、机台、探针卡、pass、时间范围等任意组合过滤，最多返回 200 条。

**2a. 查某个 lot 的全部触发**

```
NF12551.1N 这个 lot 共触发了多少次 Yield Monitor？分别是哪几片晶圆？
```

**2b. 查特定设备最近的触发**

```
WA03P02G 器件最近几天的 Yield Monitor 触发记录有哪些？触发的批次和晶圆号是什么？
```

**2c. 查某张探针卡的触发记录**

```
探针卡 7772-01 触发了哪些记录？是哪些设备、哪些批次？
```

---

## 3. aggregate_yield_triggers — Yield Monitor 触发聚合统计

> **通俗理解：**
> 光看原始记录找不出规律，聚合才能回答"哪个设备最容易触发、哪台机台问题最多"这类问题。这个工具按你指定的维度分组计数并排行——比如按机台分组，一眼看出 b3flex18 上周触发了 60% 的告警；按探针卡分组，看出某张卡的触发率是其他的 3 倍。
>
> **常用聚合维度：** `device`（设备）、`hostname`（机台）、`lotId`（批次）、`probeCard`（具体卡）、`probeCardType`（卡类型）、`pass`（测试程序）、`timeDay`（按天趋势）

**3a. 按机台统计触发排行**

```
各测试机台的 Yield Monitor 触发次数排行是什么？哪台机台告警最多？
```

**3b. 按探针卡统计**

```
哪张探针卡的 Yield Monitor 触发次数最多？触发量前 5 的卡分别是哪些？
```

**3c. 按天查触发趋势**

```
最近几天 Yield Monitor 每天的触发次数是多少？有没有哪天出现明显高峰？用折线图展示。
```

**3d. 按设备 + 机台联合分析**

```
WA03P02G 这个设备在各台测试机上的触发次数分别是多少？哪台机台触发最集中？
```

---

## 4. query_jb_bins — 查询 JB STAR 测试 Bin 记录列表

> **通俗理解：**
> JB STAR 记录了每片晶圆 CP 测试完成后的 bin 分布——BIN0/BIN1 通常是良品，BIN2 以上是各类失效。这个工具按条件筛出原始测试记录，每条记录包含该片晶圆各 bin 的 die 数量，可以按设备、批次、槽位、机台、探针卡、测试结束时间等过滤。

**4a. 查某个 lot 的测试记录**

```
NF12615.1X 这个 lot 的 JB STAR 测试记录有哪些？各片晶圆的良率分别是多少？
```

**4b. 查某张探针卡的测试记录**

```
探针卡 7773-05 测试了哪些晶圆？是哪些设备和批次？
```

**4c. 查某台测试机最近的记录**

```
b3uflex10 这台测试机最近测试了哪些晶圆？测试结果怎么样？
```

---

## 5. aggregate_jb_bins — JB STAR Bin 聚合统计

> **通俗理解：**
> 把多片晶圆的 bin 数量按维度汇总，快速定位"哪个 bin 失效最多、哪台机台 BIN2 最严重"。聚合结果会标注哪些 bin 是"良品 bin"（PASSBIN 定义），只统计失效 bin，避免混淆良率。
>
> **常用聚合维度（bin 必须包含）：** `bin`、`device`、`lot`、`testerId`（机台）、`cardId`（探针卡）、`passId`（pass）、`slot`（槽位）

**5a. 统计各 bin 失效数排行**

```
WA03P02G 器件目前哪个失效 bin 的 die 数最多？用柱状图展示各 bin 的失效计数。
```

**5b. 按机台 + bin 联合分析**

```
各测试机台上的 JB STAR BIN2 失效数量分别是多少？哪台机台 BIN2 最多？
```

**5c. 按探针卡统计失效**

```
各探针卡对应的 JB STAR 失效 bin 总数分别是多少？哪块探针卡的失效比例最高？
```

---

## 6. generate_chart — 生成可视化图表

> **通俗理解：**
> 查完数据后，AI 会根据数据特征自动判断是否生成图表——4 个以上分组且差异明显适合柱状图/饼图，按天的时序数据适合折线图。图表直接嵌入对话气泡，不需要下载或打开 Excel。
>
> 以下示例展示"明确要求图表"的写法，大部分情况下 AI 会主动生成，不需要单独要求。

**6a. 查询同时要图**

```
统计 WD08N87J 器件各探针卡的 Yield Monitor 触发次数，并生成柱状图。
```

**6b. 已有数据后要图**

```
把上面查到的各设备触发次数用饼图展示，我想看各设备的占比。
```

**6c. 时序趋势折线图**

```
最近几天每天的 Yield Monitor 触发数量，请生成折线图展示趋势。
```

---

## 7. ask_clarification — AI 主动追问（了解触发场景）

> **通俗理解：**
> 当 AI 判断问题太模糊、答错代价高时（比如没有指定 device），会先反问用户补充关键信息，而不是猜测后查出一堆无关数据。注意：AI 只在 **device 完全未知** 时才问，时间范围、批次号等缺失时不会追问（有合理默认值）。
>
> 以下是会触发 AI 主动反问的模糊提问示例：

**7a. 设备完全未知**

```
帮我查一下触发记录。
```

**7b. 意图模糊（Yield Monitor 还是 JB STAR？）**

```
NF12615.1X 这个 lot 的测试情况怎么样？
```

---

## 8. query_inf_site_bin_by_dut — INF Wafer Map · DUT 分布

> **通俗理解：**
> 一片晶圆上布满了 die，每个 die 由某个 DUT（探针台头）测试。当你想知道"某批晶圆某一槽位上，各 DUT 各测了多少 die、各失效 bin 是哪个 DUT 造成的"时，就用这个工具。它读取 INF 文件，按 pass（sort1/sort2/sort3）× bin × DUT 三维拆解，帮你判断失效是系统性的（所有 DUT 均有）还是局部的（某一 DUT 异常偏高）。
>
> **两种 DUT 含义必须区分：**
> | 字段 | 含义 | 示例 |
> |---|---|---|
> | `dut`（INF 文件内） | 探针台头编号（物理位置，1/2/3/5…） | 每个 die 由哪个头测 |
> | `CARDID` SITE | 探针卡上的 site 布局 | 与 dut 不同概念，不要混淆 |
>
> **前置条件：** 需要知道 `device`（产品代码）+ `lot`（批次）+ `slot`（槽位整数）。通常先用 `query_jb_bins` 拿到这三个字段，再调用本工具；同时将 `CARDID` 传入 `cardId` 参数，结论中可写明卡号。
>
> **报表界面触发方式（无需手动输入）：**
> - JB STAR 报表 → 下钻到槽位级别时，INF 分布面板自动出现在下钻图下方
> - 点击明细数据表任意一行，该片晶圆的 INF 分布面板自动展开

**8a. 单片晶圆 INF DUT 分布（指定槽位 + pass）**

```
WA03P02G 器件，NF12551.1N 这个 lot 的第 3 槽晶圆，sort1 测试下各 DUT 的 bin 分布是什么？哪个 DUT 失效最多？
```

**8b. 多 pass 对比（sort1/sort2/sort3 联合查看）**

```
NF12551.1N lot 的 slot 5，sort1、sort2、sort3 三个 pass 的 INF DUT 分布分别是什么？哪个 pass 失效最集中？
```

**8c. 聚焦特定 bin 的 DUT 分布**

```
WA03P02G 器件 NF12551.1N lot slot 2，sort1 pass 里 bin37 的 die 数量在各 DUT 之间是否均匀？用这个信息判断 bin37 是全局失效还是单 DUT 问题。
```

**8d. 与探针卡联动：先查卡号再看 INF 分布**

```
NF12551.1N lot slot 1 用的是哪张探针卡？这片晶圆 sort1 的 INF DUT 分布如何？结论里请注明探针卡编号和各 DUT 的失效 bin 颗数。
```

**8e. 连续多槽对比（先查 JB 再逐槽看 INF）**

```
WA03P02G 器件 NF12551.1N 这个 lot 有哪些槽位完成了测试？先给我一个各槽良率概览，然后取良率最低的那槽查 INF DUT 分布，看看是哪个 DUT 拉低了良率。
```

---

## 9. query_lot_dut_bin_agg — Lot 级 DUT×Bin 聚合

> **通俗理解：**
> 上一个工具（`query_inf_site_bin_by_dut`）只看一片晶圆。这个工具把整批 lot 的全部 wafer（最多 25 片）INF 数据加在一起求和，回答"这整批晶圆，哪个 DUT 失效 die 数最多"。适合判断失效是批次性的还是个别片子的异常。
>
> **与单片工具的区别：**
> | 工具 | 范围 | 适用问题 |
> |---|---|---|
> | `query_inf_site_bin_by_dut` | 一片晶圆 | 这片 wafer 的 map 细节 |
> | `query_lot_dut_bin_agg` | 整批 lot（最多 25 片求和） | 整批失效是否集中于某个 DUT |
>
> **前置条件：** 先用 `query_jb_bins` 拿到 device + lot；有探针卡类型（`probeCardType`，如 `6045`）时精度更高，省略则扫 lot 目录全部 wafer。

**9a. 查整批 lot 各 DUT 失效分布**

```
WA03P02G 器件 NF12551.1N 这个 lot，整批晶圆加起来哪个 DUT 失效 die 数最多？是局部 DUT 偏高还是均匀分布？
```

**9b. 指定 pass 查 lot 级 DUT 分布**

```
NF12615.1X 这个 lot，sort1（常温）测试下，整批晶圆各 DUT 的坏 bin 累计 die 数是多少？共几片晶圆参与统计？
```

**9c. 聚焦特定坏 bin 的 lot 级 DUT 分布**

```
WA03P02G 器件 NF12551.1N lot 整批，sort1 里 bin37 失效 die 数在各 DUT 之间是否均匀？判断是探针卡某个 DUT 系统性问题还是随机失效。
```

**9d. 先查 JB 再看 lot 级 DUT 分布（联动）**

```
NF12551.1N 这个 lot 的 JB STAR 里坏 bin 排名第一是哪个？这批晶圆用的探针卡类型是什么？然后查该 lot 整批的 INF DUT 分布，看这个坏 bin 是否集中在某个 DUT 上。
```

---

## 综合场景（多工具联动）

**场景 A：探针卡问题排查（先发现 → 再分析）**

```
我想分析一下各探针卡的质量，但不知道 Yield Monitor 里有哪些卡。先帮我列出所有探针卡和触发次数，然后重点分析触发最多的那张卡：它对应哪些设备和批次？近期触发是否集中？
```

**场景 B：设备良率全面体检**

```
WA03P02G 器件近期的良率表现如何？帮我同时看 Yield Monitor 触发情况和 JB STAR 各 bin 失效分布，综合评估一下是否有异常需要关注。
```

**场景 C：机台对比分析**

```
b3flex18 和 b3uflex21 这两台机台的 Yield Monitor 触发次数各是多少？哪台表现更差？用柱状图对比，并给出判断。
```

**场景 D：批次失效溯源**

```
NF12615.1X 这个 lot 的 JB STAR 数据中哪个失效 bin 最严重？这个 lot 用的是哪张探针卡？这张卡在其他批次上的失效情况如何？
```

**场景 E：快速概况（不知道查什么）**

```
现在数据库里有哪些设备、时间范围是多少？帮我快速梳理一下 Yield Monitor 和 JB STAR 近期各有多少条触发/测试记录，触发量最多的前三个设备分别是什么。
```

**场景 F：INF DUT 分布 × 失效溯源（三工具联动）**

```
WA03P02G 器件近期哪个 lot 的 JB STAR 失效 bin 最多？找到该 lot 失效最严重的那个槽位，查一下 sort1 的 INF DUT 分布，判断失效是全局性的还是某个 DUT 偏高导致的，并写明使用的探针卡编号。
```

**场景 G：Yield Monitor 告警 → INF 确认失效根因**

```
Yield Monitor 最近触发次数最多的是哪张探针卡？取该卡最近一条触发记录对应的 lot + slot，查其 sort1 INF DUT 分布，看看是否有某个 DUT 的 die 数量异常偏高，给出初步判断。
```

**场景 H：JB 坏 bin → lot 级 DUT 聚合 → 判断根因（三工具联动）**

```
WA03P02G 器件近期失效最严重的 lot 是哪个？先给我这个 lot 的 JB STAR 坏 bin 排名，然后查该 lot 整批（所有晶圆求和）的 INF DUT 分布，判断坏 bin 是某个 DUT 系统性偏高还是全局均匀失效，最后给出探针卡健康状态的初步结论。
```

---

## 10. INF 晶圆 die 级分析工具（23 个 inf_* 工具）

> **Dummy 模式说明：**
> 以下所有提问在开启 Dummy 模式时（`INFCONTROL_LAYER_BINS_DUMMY=true`）均可直接运行，device / lot / slot 填任意值即可——系统会自动使用内置测试 INF 文件。
>
> **统一使用以下测试参数：**
> - device = `WA03P02G`
> - lot = `NF12551.1N`
> - slot = `1`（单片工具）
>
> **晶圆图访问方式：** 生成 HTML 后，在浏览器访问 `http://<服务器地址>:30008/wafermaps/<文件名>.html`

---

### 10a. 一键综合分析（推荐入门）

**inf_analyze_wafer — 快速体检一片晶圆**

```
帮我分析 WA03P02G 器件 NF12551.1N 这个 lot 第 1 槽晶圆，给出良率、各 pass 统计、DUT 差异和异常诊断。
```

---

### 10b. 画晶圆图（最常用）

**inf_draw_wafer_map — 生成可交互 SVG HTML 晶圆图**

```
帮我画 WA03P02G 器件 NF12551.1N lot 第 1 槽晶圆的 wafer map，显示最终测试结果（final），并给出访问链接。
```

**显示所有 pass（多 tab 切换）：**

```
帮我画 WA03P02G NF12551.1N lot slot 1 的 wafer map，展示所有测试 pass，每个 pass 一个 tab，我要对比不同温度下的 die 分布。
```

**高亮特定坏 bin：**

```
帮我画 WA03P02G NF12551.1N lot slot 1 的 wafer map，高亮 bin37 的分布位置（黄色描边），其余正常显示。
```

**高亮边缘 die：**

```
帮我画 WA03P02G NF12551.1N slot 1 的 wafer map，并高亮显示边缘 die（edge 模式），判断边缘良率是否低于内部。
```

---

### 10c. 基础查询

**inf_parse_wafer — 查单片晶圆详细统计**

```
查询 WA03P02G NF12551.1N lot 第 1 槽晶圆的详细信息：良率、各 pass 良率、bin 分布、测试时间。
```

**inf_list_passes — 列出所有测试 pass**

```
WA03P02G NF12551.1N lot slot 1 这片晶圆有哪些测试 pass？有没有中断记录？良品 bin 是哪些？
```

**inf_get_die_map — 获取 die 坐标数据**

```
获取 WA03P02G NF12551.1N slot 1 最终测试结果的 ASCII 晶圆图，并显示坏 die 的坐标列表。
```

**inf_site_stats — DUT 良率统计**

```
WA03P02G NF12551.1N lot slot 1 各测试 DUT（site）的良率分别是多少？哪个 DUT 良率最低？良率差异有多大？
```

---

### 10d. 失效分析

**inf_yield_loss_breakdown — 良率损失按 bin 分解**

```
WA03P02G NF12551.1N lot slot 1 的最终测试结果中，哪个坏 bin 损失良率最多？各 bin 占总 die 和坏 die 的比例分别是多少？
```

**inf_bin_spatial — 某坏 bin 的空间分布**

```
WA03P02G NF12551.1N lot slot 1，最终测试结果中坏 die 最多的那个 bin，分布是聚集在一个区域还是均匀散布？给出质心和 ASCII 热点图。
```

**inf_cluster_detect — 聚集缺陷检测**

```
WA03P02G NF12551.1N lot slot 1 最终结果中有没有坏 die 聚集成片的区域？检测所有 cluster，列出每个 cluster 的中心位置、大小和局部良率。
```

**inf_cluster_shape — 判断是划伤还是粒子污染**

```
WA03P02G NF12551.1N lot slot 1 的坏 die cluster 是什么形状？判断是线状划伤（scratch）还是圆形粒子污染（particle），并给出每个 cluster 的宽高比。
```

**inf_edge_analysis — 边缘 die 良率分析**

```
WA03P02G NF12551.1N lot slot 1 的边缘 die 良率比内部低多少？按外到内分 2 个环分析，给出各环的良率对比。
```

**inf_partial_probe — 检查未测 die**

```
WA03P02G NF12551.1N lot slot 1 有没有本应测试但实际未测的 die？未测 die 占应测 die 的比例是多少？
```

---

### 10e. 多 pass 对比

**inf_compare_passes — 对比两个 pass 的 die 结果**

```
WA03P02G NF12551.1N lot slot 1，对比 pass1 和 pass3 测试结果：有多少 die 从不良恢复为良品？有多少 die 反而从良品变为不良？稳定不良的 die 有多少？
```

**inf_bin_migration — bin 流向矩阵**

```
WA03P02G NF12551.1N lot slot 1，pass1 到 pass3 之间，哪些坏 bin 的恢复率最高？给出 bin 流向矩阵和可恢复率排行。
```

**inf_unstable_dies — 找反复翻转的不稳定 die**

```
WA03P02G NF12551.1N lot slot 1 有没有在多个 pass 之间反复变好变坏的不稳定 die？最终判为良品但有翻转风险的 die 有多少？
```

**inf_temperature_compare — 三温测试对比**

```
WA03P02G NF12551.1N lot slot 1，对比常温（pass1）、高温（pass3）、低温（pass5）三个温度的测试结果：仅在高温下失效的 die 有多少？仅在低温下失效的 die 有多少？三温都失效的有多少？
```

**inf_touch_analysis — 探针接触质量**

```
WA03P02G NF12551.1N lot slot 1 的探针接触次数分布如何？哪些 die 接触次数异常偏高（≥2次）？按 DUT 统计平均接触次数。
```

---

### 10f. Lot 批次级分析（多片汇总）

**inf_parse_dir — 解析整批良率概览**

```
WA03P02G NF12551.1N 这批晶圆一共几片？每片良率分别是多少？哪片最差、哪片最好？
```

**inf_compare_wafers — 批次内晶圆良率对比**

```
WA03P02G NF12551.1N lot 所有晶圆的良率排名，标出离群的异常片（超过 2σ），并给出平均良率和标准差。
```

**inf_lot_die_compare — 批次热点分析（共同坏 die）**

```
WA03P02G NF12551.1N lot 中，有哪些坐标位置在多片晶圆上都出现坏 die？找出整批最严重的热点坐标（至少 2 片有坏 die 的位置）。
```

**inf_lot_heatmap — 生成批次热力图**

```
帮我生成 WA03P02G NF12551.1N lot 的 wafer 热力图，显示每个坐标位置在整批中出现坏 die 的频率，用绿→黄→红表示严重程度，给出访问链接。
```

**inf_lot_cluster_overlap — 批次 cluster 重叠分析**

```
WA03P02G NF12551.1N lot 各片晶圆的坏 die 聚集区域在空间上是否重叠？分析跨片共同 cluster，找出在多片上都出现的批次性缺陷区域。
```

**inf_slot_trend — 按槽位顺序良率趋势**

```
WA03P02G NF12551.1N lot 按槽位顺序排列，良率是否有逐渐下降或上升的趋势？前半批和后半批的平均良率相差多少？生成趋势折线图。
```

---

### 10g. 综合场景（INF 工具联动）

**场景 I：完整晶圆体检流程**

```
对 WA03P02G NF12551.1N lot slot 1 做完整体检：1. 列出所有 pass 和良率 2. 画出最终 wafer map 3. 分析坏 die 是否有聚集 cluster 4. 检查各 DUT 良率是否均衡 5. 给出综合诊断结论。
```

**场景 J：cluster 根因判断**

```
WA03P02G NF12551.1N lot slot 1，先检测坏 die cluster，再判断每个 cluster 的形状（划伤/粒子），最后对最大的 cluster 做空间分析（质心、局部良率），给出初步根因判断。
```

**场景 K：批次性缺陷 vs 单片偶发**

```
WA03P02G NF12551.1N lot：先看各片良率是否均匀，再找批次共同热点坐标，判断失效是批次性系统缺陷还是个别片的随机问题，最后生成整批热力图供参考。
```

**场景 L：三温筛选效果评估**

```
WA03P02G NF12551.1N lot slot 1 的三温测试（常温/高温/低温）筛选效果如何？哪种温度独有的失效最多？最终良率损失主要来自哪个 bin？用 bin migration 分析各温度间的 die 流向。
```
