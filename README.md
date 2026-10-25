# dsh-context-budget — 上下文预算审计（DSH 插件）

> 每一轮对话，模型都被重新喂一遍同一堆东西：system prompt、AGENTS.md、60+ 个技能的目录、几十个工具的 schema、运行时快照。
> 它们逐字节相同，**模型不需要再知道一遍**。这个插件就是来量这件事的。

在真实机器的会话日志上实测：一个 34 轮的会话，注入上下文 **256k token，其中 37.4%（95.8k）是逐字节重复的内容**。
system prompt 被重发 6 遍（16.8k token 白付），skill catalog 被重发 3 遍（12.7k token 白付）。
这不是压缩能解决的问题——压缩省的是历史，这是**固定开销在复利**。

## 安装

```sh
dsh plugin --profile desktop add @bushizhanghan/dsh-context-budget
```

重启 DSH 后生效。**只读**：从不写你的会话日志，也不调 LLM——每个数字都能从日志里手算复核。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `ctx_budget` | 审计单个会话：每轮注入构成（system / AGENTS.md / skill catalog / tools / runtime / team / history），以及逐字节重复的纯浪费 |
| `ctx_budget_sweep` | 扫描所有会话，按浪费量排序，看哪段对话的固定开销最重 |
| `ctx_budget_skills` | 技能目录治理：每轮要为 60+ 个技能的描述付多少 token，哪些该懒加载 |
| `ctx_budget_tools` | 工具 schema 膨胀：哪个插件的工具定义每轮占用最多上下文 |

## 分类口径

| 类别 | 来源 |
|---|---|
| `system` | `system/message`：组装好的 system prompt，每轮重建 |
| `agents` | `user/message` + `source.kind = agent-instructions`：AGENTS.md 等工作区指令 |
| `skills` | `user/message` + `source.kind = skill-catalog`：`<system-reminder>` 里的技能目录 |
| `tools` | `request/header.data.header.tools`：实际发出的工具 schema 数组 |
| `runtime` | `runtime-context` / `time-context` / `model-selection` |
| `team` | `agent-teams` / `agent-message` / `subagent-settled` |
| `history` | `user` / `compact-checkpoint`：真实对话与压缩检查点 |
| `other` | 未识别的新注入面——**不静默丢弃**，这样未来 DSH 新增注入面会自己冒出来 |

## 浪费判定

一个块在第 N 轮和第 N+k 轮签名相同（长度 + 头 32 字符 + 尾 32 字符）即为重复。
**第一次出现不是浪费**（模型总得看一遍），之后每次都是。历史不计入浪费——它是合法累积的。

## 它在真实数据上发现了什么

```
context budget · session-88fbc2a8…: 34 turns, 68 request(s)
  injected context total (est): 256079 tok
  repeated unchanged content: 95792 tok (37.4% of injected)

composition (est tokens, summed over turns)
  system       105034  (33 block(s))
  skills        63633  (16 block(s))
  history       36098  (170 block(s))
  tools         19486  (1 block(s))
  team          18320  (40 block(s))
  runtime       10765  (135 block(s))
  agents         2355  (3 block(s))

tool schema inflation (est tokens per turn)
  plugin:agent-teams          5170  (18 tool(s))
  tool:code_review            2325  (6 tool(s))
  mcp:wincu                   2284  (10 tool(s))

skill catalog: 59 skills, 5022 est tok per turn
  academic-research-suite     133 tok  used 0x
  scientific-toolkit-skill    133 tok  used 0x
  wechat-miniprogram-design   133 tok  used 0x
```

三条可执行的结论：

1. **AgentTeams 插件 18 个工具 = 5170 token/轮**，是最大的单一固定开销；其中多数在非团队会话里根本用不到。
2. **59 个技能目录 = 5022 token/轮**，而实测整台机器被调用过的技能只有 7 个。最贵的 10 个技能从未被调用，却每轮全价付费。
3. **system prompt 每轮 3370 token**，跨轮几乎不变——唯一真正在变的是 GUI URL 和工作目录两行。

## 设计取舍

- **先读日志再写规则。** 第一版假设会话日志是 UTF-8，在真实机器上 94 个会话全部解析失败——GUI 启动的会话是 **UTF-16LE 带 BOM**。现在按 BOM 嗅探，两种编码都见过。
- **目录层级是 `<workspace>/session-<uuid>/`**，根和会话目录之间隔着一层 workspace，平铺扫描根目录什么都找不到。向下走两层。
- **CJK 按 1 字符 = 1 token 算。** 这台机器上的会话以中文为主，按 4 字符 = 1 token 会把中文提示低估约 4 倍。
- **`estimateTokens` 是估计值，报告里一律标 `est`。** 这个插件要的是**比例**——同一除数在比值里抵消。需要精确数字时用 `request/context` 的 `contextWindow` 做分母。
- **懒加载规则故意保守**：只标记"本轮从未调用且描述 ≥ 60 token"的技能。用过一次的技能永不标记；没有使用信号的技能不猜测它已死（它可能在别的会话里被用）。
- **未识别的 `source.kind` 归入 `other` 而不是丢弃**，否则未来 DSH 新增注入面会让审计数字悄悄变小而没人发现。

## 测试

```sh
node --test test/
```

`test/engine.test.mjs` 一条规则一个测试（token 估计、CJK、分类映射、签名、重复判定、技能治理、工具分组、空会话不除零）。
`test/integration.test.mjs` 用假 `ctx = { tools: { register } }` 启动插件，驱动全部 4 个工具打真实会话日志，
并断言反向情况：不存在的会话/根目录必须返回 `ok: false`。

## License

MIT
