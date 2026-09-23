# `verified-user` A/B — 第二个场景

验证一件事：**用户亲口立下、仓库里查不到的约定，能不能被记下、之后被用上。**
这是这套框架唯一还没有被证伪的价值主张。

## 场景（与第一个不同类的知识）

| | 场景一（`docs/DELIVERY-GAPS.md` §19、§21） | 本场景（§22） |
|---|---|---|
| 约定 | **写什么内容**：vault 路径、namespace、**顺序** | **放哪里**：示例配置一律 `conf/samples/` |
| 仓库是否透露 | 否 | 否（连 `conf/` 目录都没有） |
| 判据 | 文件内容三样都对 | 文件落在 `conf/samples/` 下 |
| 结果 | 无记忆 0/18 → 有记忆 14/18（p=0.000002） | 无记忆 0/6 → 有记忆 6/6（p=0.0022） |

无记忆那 6 次**每一次都写了文件**，写进 `config/`（模型自己的默认猜测）——
所以差别不是"写不写"，是"写到哪"。

## 怎么跑

```powershell
cd dsh-experience-memory
powershell -ExecutionPolicy Bypass -File tools\verified-user-ab\batch.ps1 -Trials 6 -Start 1
python tools\verified-user-ab\rescore.py "$env:TEMP\dsh-exp-ab2"
node tools\verified-user-ab\stats.mjs
```

- `run-one.ps1 -Mode with|without -Trial N`：一个回合。`with` 先跑一个"会话一"（用户只说那句话、
  让它记住），再在**同一个仓库**上开**新会话**做任务；`without` 只跑任务那一步。
- `rescore.py`：**从文件系统重新打分**。用它，别信 `run-one` 的即时判据——下面那条教训就是那么来的。
- `inspect.py <session 目录>`：把一个回合实际说了什么、调了什么打出来。

## 一条教训（写在这儿，是因为它真的误导过一次结论）

第一版判据枚举了 `conf/`、`conf/samples/`、根目录、`src/` 四处，把无记忆那 6 次全报成
**"没落笔"**——可模型写了，写进了 `config/`，一个没被枚举到的目录。读会话记录才看见。
判据因此改成遍历整个工作区、按路径归类。

**教训**：判据枚举"预期会出现的地方"，就会把"出现在了别处"误报成"什么都没做"。
前者是**错误**，后者是**不作为**，两者不能混——而混了会得出一个完全相反的结论。

## 安全（上一次事故之后）

`wipe.mjs` 会**先打印它要动的绝对路径**，并且除非目标在操作系统临时目录下、
且路径里没有 `dsh-desktop/harness`，否则**直接拒绝**、一个字节都不碰。
`run-one.ps1` 收到拒绝就**中止这一回合**（不带结果），不会拿一个没清干净的库去跑、
再报一个像结果的东西出来。
