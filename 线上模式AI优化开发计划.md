# 线上模式 AI v2 优化开发计划与派发词

日期：2026-09-30。项目：`D:/newPoker`，不是 `D:/dezhou`，也不是独立的新网站。
状态（2026-10-01）：6.1 online-ai-fix-001 及单列规则 repair 已在 `codex/online-ai-fix` 工作树实现；review-4 代码复核通过，已列金额 P1 场景全部关闭，定向回归 36/36、独立单一存活者金额组合 44,784/44,784 及 3 项多赢家/余数控制通过，未发现新的阻塞 finding（见 §6.1 记录）。尚未提交冻结、合入、完成人工扫码回跳验收或部署。6.2–6.4 未实施；本地收尾后，6.2 等待 dezhou 固定共享核心包交付。
基线：`feature/room-repo@903618a4bb523cd0e434299313b259c3ccd01485`。

本文是 V1 的增量开发计划，覆盖问题修复、共用模型和扩增模拟预算。
只在本文明确范围内覆盖 [线上模式.md](线上模式.md) 的旧 AI 限制；房间/身份/筹码/隐私等其他契约不变。
旧 `docs/线上模式任务拆分.md` 的 CloudBase/PostgreSQL/JWT 路线仍不适用。

## 0. 执行入口与交付方式

1. 阅读本文件、线上模式.md、当前 Git 状态/分支、server/index.js、server/ai/、shared/logic/。
2. 阅读共用模型事实来源 `D:/dezhou/docs/architecture/poker-ai-v2-contract.md` 和原 T4 中 AI v2 任务。
   只能访问 newPoker 的 agent 必须取得已发布核心包/CONTRACT/配置/fixture；缺失时停在接入门禁，不能自造另一模型。
3. 按下列任务逐个 freeze → develop → review → 合入；最多两条 active lane，生产/测试/契约同路径必串行。
4. 每个任务在 `codex/online-ai-任务短名` 隔离分支开发；不要把未知工作区改动一起暂存。
5. 每任务把状态/下一动作/实际 SHA/命令结果写回本文件对应“记录”行；本文件就是线上计划交接入口。
6. 本轮只规划。下面的派发词供用户复制，不表示助手已派发、已安装运行时或已连接生产。

文档验收（2026-09-30）：两仓共12份新增/更新文档格式、153个本地链接、
dezhou六任务依赖无环及两边四档预算一致性已检查；两仓diff-check通过。
仅文档检查，不代表下列待实现脚本、业务回归或性能门禁已通过。本轮未提交、push或部署。

遵循最小正确改动：复用 HTTP 轮询、注册/座位令牌、统一 applyRoomAction、已上线近期三手和 shared 规则。
不新增 WebSocket/Redis/聊天/排行榜/资金存储；不把扑克规则迁移到 Python。

## 1. 要修什么，不重复做什么

### 1.1 已确认的本轮缺口

| 编号 | 缺口与代码依据 | 本轮目标 |
|---|---|---|
| R1 | runtime.recordAction 按 allin 动作名全部计 raise | 全押跟注和全押加注分开；盲注不算 VPIP，统计按手 |
| R2 | policy 价格使用 currentBet-myBet，短码实际支付可能更小；高 callTendency 可直接绕过价格 | 基于合法 call 实际增量、可争夺池；v2 不以性格强制任何价格都跟 |
| R3 | publicActions 不直接参与本手牌力推断，金额/庄位/累计投入等不足 | 完整规范公开动作 DTO，逐对手范围与位置/尺度判断 |
| R4 | 当前800次/80ms在Node主线程；1–2s同步计算会卡其他请求 | 移到本机常驻AI进程；人数动态次数，预算和等待分离 |
| R5 | test-online-ai-perf.mjs 仍用匿名uid建房，但当前线上建房要求注册 | 修测试真实注册、断言建房/启动/样本/错误；失败不得输出看似通过的性能 |
| R6 | 177/3177等价牌力的现有回归主要直接构造showdown | 补真实HTTP下注→全押→结算与独立金额oracle、UI解释验收 |

R1–R5 有源码依据；R6 是覆盖缺口，不等于已经证明现有结算错误。
性格价格偏差由 quick fix 消除无条件绕过，再由共享 EV 核替换阈值策略，不反复调两套模型。

### 1.2 已上线能力仅回归

- 最近最多三手公开历史、手牌来源金色高亮、同类牌型踢脚与分池明细。
- 扫码未登录先注册/登录并回跳；已登录/合法座位令牌可重连，不能误判登录对象为true。
- 结算展示投入/到账/净盈亏；重置重新生成AI性格，跨手未重置则保持。
- AI逐玩家非阻塞等待0.8–10s、线上500ms轮询；真人弃牌后AI仍需逐个行动。
- heads-up有效筹码封顶，多人允许超短码形成边池；现有规则/合法动作唯一权威。

回归失败才修相应路径，不能另建第四手历史、持久化线上战绩或重写整个结算页面。
若全员合法all-in，直接补齐剩余公牌是正常规则；不能为视觉效果插入不存在的下注动作。

## 2. 共用模型与版本交付

### 2.1 主路线

`dezhou/packages/poker_ai` 是唯一策略源码，Python标准库、兼容3.11–3.14。
dezhou直接调用；newPoker以一个本机常驻Python子进程调用；Node仍持有真实牌局和唯一动作应用入口。
AI只收自己的牌、公开动作/筹码/公牌、合法动作及公开对手统计，不收Room、hands、deck、seatToken或数据库。

线上 Git 纳入 `vendor/poker_ai/`、`vendor/poker_ai.manifest.json` 及同步脚本。
manifest至少含源仓库、完整核心SHA、model/schema/config版本、逐文件SHA-256，包附CONTRACT及共享fixture。
只允许从dezhou已review/合入的固定版本同步；不能直接改vendor策略，不能使用`latest`或在线临时pip安装模型。
没有源核心版本/校验清单/测试证据时不得切换。

已有server/ai/personality.mjs/runtime.mjs继续持有线上房间人设、情绪和公开统计，转换为共享snake_case参数。
核心不访问完整MemoryManager、关系/剧情记忆或长期账号资产；线上对手状态仅房间内存。
接入通过后，JS equity/policy只作明确的旧版回滚边界或薄适配，不在默认链同时运行两套决定。

### 2.2 前置核心开发依赖（用户在dezhou安排）

| dezhou任务 | 交付 | 线上消费 |
|---|---|---|
| ai-equity-001 | 多人1/k、单次估算、听牌修正/求值提速 | 正确性基线，不直接手工翻译回JS |
| ai-core-001 | 自包含安全DTO/CLI、标准库包/版本清单 | online-ai-worker-001 |
| ai-range-001 | 每对手范围、公开动作似然、无重复联合采样 | 发布核心 |
| ai-policy-001 | EV/听牌/半诈唬/性格混合/动态预算配置 | 发布核心 |
| ai-observation-001 | 单机规范公开动作、全押/VPIP口径 | 共享输入语义，线上自行适配 |
| ai-integration-001 | 单机真实接入/验收、固定核心SHA | 线上模型切换前置 |

