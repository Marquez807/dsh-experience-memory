## T2 结果（读 tools/t2-results-g5.jsonl；每格取最后一条有效行）

- **底板指纹**：90004cfd5e45（1 个取值，6 行有指纹，0 行无）
- ✅ 底板可复核：所有格子来自同一份冻结底板。

| 场景 | 组 | run1 | run2 | run3 | 通过 |
|---|---|---|---|---|---|
| psencoding | none | ✓ | ✓ | ✓ | 3/3 |
| psencoding | p1 | ✓ | ✓ | ✓ | 3/3 |
| psencoding | p2 | · | · | · | 0/0 |
| psencoding | p3 | · | · | · | 0/0 |
| psencoding | p4 | · | · | · | 0/0 |
| psencoding | p5 | · | · | · | 0/0 |
| psencoding | ctrl1 | · | · | · | 0/0 |

| 场景 | 不用经验 none | 对口经验 rel | 无关对照 ctrl1 | ctrl2 | ctrl3 | 对照合计 |
|---|---|---|---|---|---|---|
| psencoding | 3/3 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |

### 照冻结读法逐条对（`tools/t2-plan.md` §一）

- **psencoding**（G5 一景多测，5 条记录各占一个臂）
  - ⚠️ **天花板：none 臂在所有分项上都 100%**（out_no_bom、ps1_bom、line3_right）⇒ 这一族记录的效果
    在这一格**测不出来**（不是"没用"）。换任务，或者换一族模型自己不会的记录，否则跑多少格都是 0。

  | 检查点 | none | 一条无关对照 | 各臂（记录） |
  |---|---|---|---|
  | out_no_bom | 100% | — | p1=100% |
  | ps1_bom | 100% | — | p2=— · p3=— |
  | line3_right | 100% | — | p4=— · p5=— |

  - `p1`（管 out_no_bom）：有它 100% vs 没有 100% ⇒ **effect = 0** ⇒ 这条记录在这一项上**没有任何可测效果**（不是"没用"，是"测不出来"）
  - `p2` ps1_bom：未跑完，不下结论
  - `p3` ps1_bom：未跑完，不下结论
  - `p4` line3_right：未跑完，不下结论
  - `p5` line3_right：未跑完，不下结论


无效行（占位、不计入）：0 条
未测或无效的格子：15 / 21
  psencoding/p2/1、psencoding/p2/2、psencoding/p2/3、psencoding/p3/1、psencoding/p3/2、psencoding/p3/3、psencoding/p4/1、psencoding/p4/2、psencoding/p4/3、psencoding/p5/1、psencoding/p5/2、psencoding/p5/3、psencoding/ctrl1/1、psencoding/ctrl1/2、psencoding/ctrl1/3
跳过（预检门判定无判别力，未计入上表）：bom、tplcomment、wipeguard、handoff
