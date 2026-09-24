## T2 结果（读 tools/t2-results-t4.jsonl；每格取最后一条有效行）

- **底板指纹**：3acd36f1359d（1 个取值，18 行有指纹，0 行无）
- ✅ 底板可复核：所有格子来自同一份冻结底板。

| 场景 | 组 | run1 | run2 | run3 | 通过 |
|---|---|---|---|---|---|
| handoff | none | ✗ | ✗ | ✗ | 0/3 |
| handoff | rel | ✓ | ✓ | ✓ | 3/3 |
| handoff | fam | ✗ | ✓ | ✓ | 2/3 |
| handoff | ctrl1 | ✗ | ✗ | ✗ | 0/3 |
| handoff | ctrl2 | ✗ | ✗ | ✗ | 0/3 |
| handoff | ctrl3 | ✗ | ✗ | ✗ | 0/3 |

| 场景 | 不用经验 none | 对口经验 rel | 无关对照 ctrl1 | ctrl2 | ctrl3 | 对照合计 |
|---|---|---|---|---|---|---|
| handoff | 0/3 | 3/3 | 0/3 | 0/3 | 0/3 | 0/9 |

### 照冻结读法逐条对（`tools/t2-plan.md` §一）

- **handoff**（T4 合并 vs 分开）：合并版 rel 3/3 vs 分开版 fam 2/3 vs 不喂 none 0/3 ⇒ 打平/不可判（差 ≤1 次，n=3）⇒ 只能说"合并没有明显收益"，不能说更好

无效行（占位、不计入）：0 条
未测或无效的格子：0 / 18
跳过（预检门判定无判别力，未计入上表）：bom、tplcomment、wipeguard