可以先做线上问题修复，但不跳过核心发布依赖，不能让一个agent同时横跨两个项目随意改策略。
共享schema/配置有变更先改dezhou契约和依赖task，再同步线上计划；不同版本的任务不可拼接部署。

## 3. 线上输入、筹码和显示规范

### 3.1 输入适配

需补真实buttonId/seatOrder、inHand、chips/streetBet/totalBet、minRaise和完整本手actions。
每个动作提供sequence、actorId、phase、kind、isAllIn、paidAmount、raiseTo、
potBefore/currentBetBefore/actorStreetBetBefore/actorChipsBefore/boardBefore/liveIdsBefore。
server已有actionLog.amount为实际投入，betTotal为当街累计，不要倒置；不能只传最后20条。
每次动作前捕获公开下注上下文，规则成功后补实际结果；清街/摊牌后不能用清零后的bet猜原加注额。

- short call =合法call的amount，不超过自身后手；对方全下到180、自己已下注20，只付160。
- 全押到的当街总额<=原currentBet是call，不提升raise统计；高于原currentBet才是raise/bet。
- 短额全押是否重新开放raise由权威legalActions决定，模型不擅自重新开放。
- 动作类型用于模型分类，UI仍可保留ALL IN标签；不能为统计修复篡改权威下注语义。
- ranges/EV/outs只在AI进程和隔离QA内，不给玩家返回“AI为什么诈唬”或隐藏信息。
- 近期三手限制是展示历史，不是模型丢掉当前这手完整下注线的理由。

### 3.2 主池/边池与到账解释

金额定义：本手投入B；争夺池派彩W；未被匹配的退回U；到账G=W+U；净盈亏P=G-B。
退款仅指本层只有一个出资人，不能把“多个出资人但只剩一个eligible赢家”都算退款。
如还展示收回本金，约定min(B,G)只是展示拆分，不是另一笔到账；盈利max(P,0)、亏损max(-P,0)。

冻结精确案例：

| 场景 | 短码A | 深码B | 核心解释 |
|---|---|---|---|
| 投入177/3177，最佳五张完全相同 | 到账177、净0 | 争夺池派彩177+退款3000=到账3177、净0 | 不能把B标为净赚3177 |
| 投入177/3177，B踢脚更大 | 到账0、净-177 | 派彩354+退款3000=到账3354、净+177 | 同为两对不等于同牌力 |
| 再有弃牌C投入100，A/B仍完全同牌力 | 派彩227、净+50 | 派彩227+退款3000=到账3227、净+50 | C净-100，三者净和0 |

案例通过合法HTTP动作和明确测试牌面驱动，不靠直接改终局对象冒充完整路径。
177/3177双人案例可通过合法真人大额全下验证权威结算；AI候选封顶另测，不能强造非法AI动作。
多人AI超短码案例必须存在其他可响应玩家时才允许大额加注，并验证合法边池。
显示每人的两张底牌、最佳五张、公共牌与参与的池层；只有牌面完全比较相等才标平分。
普通历史继续隐藏弃牌者底牌，最多三手，重置/销毁/重启清空。

## 4. 动态模拟次数与时间

唯一人数口径N：本手已发牌且未弃牌的人数，包含自己与已全押者；不含未入手/旁观/淘汰座位。
不等于有后手人数、不等于初始桌人数；每次AI回合重新计算。

以下是共享config的初始normal目标，线上读取固定发布配置，不再另写JS常量：

| N | 基础目标 | 临界最多 | 软计算预算 | 硬上限 |
|---|---:|---:|---:|---:|
| 2 | 8000 | 20000 | 300ms | 2000ms |
| 3–4 | 6000 | 15000 | 400ms | 2000ms |
| 5–6 | 4000 | 10000 | 500ms | 2000ms |
| 7–8 | 2500 | 6000 | 500ms | 2000ms |

人数少每次便宜，可多采样；人数多每次求值更贵。表是开发目标，不承诺每手一定跑满。
批次128次检查总deadline；基础次数后最优/次优EV仍接近则追加；所有候选共用一个总2s硬预算。
极端范围构造也计时，不能范围2s+模拟2s+EV再2s；截止时返回已完成合法估计并标真实停止原因。
河牌单挑可精确枚举，method=exact；被迫唯一合法动作或N<=1不做模拟，requested/used=0。

等待与计算同时开始：到AI回合提交任务，达到原0.8–10s思考时间且结果有效后才apply。
正常计算结果应被思考等待覆盖，不能先等10s再算2s；计时从AI回合开始。
排队+计算结果等待上限2500ms；到截止无结果则保留现有安全降级动作，最晚原10s上限+100ms调度裕量应用。
软预算不是必须耗时，强明确局面可早停；禁止为了“显得聪明”让CPU空转到2s。

### 4.1 已有测量，不混淆新模型性能

ECS 2vCPU、Node v22.23.2、基线903618a；旧JS估算固定AhKh、公牌Qh7h2c→Jd→4s，
每项5次中位数、仅计算、强制完成2500次：

| 对手 | 翻牌 | 转牌 | 河牌 |
|---|---:|---:|---:|
| 1 | 35.2ms | 61.7ms | 31.1ms |
| 3 | 56.2ms | 90.6ms | 39.8ms |
| 7 | 87.7ms | 80.0ms | 44.4ms |

单次最高132.1ms；80ms七对手翻牌仅2239–2399次。旧Python本机2500次约0.9–2.0s，不是云端数据。
这些少量固定牌面探针不能冒充P95/P99；必须在实际共享Python运行时重新测完整场景和动态预算。

## 5. 进程/调度的最小设计

一个全局AI子进程，双房总未完成任务最多2（每房最多1，通常1执行+1排队）。
core是无状态纯计算；房间级对手统计和本手状态由现有runtime owner管理，计算结果携带增量由主线程提交。

私有JSON协议目标：

```json
{
  "protocolVersion": 1,
  "jobId": "opaque-unique-id",
  "generation": 1,
  "identity": {"roomId": "room", "handId": "hand", "turnSeq": 4, "actorId": "seat"},
  "observation": {},
  "personality": {},
  "opponentStats": {},
  "budget": {"hardMs": 2000},
  "seed": 123
}
```

完整payload字段/值约束以发布CONTRACT为准；此处是信封示意，不是可直接运行的空观察。
结果原样回传job/generation/identity，返回action与内部compute统计；不传座位token和完整room数据。
用单行JSON、最多1MiB/条，处理拆包/粘包/非法行/EOF；stdout不能夹杂日志。

唯一调度owner负责task生命周期：submit→queued/running→result或timeout/cancel→disposed。
具体要求：

- 应用前重新核对房间仍online、handId/turnSeq/actorId/generation、座位仍AI，并重新检验合法动作。
- late/duplicate/旧进程generation结果不应用，也不改变handState；只记录无牌/token的计数。
- 房间销毁、手结束、重置、AI移除/换人取消相关任务/计时器；已运行纯计算可完成后丢弃。
- 一个到期运行任务不能长期卡住另房；硬超时终止故障进程，释放受影响job并降级，再按需重建。
- 断管/启动失败/非法结果按check→call→fold现有规则一次降级；同一job不能降级后又正常apply。
- 进程只在服务首次需要AI时启动；异常后下一任务最多尝试一次重建，失败该轮回退。
  不引入无限重试、每房进程、通用消息总线或新HTTP AI服务。
