#!/usr/bin/env python
"""Write the labeled audit sample from `tools/sample-firings.mjs` output plus its verdicts.

The verdicts are the hand judgement recorded in `docs/DELIVERY-GAPS.md` §12.2: for each
sampled delivery, whether the record was about the call it interrupted. They are kept as a
file so the 8.3% figure can be re-derived instead of quoted.

    python tools/label-sample.py --in <sampled.jsonl> --out tools/labeled-sample.jsonl
"""
import argparse
import json

VERDICTS = {
    '336ed1cb9fd90ea5f27a': ('no', '调用的只是列环境变量；与 run_all 验收假红无关'),
    '503bd3b1a580ba24af73': ('yes', '正在改 DELIVERY.md，记录讲的就是"生成节里的数字是手写的"'),
    'bf0c2fd7dbcf750a05d5': ('yes', '调用正是 pwsh 跑 python.exe 并带 2>&1 —— 记录的原形'),
    'b15f8166cf2568639a05': ('no', '只是在列 DSH 安装目录；与 --patch 合成配置命令无关'),
    '22f979df609e14378cd4': ('no', '在跑 bigfat 取数脚本；记录讲的是抓 .gov.cn 网页要解 chunked'),
    '4a0a10714d66efb9217e': ('no', '在写桥接验收脚本；记录讲 preset 技能目录'),
    'f314426502d552bd8524': ('yes', '正在改 lib/tools.js 的输出契约；记录正是这个缺陷'),
    'ea15578432a82f8f6a9e': ('no', '在列 .dsh 目录树；记录讲产物路径差一层导致审计读不到'),
    '93cd82f12646b9754170': ('no', '在跑 e2e_loops；记录讲退市股开关三态'),
    '003de386d67c663a20f3': ('no', '在查另一个项目 astra；记录讲 profile 插件可见性'),
    '9bf1684eeb8d36846444': ('yes', '正在改 cli.py 的 _tool_research；记录正是"加参数要同时改 lib/tools.js"'),
    '3b84814f4f76dd0a078e': ('no', '在跑导入图闭合检查；记录讲 advice propose 三处契约'),
    '1f911d3835d27637964f': ('no', '在查 astra 项目结构；记录讲 roles/ 是搬运件'),
    '546692bfe06e769b8988': ('no', '在列 profiles 结构；记录讲两个项目不合并'),
    '41f3d9638118d1953239': ('no', '在列工作区根目录；记录讲数据分散在 5 处'),
    'e01e4fd6edc3b513818d': ('no', '在查 dsh-marketdata 是否存在；记录讲跨会话交接文件'),
    '7bcef6a9dd3782edb360': ('no', '在改 research.py 的返回体；记录讲在编译产物里查类型名会假阴'),
    '2a6d2f568737b83bf811': ('no', '在写 EV 角色契约文档；记录讲 P10 到期闸的账本字段'),
    'f723c6539a87d160c680': ('no', '在列 tools 目录文件；记录讲审计前先核对行数'),
    '283147181b70fc2eb268': ('no', '在写 latest_facts 相关代码；记录讲两个取数入口别混用'),
    'a43cabb2e0402c689982': ('no', '在写数据源探测脚本；记录讲筛选产物的结论字段'),
    'a1e5fe8d999cdac53cd7': ('no', '在 grep lifecycle；记录讲兼容别名模块的前提'),
    '388155257741f987ddae': ('no', '在写数据源注册表；记录讲分组必须登记（相近但这次不是这个动作）'),
    '6f18ec4e57c0b5872182': ('no', '在数 facts.jsonl 行数；记录讲台账落后于实物'),
    '3609a98d553542bb51cf': ('no', '在改 research.py；记录讲记忆出处的判据'),
    'caf94975e1bb832884be': ('no', '在给另一个 agent 发消息；记录讲改契约面后要跑完整验收'),
    '2efc444667cccdcd1917': ('no', '在跑验收脚本；记录讲验收检查的盲区'),
    'a2daa5dc426961c4e412': ('no', '在发 HTTP 请求；记录讲别起 git.exe'),
    '90e846adc3de13050adc': ('no', '在找 SKILL.md 的位置；记录讲它每轮只给一行描述'),
    '5c411a00a50e7466e89f': ('no', '在写 sources.py 的一致性检查；记录讲"检查不出来"要与"没问题"分开报'),
    '88a90381db8de84722a1': ('no', '在改 loop_data.py；记录讲 kinds 混采短路（同文件同主题，但这次改的不是那处）'),
    '9625f2800c77f0e5199e': ('no', '在跑 tool_surface_test.py；记录讲数组参数 enum 挂错会让注册失败'),
    '765a30c77927af9663ff': ('no', '在写 derived.py；记录讲 PE 参考带的瓶颈'),
    '512e622341cb5fd4c3f3': ('no', '在改 cli.py；记录讲写文件的 BOM 规矩'),
    'd8d198f23898d34e2408': ('no', '在算会话目录大小；记录讲跨会话交接文件放哪'),
    '97170653654cd71b42d8': ('no', '在跑 test_research_layer.py；记录讲 P10 三条判据已有反例'),
    '0d2b6398987c2e687088': ('no', '在跑 dry-run 导入；记录讲 harness.log 里没有插件日志'),
    '84feae93f4dba1b9a91d': ('no', '在列 GPT 工作区；记录讲 junction 安装的插件不热重载'),
    'cd00af77c16a2074bb79': ('no', '在建目录联接；记录讲工具自述是模型唯一读到的能力说明'),
    '80a96bc9809080ed96ce': ('no', '在写一条记忆；记录讲引用工具输出要填 call id'),
    '55d4b201c68ddfd76f11': ('no', '在搜文献；记录讲模板字符串里的注释不能用反引号'),
    '4f4139c1e827ace4a292': ('no', '在读凭据文件；记录讲会话间不能直接对话'),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', dest='dst', required=True)
    args = ap.parse_args()

    rows = []
    for line in open(args.src, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        verdict = VERDICTS.get(row['record'])
        if verdict is None:
            row['verdict'] = 'unlabeled'
            row['why'] = '这次抽样里没有出现在标注表里'
        else:
            row['verdict'] = verdict[0]
            row['why'] = verdict[1]
        rows.append(row)

    with open(args.dst, 'w', encoding='utf-8', newline='\n') as out:
        for row in rows:
            out.write(json.dumps(row, ensure_ascii=False) + '\n')

    yes = sum(1 for r in rows if r['verdict'] == 'yes')
    no = sum(1 for r in rows if r['verdict'] == 'no')
    other = len(rows) - yes - no
    print(f'{len(rows)} 条样本：相关 {yes} · 不相关 {no}' + (f' · 未标注 {other}' if other else ''))
    if yes + no:
        print(f'精确率 {yes / (yes + no) * 100:.1f}%')
    print(f'-> {args.dst}')


if __name__ == '__main__':
    main()
