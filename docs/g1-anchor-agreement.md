# G1：机器提的锚点 vs 人写的锚点

- 库：`C:\Users\Admin\AppData\Roaming\dsh-desktop\harness\experience-memory\memory.db`
- 提案文件：`tools/proposed-anchors-all.json`
- 工作区：`F:\dsh主工作区`（标识 `d80b18919fe33321`）
- 生成时间：2026-09-25 03:46

## 读数

- 自己声明了锚点的记录：**50** 条
- 提案文件里的记录：**24** 条
- **两边都有（可比对的样本）：14 条**
- 一致（路径级有交集）：**11 / 14** = **78.6%**
- 交并比均值：0.595（1.0 = 两侧完全同一组锚点）

**判定**：⚠️ **只作方向性读数，不算通过也不算失败**（样本 14 < 30）：一致率 78.6% ⇒ 倾向"能自动"

## 逐条（不一致的排前面，两边都列出来供人判）

- ✗ `5fbfe48feae5449935cd` 路径锚点别用"到处都是"的裸名字：一条记录因此占掉 78.8% 的提示、投递率被推到 5.5
    - 人写：`path:anchors.ts`、`path:t2-scenarios.json`
    - 机器：`path:tools.js`
- ✗ `c26aea99f3c60a053842` PowerShell 5.1 按系统 GBK 读无 BOM 的 .ps1：含中文的脚本必须带
    - 人写：`command:executionpolicy`
    - 机器：`path:run_all.ps1`
- ✗ `ed6e6e66d2dbf929fc64` quant worker 是常驻进程：Python 改动同样要重启 DSH 才生效
    - 人写：`path:worker.js`、`command:run_all.ps1`
    - 机器：`path:cli.py`
- ✓ `149ae77e54ecd1ec8f8d` 素材管道：供应商无关 + 假接口自检 + manifest.js 绕开 file:// CO
    - 人写：`path:无为修仙传复刻/素材管道/st_0.7/manifest.js`
    - 机器：`path:manifest.js`
- ✓ `281e38c8bd7c9670fdab` 写锚点前先量它在真实调用里命中多少次：≥300 次的锚点等于"每次都触发"，必须丢弃
    - 人写：`tool:memory_remember`、`path:anchor-cost-table.ts`、`path:anchor-cost.mjs`
    - 机器：`path:anchor-cost.mjs`
- ✓ `4a0a10714d66efb9217e` 自建 agent preset 要自带技能，必须给 skill-filesystem 加 c
    - 人写：`path:.dsh/skills/quant-lessons/skill.md`
    - 机器：`path:skill.md`
- ✓ `5f66d0b2622ff16aac9b` 插件按包名装会装到同名他人包：判身份看仓库地址，出错后必须清 desired.json（不会
    - 人写：`path:dsh-plugin-identity-guard.ps1`、`path:desired.json`
    - 机器：`path:dsh-plugin-identity-guard.ps1`
- ✓ `6cb77cc2fcc2fa3a3a90` 写文本文件禁用 Set-Content/Out-File/重定向（BOM 坑复发 4 次后的
    - 人写：`path:dsh-bom-guard.ps1`
    - 机器：`path:agents.md`、`path:dsh-bom-guard.ps1`
- ✓ `84feae93f4dba1b9a91d` junction 安装的插件，lib/*.js 改动不会被 HMR 热重载（配置正确也没用）
    - 人写：`path:repos/dsh-quant/lib/tools.js`
    - 机器：`path:tools.js`
- ✓ `9bf1684eeb8d36846444` 给工具加参数必须同时改 lib/tools.js，否则会话调不到（Python 单测全绿也发
    - 人写：`path:repos/dsh-quant/lib/tools.js`
    - 机器：`path:tools.js`、`path:cli.py`
- ✓ `bb49d6a97400afc0738a` dsh-bigfat 的 roles/ 与 docs/AI_USAGE_GUIDE.md 是
    - 人写：`path:repos/dsh-bigfat/docs/ai_usage_guide.md`
    - 机器：`path:ai_usage_guide.md`
- ✓ `c9b8e7d6a1ea4b6c9256` 改 DSH 的 settings.yaml 不用重启，实测改动即时可用
    - 人写：`path:repos/dsh-quant/cordis.patch.yml`
    - 机器：`path:cordis.patch.yml`
- ✓ `dd95de58c0e0916e01f0` dsh-quant 阶段台账/NOTICE 会落后于实物，判"做没做"先跑一键验收
    - 人写：`path:repos/dsh-quant/design/progress.json`
    - 机器：`path:progress.json`、`path:run_all.ps1`
- ✓ `ea05071e9a9b173e2dd2` 用户硬要求：一切决定要有依据，没有调研就没有发言权（已写进 AGENTS.md 第五节）
    - 人写：`path:agents.md`
    - 机器：`path:agents.md`