- 队列满返回明确overload并做一次合法降级；不得泄漏Promise/timer/永久等待。
- 空房服务停止应关闭进程/流/计时器；正常房间间可复用进程，不因每手创建/杀进程。
- 进程/队列健康与版本、requested/used/compute/queue/stop/fallback计数内部可观测，记录长度有界。

新增防御机制必须逐项写真实触发、唯一owner、成功/失败/取消清理、计数信号和故障测试。
所有反复操作只针对隔离测试或项目release，不触碰线上正式数据目录来造fault。

## 6. 开发拆分与顺序

| 顺序/ID | 范围与前置 | 允许功能路径 | 自动/人工验收 |
|---|---|---|---|
| 1 online-ai-fix-001 | R1/R2/R5及R6真实回归；可先独立做 | server/ai/policy.mjs/runtime.mjs、server/index.js公开学习/投影、对应单测/脚本 | 实际短码成本、全押分类、精准分池、真实注册性能脚本；结算/扫码人工回归 |
| 2 online-ai-worker-001 | 依赖1 + dezhou固定核心发布SHA | vendor/poker_ai及manifest、同步脚本、server/ai/worker-client.mjs、进程协议测试 | 固定来源hash、独立启动、限界队列/超时/帧/崩溃、同核一致性；不改房间apply |
| 3 online-ai-integration-001 | 依赖2 | server/ai/runtime.mjs/policy薄适配、server/index.js调度、集成测试 | 安全DTO、动态N、思考并行、全押/多街、陈旧/重复/跨房、一次apply；真实双房试玩 |
| 4 online-ai-release-001 | 依赖3及独立review；发布owner | 性能/QA脚本、运行配置、release记录/部署文档（不夹带模型修复） | 完整自动gate、ECS共享核矩阵、30min双房/手机、Git拉取同SHA、回滚与服务健康 |

6.1 当前工作树已通过 review-4 代码复核，已列金额 P1 均关闭；正式收尾还需提交冻结、合入及人工扫码回跳验收记录。6.2–6.4 为 pending；6.2 依赖 dezhou 已 review/合入的固定核心包，独立测试冻结及功能 SHA 仍待补齐。
2–4只有前置review合入才能ready；缺少Python运行时或固定核心包不能假装已满足。
测试路径拆分可在freeze前细化，但必须先更新本文件path/命令，不默默扩功能。

### 6.1 online-ai-fix-001：修复与金额/身份回归

风险：high（真实行动/身份/结算回归）。A独立验收，B只实现已确认缺口，C独立review。
路径：第6节列出的功能路径；新增`server/ai/regression-v2.test.mjs`、
`scripts/test-online-ai-regressions.mjs`、修`test-online-ai-perf.mjs`、既有在线/逻辑测试的新增用例。
shared规则只读；若真实回归证明规则错误，先冻结具体finding另列repair，不在AI任务重写规则。
仅回归证明 UI 确有缺口时可修改 OnlineRoomView/JoinView 对应局部，先把精确文件/理由补入 allowlist。本任务已确认允许修改 `client/src/views/OnlineRoomView.vue` 的本手/历史奖池层标签：以“只有一个出资人”标记未匹配退回；理由：真实 HTTP 回归证明该层目前被呈现为普通边池派彩；不修改 JoinView。

不变量及 oracle：

| ID | 要求 | 验收 |
|---|---|---|
| F-I1 | 支付成本=min(待跟额,后手)，raiseTo/paid不同 | 全下到180、已有20→付160；自己只剩177、待跟远大于177→只付177 |
| F-I2 | 全押跟注不增加raise，盲注不算VPIP，多次翻前入池仅1手 | 用公开实际金额判定；精确统计数值断言 |
| F-I3 | 同名牌型比较踢脚、按池资格分派、净和0 | §3.2三项HTTP案例 +真实多人超短码边池 +折牌死钱/余数 |
| F-I4 | 登录/二维码回跳/合法令牌重连、最近3手隐私不退化 | 未注册建/加被拒；注册后正常；第4手淘汰最旧；弃牌不露牌 |
| F-I5 | 性能脚本真实注册、建双房、推进、采样并清理 | 任何接口失败/0AI样本/0state样本/卡局/异常均nonzero exit |

风险覆盖：正常/重复行动/短码边界/下一手重置/双房隔离/隐私；无新持久化迁移。
已修用例可以在基线green，记录为控制组；R1/R2/R5须业务red，不能让所有冻结只测已绿功能。

开发派发词：

```text
你在 D:/newPoker 开发 online-ai-fix-001，唯一依据是线上模式AI优化开发计划.md §6.1。
先读线上模式.md、当前Git和涉及代码；不进D:/dezhou改功能。创建codex/online-ai-fix隔离分支。
独立A先从903618a或用户指定干净基线冻结实际支付/全押统计/性能建房缺口与金额/登录控制。
B从accepted tests-only SHA修R1/R2/R5；不要重写已上线历史/结算，R6用真实HTTP补覆盖。
牌面/故障test seam只用于固定牌或目标fault；下注、分层、结算仍走真实权威入口。
不改规则/账号资产/线上持久化；不把旧通过功能虚报新开发。交付精确oracle与全部T0/T1。
提交功能SHA后freeze，记录测试/dirty排除，交独立C review；本任务不部署。
```

记录：baseline HEAD=`903618a4bb523cd0e434299313b259c3ccd01485`；分支 `codex/online-ai-fix`。单执行流先红后绿，未提交，tests-only/final SHA 未生成。红：原 `node scripts/test-online-ai-perf.mjs 1` 因缺少注册账户在建房时以 `LOGIN_REQUIRED` 退出；新 `node --test server/ai/regression-v2.test.mjs` 基线 5/6 失败；新 `node scripts/test-online-ai-regressions.mjs` 基线 6/8 失败，精确金额 HTTP 控制通过，退款分类与全押统计暴露缺口。绿：T0 `node --test server/ai/regression-v2.test.mjs` 6/6、`node scripts/test-online-ai-regressions.mjs` 8/8；`node scripts/test-online-ai-perf.mjs 6` 完成 12 手、80 AI 样本、72 state 样本、84 事件循环样本，耗时 1.7s。T1：`npm run test:logic` 147/147；`node --test server/db.test.mjs` 20/20；`node scripts/test-room-server.mjs` 45/45；`node scripts/test-online-room-server.mjs` 40/40；`npm run test:ai` 21/21；`npm run build --prefix client` 通过；`git diff --check` 通过。独立 A/C review、freeze/functional SHA、扫码回跳人工验收与部署仍 pending；既有 dirty `线上模式.md` 未修改。

#### review-1 记录（2026-10-01）

结论：不通过，6.2 不进入 ready。本次审查对象为 `codex/online-ai-fix` 的未提交工作区；HEAD 仍为 `903618a4bb523cd0e434299313b259c3ccd01485`，不存在可核验的 tests-only/final SHA，不能证明 frozen unchanged。功能路径、两份新增回归及性能脚本已完整审阅；既有 dirty `线上模式.md` 排除于本次功能审查。

| ID | 等级 / 来源 / 阻塞 | finding 与复现证据 | 下一动作 |
|---|---|---|---|
| C-R1 | P1 / pre-existing + coverage-gap / F-I3 与发布阻塞 | `shared/logic/side-pot.mjs:113` 对 `eligibleUids=[]` 的层直接跳过。真实 HTTP：双人初始各 500，盲注 10/20；房主 call 到 20；访客 raise 到 300；尚未到房主响应时访客 `/leave`。终局 pot=320、实际 winnings 合计=40，唯一出资的 280 层 awards=[]，访客 totalBet=300、won=0，净盈亏合计=-280。该规则文件工作区 hash 与 HEAD 一致，缺陷不是本次引入。 | 由 A 固化真实 HTTP red 和金额 oracle，单列规则 repair；遵守 §6.1 的 shared 只读边界，不夹入 AI 修复。后续任务需消费已修复的退款/到账结果，不改变 AI v2 输入契约。 |
| C-R2 | P2 / introduced / 6.1 blocking | `OnlineRoomView.vue:857–859`、`:973` 在 `isUncalledReturn` 分支直接以 contributor 和 layer.amount 显示退回，绕过实际 awards。C-R1 的合法 HTTP 终局因此显示“未匹配退回 +280”，但该层未到账、访客 won=0；当前结算和历史同时与金额明细矛盾。 | 未匹配层的分类与实际到账分开，退款显示须来自权威实际分配；冻结 awards 为空的显示失败用例，并在规则 repair 后验证显示与 won/winnings 一致。 |
| C-R3 | P2 / introduced + coverage-gap / 6.1 blocking | `test-online-ai-perf.mjs:132–141` 只核对决策/耗时样本数量，没有异常或降级信号。隔离故障控制在 add-ai 成功后令 AI persona.params 读取抛错；`decideAction` 安全降级了全部 24 次决策，脚本仍完成 2 手、输出 P95=0ms 并 exit 0。违反 F-I5 的异常 nonzero 要求，无法区分真实策略与全程兜底性能。 | 保留运行期安全降级，补唯一 owner 的异常/降级观测及脚本失败判断；冻结“正常真实 AI exit 0 / 决策异常 nonzero”的控制对，并验证失败后房间/服务/数据清理。 |

本轮实跑（Node v24.19.0，本机隔离数据目录）：`node --test server/ai/regression-v2.test.mjs` 6/6；`node scripts/test-online-ai-regressions.mjs` 8/8；`node --test server/ai/ai.test.mjs` 21/21。正常 `node scripts/test-online-ai-perf.mjs 6` 完成 12 手，90 AI / 78 state / 90 事件循环样本，2.1s，AI P95=22ms、state P95=84ms、事件循环 P99=71.8ms、RSS 58→143MiB。定向退款 HTTP 和性能异常控制均在临时隔离目录执行，未改功能或正式数据；以上性能仅为开发数据点。原 T1 完整组合沿用实现记录，不机械重跑；`git diff --check` 通过。

交付门禁仍缺：新增两份回归与本计划尚未 Git 跟踪（`git ls-files --error-unmatch` 失败）；独立 tests-only freeze、功能 SHA、扫码回跳人工验收 pending。修复顺序为 A 冻结 C-R1/C-R2/C-R3 → B 在明确 allowlist 内修复并补规则 repair → 提交与冻结 → review-2；本次未提交、合入或部署。

#### review-1 修复记录（2026-10-01）

按 review-1 顺序执行（先冻结红，再在 allowlist 内修复）：

- **C-R1 规则 repair（shared 边界内单列修复，非 AI 行为改动）**：`shared/logic/side-pot.mjs` `distributePotDetailed` 不再跳过 `eligibleUids=[]` 的层，按各出资人本层出资原路退回（层内各出资相等，余数按 uid 序确定性分配），写入权威 `awards`/`winnings`。`server/index.js` 的 `isUncalledReturn` 分类同步扩展为「唯一出资人 或 无人具备资格」。冻结用例：`side-pot.test.mjs` 新增 2 例（弃牌出资人 280 退回；多出资人全弃牌按出资退回）基线红（undefined≠280/50）→ 修复后绿；`test-online-ai-regressions.mjs` 新增 HTTP 复现（500/500，盲注 10/20，房主 call→20、访客 raise→300、访客 /leave）基线红（访客 won=0）→ 修复后绿（won=280、awards={guest:280}、净和=0）。
- **C-R2 显示修复**：新增 `client/src/lib/pot-layer-view.js` 纯函数 + `pot-layer-view.test.mjs`（awards 为空绝不按出资人+层金额拼退款，渲染「未到账」空态）；`OnlineRoomView.vue` 结算弹窗与最近三手历史改为 `potLayerView` 驱动，退回/派彩金额一律渲染 `layer.awards`。
- **C-R3 降级观测与门禁**：`decideAction` 内部兜底经 `opts.onDegraded` 上报；`server/index.js` 唯一调度 owner 在决策异常/非法动作/应用被拒时记 `room.aiStats.degraded`；`test-online-ai-perf.mjs` 新增 `AI_PERF_FAULT=persona-params` 故障注入与降级数非零门禁；新增 `scripts/test-online-ai-perf-control.test.mjs` 控制对（正常 exit 0 / 故障 exit 非零且输出含「降级」）。冻结红证据：故障注入跑 24 次决策全程降级仍 exit 0 → 修复后 `AI 决策降级 24 次` 非零退出。

修复后实跑：`node --test shared/logic/side-pot.test.mjs` 12/12；`node --test client/src/lib/pot-layer-view.test.mjs` 4/4；`node --test scripts/test-online-ai-regressions.mjs` 9/9；`node --test scripts/test-online-ai-perf-control.test.mjs` 2/2；`node --test server/ai/regression-v2.test.mjs` 6/6；`node scripts/test-online-ai-perf.mjs 2` 正常路径 37 决策 `degraded:0` 双房 exit 0。T1：`npm run test:logic` 149/149；`node --test server/db.test.mjs` 20/20；`node scripts/test-room-server.mjs` 45/45；`node scripts/test-online-room-server.mjs` 40/40；`npm run test:ai` 21/21；`npm run build --prefix client` 通过；`git diff --check` 通过。

仍 pending：tests-only/功能/评审 SHA 均未生成（工作区未提交）；review-2 独立验收未做；扫码回跳人工验收未做；不部署。既有 dirty `线上模式.md` 仍未触碰。

#### review-2 记录（2026-10-01）

结论：仍不通过，不能进入 6.2。审查对象仍是未提交工作区，HEAD=`903618a4bb523cd0e434299313b259c3ccd01485`。上一轮 C-R1 的单一出资人离场后 280 退回、C-R2 的实际 awards 展示与空态、C-R3 的降级观测及性能故障 nonzero 均已定向验证通过；退款修复扩大到多出资人后出现下面的新问题。

| ID | 等级 / 来源 / 阻塞 | finding 与独立对抗证据 | 下一动作 |
|---|---|---|---|
| R2-R1 | P1 / introduced + incorrect-oracle / 6.1 blocking | `shared/logic/side-pot.mjs:115–124` 把所有 `eligibleUids=[]` 的层退回全部出资人；`server/index.js:944` 同时将其标成未匹配退回，违反 §3.2 的“退款仅指本层只有一个出资人”。真实 HTTP：A 初始 50，B/C 各 500，盲注 10/20；A allin→50，B call→50，C raise→100，B call→100，翻牌后 B `/leave`、C fold。终局 pot=250；主池 150 给 A；已由 B/C 相互匹配的 100 层 contributorUids=[B,C]、eligibleUids=[]，却分别退回 B/C 各 50，isUncalledReturn=true。独立断言“多出资人层不得标为未匹配退回”业务 red（true≠false）。新 `side-pot.test.mjs:176–189` 反而把 B/C 各退 50 写成期望，只证明守恒，未证明派奖/退款语义正确。 | 按 review-2 的集中 repair 规则，先由 A 按 §3.2/F-I3 冻结多人已匹配死钱的独立金额/资格 oracle，再区分唯一出资退款与多人已匹配层的权威分配。不能以“无人具备资格”替代“未被匹配”，不能仅为守恒把已匹配筹码返给弃牌者；保留已通过的单人 280 退款控制及 UI/降级控制。 |

本轮实跑（Node v24.19.0，隔离数据）：`node --test shared/logic/side-pot.test.mjs client/src/lib/pot-layer-view.test.mjs scripts/test-online-ai-perf-control.test.mjs server/ai/regression-v2.test.mjs` 24/24；`node scripts/test-online-ai-regressions.mjs` 9/9；上述额外真实 HTTP 对抗 1 例业务失败并完成房间/服务/数据库/临时数据清理。T1 完整组合核对开发修复记录，本轮不重复同一组合；`git diff --check` 通过。新增回归、性能控制、UI helper/单测仍未 Git 跟踪，`git ls-files --error-unmatch` 失败；没有 tests-only/功能/合入 SHA，人工扫码回跳仍 pending。本轮仅更新审查记录。

#### review-2 修复记录（2026-10-01）

- **R2-R1**：区分「未被匹配」与「无人具备资格」。`side-pot.mjs` 无资格层改为二分支：`contributorUids.length===1` → 未匹配下注按权威 awards 原路退回出资人（保留 C-R1 修复）；多出资人 → 已匹配死钱不退弃牌者，归最近一个有资格层的赢家（底池归胜者），仍写入该层 `awards` 供展示核对。`server/index.js` `isUncalledReturn` 收敛回 `contributorUids.length===1`（§3.2 退款定义）。已修正上轮 `side-pot.test.mjs` 错误 oracle：多出资人死钱层改为断言归胜者且不出现在弃牌者 winnings。
- 冻结红→绿：`side-pot.test.mjs`「多名出资人相互匹配后全部弃牌…死钱」红（b/c 各退 50）→ 绿（a=250）；`test-online-ai-regressions.mjs` 新增 HTTP 复现 review 场景（A=50/B/C=500，A allin→50、B call、C raise→100、B call、翻牌 B `/leave`、C fold）红（b/c 各 won=50）→ 绿（a=250、死钱层 `awards={a:100}`、`isUncalledReturn=false`、净和 0）。
- 修复后实跑：`side-pot.test.mjs` 12/12；`test-online-ai-regressions.mjs` 10/10；`test-online-ai-perf-control.test.mjs` 2/2；`server/ai/regression-v2.test.mjs` 6/6。T1：`npm run test:logic` 149/149；`server/db.test.mjs` 20/20；`test-room-server.mjs` 45/45；`test-online-room-server.mjs` 40/40；`npm run test:ai` 21/21；`npm run build --prefix client` 通过；`git diff --check` 通过。
- 仍 pending：工作区未提交，tests-only/功能/评审 SHA 未生成；review-3 独立验收未做；扫码回跳人工验收未做；不部署。既有 dirty `线上模式.md` 仍未触碰。

#### review-3 记录（2026-10-01）

结论：review-1 的 C-R1/C-R2/C-R3 及 review-2 的 R2-R1 原始场景均已通过当前定向回归；6.1 金额门禁仍因下面的 P1 未通过，6.2 不进入 ready。审查对象仍为 `codex/online-ai-fix` 未提交工作区，HEAD=`903618a4bb523cd0e434299313b259c3ccd01485`，没有可核验的测试冻结/功能/合入 SHA。

| ID | 等级 / 来源 / 阻塞 | finding 与独立对抗证据 | 下一动作 |
|---|---|---|---|
| R3-R1 | P1 / pre-existing + coverage-gap / F-I3 blocking | `side-pot.mjs:125–132` 假设首层必有资格者，实际唯一存活玩家可能 totalBet=0，`lastEligibleWinners=[]`，多人死钱层没有任何 award。真实 HTTP 四人各 500，庄家 A、小盲 B=10、大盲 C=20、首个行动者 D；D fold，未到 B/C 回合时分别 `/leave`，A 尚未行动即为唯一存活者。终局 pot=30，已匹配主池 20 awards=[]，只退 C 未匹配 10；A won=0，winnings 总额=10，净盈亏合计=-20。独立金额守恒断言业务 red（10≠30）。只读载入 baseline 的同一公开分配 API，原实现分配 0/30，当前分配 10/30，证明该边界原已存在，当前 repair 仍漏覆盖。 | 按 §8 review-3 规则单列“零投入唯一存活者结算”规则 repair，先冻结真实 HTTP oracle：A 到账 20，C 未匹配退回 10，B/D 到账 0，总到账=30、净和=0；再补充首层无上一合格赢家的权威分配。保留唯一出资 280 退款、多人已匹配 100 归胜者、UI awards 空态及异常降级全部控制；不连续夹入 AI 补丁。 |

本轮实跑（Node v24.19.0，隔离数据）：`node --test shared/logic/side-pot.test.mjs client/src/lib/pot-layer-view.test.mjs scripts/test-online-ai-perf-control.test.mjs server/ai/regression-v2.test.mjs` 24/24；`node scripts/test-online-ai-regressions.mjs` 10/10。R2-R1 的 HTTP 用例已断言 A won=250、B/C won=0、死钱层 awards={A:100}、isUncalledReturn=false。额外零投入存活者 HTTP 对抗 1 例失败，已完成房间/服务/数据库/临时数据清理。T1 完整组合核对修复记录，本轮不机械重跑；`git diff --check` 通过。新增回归/性能控制/UI helper 及单测仍未 Git 跟踪（`git ls-files --error-unmatch` 失败），人工扫码回跳仍 pending。本轮只更新审查记录，未改功能、提交、合入或部署。

#### review-3 修复记录（2026-10-01）

- **R3-R1（单列规则 repair）**：`side-pot.mjs` 多人已匹配死钱层的级联目标不再假设「首层必有资格者」。`lastEligibleWinners` 为空时（唯一存活者零投入、不在任何出资层里），死钱直接归未弃牌的存活者（底池归胜者）；有资格层赢家存在时维持原级联。仅改 shared 规则与该层测试，不夹入 AI 补丁。
- 冻结红→绿：`side-pot.test.mjs`「零投入唯一存活者接手首层死钱」红（a=undefined）→ 绿（a=20、c 退回 10、总到账 30）；`test-online-ai-regressions.mjs` 新增 HTTP 复现 review 场景（四人各 500，庄家 A、小盲 B=10、大盲 C=20、首个行动者 D；D fold、B/C `/leave`、A 未行动即唯一存活）红（winnings 总额 10、A won=0、净和 -20）→ 绿（A won=20、c 退回 10、总到账 30、净和 0、死钱层 `awards={a:20}`、`isUncalledReturn=false`）。
- 控制保留：单人 280 退款、多人已匹配 100 归胜者、UI awards 空态、异常降级控制全部继续通过。
- 修复后实跑：`side-pot.test.mjs` 13/13；`test-online-ai-regressions.mjs` 11/11；`test-online-ai-perf-control.test.mjs` 2/2；`server/ai/regression-v2.test.mjs` 6/6。T1：`npm run test:logic` 150/150；`server/db.test.mjs` 20/20；`test-room-server.mjs` 45/45；`test-online-room-server.mjs` 40/40；`npm run test:ai` 21/21；`npm run build --prefix client` 通过；`git diff --check` 通过。
- 仍 pending：工作区未提交，tests-only/功能/评审 SHA 未生成；review-4 独立验收未做；扫码回跳人工验收未做；不部署。既有 dirty `线上模式.md` 仍未触碰。

#### review-4 记录（2026-10-01）

结论：当前工作树代码复核通过，review-1 的 C-R1/C-R2/C-R3、review-2 的 R2-R1、review-3 的 R3-R1 已列失败场景全部关闭，未发现新的阻塞 finding。此结论针对未提交工作树，不代表已有测试冻结/功能/合入 SHA，也不代表人工验收或部署完成。

- 定向实跑：`node --test shared/logic/side-pot.test.mjs client/src/lib/pot-layer-view.test.mjs scripts/test-online-ai-perf-control.test.mjs server/ai/regression-v2.test.mjs` 25/25；`node scripts/test-online-ai-regressions.mjs` 11/11。真实 HTTP 零投入场景已断言 A 到账 20、C 未匹配退回 10、B/D 到账 0、总到账 30、净和 0；匹配层 `isUncalledReturn=false`、退款层 `true`，逐层 awards 正确。
- 独立金额组合：通过临时内存脚本枚举 2–5 人、各人投入整数 0–5、每个唯一存活者位置，共 44,784 例。oracle 逐单位筹码高度计数：唯一出资原路退回，多人匹配归唯一存活者；独立于生产台阶分层实现。逐玩家到账与 oracle 一致，逐层 awards 和等于层金额；覆盖零投入存活者、多层死钱、未匹配最高层及全部投入顺序。
- 另 3 项固定控制通过：平局赢家继承死钱并保留唯一出资退款（投入 2/2/5/6，到账 A=7、B=7、D=1）；平局及奇数余数（1/1/2/3/3，A=6、B=4）；不同有效层赢家后续继承死钱（1/2/2/4/4/5，A=6、B=11、F=1）。逐层与总到账均守恒。
- 核对本次修复仅补足无上一合格赢家时的存活者接收目标；单人 280 退回、多人匹配 100 归胜者、UI awards 空态及异常降级控制全部保留。T1 完整组合核对修复者上一条实跑记录，本轮不机械重跑；`git diff --check` 通过。
- 审查 HEAD 仍为 `903618a4bb523cd0e434299313b259c3ccd01485`，分支 `codex/online-ai-fix`；新增回归/控制/UI helper 与单测仍为未跟踪文件。下一动作：将已验收改动及新增文件按任务提交冻结、记录实际功能/评审/合入 SHA，补人工扫码回跳验收，排除既有 dirty `线上模式.md`。本轮只更新审查记录，未修改功能、提交、合入或部署。

6.2 独立准入复核（review-4）：dezhou 当前 HEAD=`7bc27de1ac8a5b8d532f9bf6cb5c4b372809f1af`；`docs/plan/tasks/ai-core-001.md`、`ai-integration-001.md` 均仍为 `status: pending`，`D:/dezhou/packages/poker_ai/` 不存在，newPoker 的 `vendor/poker_ai.manifest.json` 不存在。当前未取得可消费的已 review/合入核心发布 SHA、包/hash/config/fixture；须由 dezhou owner 交付，不能在 6.2 自造共享模型。6.1 本地收尾可现在完成；冻结合入且共享核心交付后进入 6.2，线上模型切换仍须满足 dezhou 集成验收前置。

### 6.2 online-ai-worker-001：固定共享包与进程边界

风险：high（跨进程/超时/可见性）；不在这一任务改server/index.js或应用房间动作。
路径：vendor/poker_ai/、manifest、`scripts/sync-poker-ai.mjs`、`server/ai/worker-client.mjs`、
`server/ai/worker-client.test.mjs`；同核fixture/导出校验脚本；只读shared规则/房间数据。
同步脚本读取明确的已发布包及完整源SHA，校验→候选目录→验收后更新Git文件；不静默覆盖本地vendor改动。

| ID | 不变量 | 故障/控制测试 |
|---|---|---|
| W-I1 | 核心SHA/hash/schema/config固定，运行不依赖D盘 | 缺包/篡改/版本不符拒绝；干净检出合法包通过 |
| W-I2 | 单进程、最多2未完成job，job/generation正确关联 | 两个并发合法控制、第三个overload；拆/粘包、乱序/重复/旧generation |
| W-I3 | deadline/断管/取消只完成一次；退出后无孤儿/定时器/Promise | hanging child/EOF/非法JSON/1MiB超限/崩溃/启动失败/取消时resolve |
| W-I4 | 下一任务最多一次重建；失败清理可观测，无无限重启 | 进程故障→回退→下一合法任务可达；连续失败有限启动计数 |
| W-I5 | 固定观察/seed/工作量与dezhou核心同结果 | 共用fixtures通过CLI和直接API；正常运行不读账号/DB/token |

freeze规模：分transport/frame域与process/lifecycle域，复用一个runner；每域独立fault family<=3。
不为减行数压扁await/oracle；A记录arm fault→请求→错误响应/清理→下一合法控制实际trace。
不以尚不存在worker文件的import错误声称冻结成功；允许tests-only transport double到schema业务anchor。

开发派发词：

```text
在 D:/newPoker 实施线上模式AI优化开发计划.md §6.2 online-ai-worker-001。
先确认fix已review合入、dezhou已发布完整核心SHA和manifest；缺失不重写JS模型。
独立A冻结W-I1到W-I5的协议/进程业务oracle和合法控制；B从accepted freeze实现。
只做固定vendor包、同步验证、一个常驻Python客户端及限界任务/异常清理；不改房间apply或UI。
Python路径显式可配置并记录真实版本；标准库运行，不覆盖系统Python、不新增HTTP端口。
同核一致性、拆粘包、超时/EOF/取消/重建/大小/队列上限全部验证；无孤儿和敏感输出。
完成T0/T1、功能SHA和frozen unchanged，写回记录交独立review；不部署生产。
```

记录：pending；来源完整SHA/逐文件hash、runtime版本、freeze/功能SHA、全部故障trace/清理证据待填。

### 6.3 online-ai-integration-001：模型/动态预算/思考调度

风险：high（真实行动并发/晚结果）；只有本任务把新核接到线上默认路径。
路径：server/index.js的AI调度/公开上下文/内部统计、server/ai/runtime.mjs、policy.mjs薄适配、
`server/ai/integration-v2.test.mjs`、`scripts/test-online-ai-integration.mjs`、必要运行配置。
不允许同时修改vendor算法/config、实际shared规则或存储；发现核心bug回dezhou固定来源修再同步。

| ID | 不变量 | 验收 |
|---|---|---|
| N-I1 | 规范DTO只有自身牌/公开动作，完整下注线和金额/庄位正确 | 输入spy递归白名单；深码/短码/清街/20条以上动作/盲注 |
| N-I2 | 动态N含all-in、每回合重算，配置/实际次数真实 | 全档表；8弃到2升预算，8中6全押不变；forced/exact/截止 |
| N-I3 | 计算与等待并行，逐玩家应用；不堵Node、不同步while连跑 | fake时钟：800等待+300计算→800后apply，10000等待+2000计算→10000后apply |
| N-I4 | job/generation/room/hand/turn/seat匹配，重复/晚/取消0应用 | 等待中重置/销毁/换人/超时→晚响应；降级后旧结果不二次apply |
| N-I5 | 核心是建议者，合法性再校验，所有source同一applyRoomAction | apply计数exact1；短全押不重新开放raise；非法结果合法降级 |
| N-I6 | 双房不串状态、人设跨手稳/重置刷新、清理完整 | 两房交错响应；手结束/服务关闭后task/timer/child引用正确释放 |
| N-I7 | 对手动作/听牌/价格影响决策，不暴露战术 | 共享行为fixture经真实Node适配到核心；私有EV/range不进当前/历史投影 |

冻结按scheduler生命周期与safe观察两个测试域拆分；复用worker已验证fault，不重复其全矩阵。
stateful机制只有一个在途调度owner，handState只有通过有效结果才提交；取消结果不能改变慢打标记。
先核心返回有效再按思考截止应用，排队+结果deadline和最晚思考deadline都必须有测试时钟证明。

开发派发词：

```text
在 D:/newPoker 实施线上模式AI优化开发计划.md §6.3 online-ai-integration-001。
先确认worker和固定核心发布已经独立review；A冻结安全DTO/动态人数/并行等待/晚结果/一次apply。
B只做薄适配和唯一调度owner。Node到AI回合立即提交，计算与0.8–10s等待重叠，合法后apply一次。
按共享配置动态N（含all-in、不含folded/未入手），真实记录requested/used/method/stop。
应用前复核room/hand/turn/seat/generation；重置/换人/销毁/降级后的晚结果零副作用。
不读取其他底牌、不改变public轮询/规则/账号资产；不直接改vendor模型。完成N-I1到N-I7、T0/T1。
提交功能SHA freeze，交独立review；不以mock核替代所有真实模型控制，不在此任务部署。
```

记录：pending；角色/freeze/功能/固定核SHA、一次apply/取消trace、动态预算/真实模型控制、门禁待填。

### 6.4 online-ai-release-001：真实验收、Git拉取与部署

风险：high（生产切换/重启丢失内存房间）。只修验收脚本/配置，不临时改模型或规则。
路径：scripts/test-online-ai-perf.mjs、`scripts/test-online-ai-acceptance.mjs`、
package.json新增准确脚本、ecosystem.server.config.cjs、`docs/线上AI发布验收.md`。
部署者使用已有阿里云ECS部署skill/项目部署上下文，凭证不进Git或日志。

准入与发布步骤：

1. 前三项独立review pass、冻结文件未改；源码/vendor/manifest/配置/fixture/启动脚本都纳入Git。
2. 在干净检出做§7全部gate，另建隔离数据目录。先采旧基线对照，不拿文档探针代替新模型测量。
3. 检查ECS兼容Python。此前只确认系统python3为3.6.8，不能假定现有运行时满足3.11+。
   优先复用已有兼容runtime；缺失时在独立项目runtime/release目录准备固定受支持版本，
   明确来源/版本/安装验证，不替换系统Python或其他站点依赖，不新增付费资源/端口。
4. 生产切换前先读服务/房间健康，安排无活动线上房间窗口；内存房间重启会消失，不在朋友对局中切换。
5. 本地只提交本任务已验收内容，push用户既定Git分支；确认远端完整SHA一致。
6. ECS从Git fetch/pull取得该SHA，禁止scp/上传源码zip绕过Git。推荐在独立release克隆/检出固定SHA，
   安装/构建/校验后切PM2，旧release保留；不在正在运行的目录边拉边构建。
7. 构建client、校验核心manifest、Python CLI/模型版本及启动配置；沿用正式`/var/lib/cangshu`，
   隔离测试目录不能成为正式数据路径；创建码继续环境变量976431，不硬编码进默认代码。
8. PM2正确指向新release、Node+Python版本/SHA一致；检查80网站、health、关键静态资源、8080Wiki。
   不重启通用Nginx、不改已有8080Wiki、不修改安全组；公布URL与release/SHA。
9. 发布失败恢复旧PM2/release配置并验证原站健康。新旧模型选择作为明确的release回滚，不自动混跑。
10. ZIP只清理经只读核对的本项目精确临时文件，保留回滚目录及正式数据；当前已清的旧ZIP不重复删除。

开发/发布派发词：

```text
在 D:/newPoker 执行线上模式AI优化开发计划.md §6.4 online-ai-release-001。
前三项及dezhou固定核发布需review pass。只补验收脚本/运行配置，不夹带模型或规则修复。
真实注册双房和真实AI，按§7测完整云端矩阵/30min并发/手机验收；零样本或失败nonzero退出。
核对代码/vendor/manifest/config/入口均Git跟踪；报告SHA与所有实测数据，不虚称达标。
通过后先提交pushGit，ECS从Git取完全相同SHA到独立release构建，确认无活动线上房间再切换。
沿用正式数据和创建码环境变量，保留旧release；不上传源码zip，不扰动8080Wiki/Nginx/防火墙。
失败回滚并验证；最终交付URL、Git SHA、核心SHA、runtime/性能/人工结果与回滚路径。
```

记录：pending；实际Git远端/本地/ECS SHA、核心SHA、环境、所有gate、手工结果、回滚路径待填。

## 7. 自动门禁、性能与人工验收

### 7.1 各任务 T0/T1（新入口均待相应任务实现）

| 任务 | T0聚焦入口 | T1直接依赖 |
|---|---|---|
| fix | node --test server/ai/regression-v2.test.mjs；node scripts/test-online-ai-regressions.mjs | 原AI/logic/online/room/db +client build |
| worker | node --test server/ai/worker-client.test.mjs；共享fixture CLI/API一致性 | fix +原AI/online、Python核心导入/manifest smoke |
| integration | node --test server/ai/integration-v2.test.mjs；node scripts/test-online-ai-integration.mjs | worker/fix +原AI/logic/online/room/db +client build |
| release | node scripts/test-online-ai-acceptance.mjs | 以下全部已有/新 gate +正式性能/人工 |

现有完整组合（仍必须通过）：

```powershell
npm run test:logic
node --test server/db.test.mjs
node scripts/test-room-server.mjs
node scripts/test-online-room-server.mjs
npm run test:ai
npm run build --prefix client
```

T0目标<=30s/硬上限60s；单测注入时钟，别真实等待10s；T1目标<=5min，慢矩阵独立owner=release。
每功能freeze只跑一次本项目完整组合；review核对可信证据+定向对抗，不机械重复同SHA慢测。
禁止skip/xfail、失败重试取绿、mock所有模型、直接灌终局替代HTTP或仅断言“不崩溃”。
新脚本必须`git ls-files --error-unmatch`证明Git跟踪，有存在性/正常/故障nonzero退出控制。

### 7.2 核心与云端性能 gate

- ECS隔离release/数据目录，24场景：长/短牌×翻/转/河×1/3/5/7对手；每组预热3次、正式20次。
- 长牌完整2500工作量P95<=500ms、所有完整场景组最大<=1500ms；长/短牌都需记录完整矩阵，
  确认实际次数，不能设2500而跑80ms后宣称跑满。
- 动态表95%普通场景在软预算内；线上复杂决策P95<=1000ms、最大<=2000ms+50ms协作裕量。
- 双房每桌1真人+7AI持续30min；真实注册/开局/决策，分别记录各房/人数档/街道/方法。
- state本机RTT P95<=250ms；Node事件循环延迟P99<=150ms；正常输入fallback<=1%。
- Node RSS<=300MiB，Node+AI进程树<=512MiB；末三个5min窗口无持续上升且首尾增量<=64MiB。
- 重复/过期apply=0、跨房污染=0，所有结算守恒；关闭后无在途job/孤儿进程/未清理timer。
- 总思考按回合起点<=10s+100ms；queue+result<=2500ms，取消/进程异常故障单独计数，不混正常fallback率。
- 输出SHA/配置版本/Python/CPU/RNG/牌面/样本数/P50/P95/P99/used/requested/earlyStop/fallback/max；
  空样本、执行不足30min、建房失败或账号未注册必须fail，不能用0ms过门禁。

不达标顺序：查重复求值/范围构造/拷贝/清理 → 在AI核owner提速 → 重新测 → 回计划调整明确预算表。
不能线上私调表、偷偷将模拟重新降到800，不能直接加每房worker/扩云资源掩盖问题。
完整换座牌局比较由dezhou阶段owner执行并共享证据；线上验证同核/适配，不重复训练或每child跑长对局。

### 7.3 用户人工验收（桌面+手机）

1. 未登录扫码保留房号，注册后正常入座；刷新合法座位不变匿名、不重复座位。
2. 同牌力真实平分，踢脚不同解释清楚；每层金额/资格/派奖可查。
3. 结算同时看本手投入、到账、净盈亏，单人未匹配退款不叫净赚；最佳五张与两张底牌能区分。
4. 最近三手查完整公开动作与公牌/合法摊牌；弃牌者底牌保持隐藏，第四手覆盖最旧。
5. AI按BB/池比例合理下注；对方短码全下只匹配有效额，多人允许合法边池。
6. 强听牌有时造池/半诈唬，也能便宜跟注/昂贵弃牌；上家过牌和大加注体感不同，性格有区别。
7. 真人弃牌后两个AI仍逐街逐人动作；正常全员all-in补牌不误报跳街。
8. 同时双房运行；重置/换人/下一手不执行旧AI动作；原人设跨手稳、重置刷新。
9. 标准/短牌、连续>=10手各一轮，手机无卡死；线下建房/加入/计分结算保持。

人工项写实际执行人/日期/结果，未执行写pending，不用“应该能用”放行生产。

## 8. 独立 A / B / C 通用派发词

### A：测试冻结（每个high任务先单独派发）

```text
你是D:/newPoker的独立test-author，不是developer。用户指定任务ID见本计划§6。
只改该任务测试/fixture和本计划记录；功能/规则/vendor/正式数据只读。
把对应不变量转成独立业务oracle，记录真实基线SHA，精确金额/身份/请求数和顺序断言。
已有green回归作为合法控制，缺口要业务red；import/setup red不算。至少证明一个错误实现会被抓住。
异步fault先完成注册/建房等前置，再快照、arm目标fault、请求、响应/清理、下一合法控制。
给每例failure anchor与实际trace；冻结前manifest/命令/path/数量一致。提交tests-only SHA，交review。
不要修功能，不跑30min或全量；B不能在冻结review前启动，不能把未知基线改动夹入freeze。
```

### B：开发通用补充

```text
你是指定任务的developer，按本计划该任务专用派发词执行。
核对依赖/accepted tests-only SHA，先跑聚焦red，冻结测试不得删除/放宽/改oracle。
只做allowlist最小实现；新增防御机制必须有触发/owner/清理/计数/fault-test五项。
最终冻结功能SHA，运行T0/T1与指定完整组合，记录frozen unchanged、真实结果和dirty排除。
更新本计划任务记录到review，交独立C；不自行顺手实现下一个任务或跳过发布门禁。
```

### C：review / 验收

```text
你是指定任务的独立reviewer，读取本计划对应不变量、freeze SHA与功能SHA。
核对三面证明、freeze未改、真实T0/T1证据、公开数据/金额/生命周期、资源清理和版本来源。
完整扫可评路径并一次列全findings，注明P1/P2/P3、blocking与pre-existing/introduced/coverage-gap。
独立定向对抗，不机械重跑同SHA全量/30min；缺证据或环境变了才重新安排owner。
P1回B前先由A固化red；review-2仍P1集中repair，review-3有新P1默认拆任务，不连续补丁。
明确后续任务契约是否要修；只有review pass才允许合入/进入下一任务。普通review不授权生产切换。
```

## 9. 最终交付清单

- 四个线上任务的基线/test-freeze/功能/review/合入完整SHA及不变量→测试映射。
- dezhou共享核心来源SHA、manifest、配置/fixture版本、Python运行路径/版本与干净构建证据。
- 金额/同牌力/踢脚/短码/多人池的精确HTTP结果；登录/历史/底牌来源的自动+人工结果。
- 动态人数次数表、实际sims/earlyStop分布、单/双房性能、队列/进程清理与故障trace。
- 本地Git、远端Git、ECS运行版本一致；URL、独立release/回滚位置、80与8080健康。
- known approximations/未验项目如实列出；不得只凭页面200或AI偶尔出牌声称完成。
