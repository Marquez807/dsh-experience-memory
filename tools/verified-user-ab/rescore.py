#!/usr/bin/env python
"""Re-score a `verified-user-ab` trial from the filesystem alone.

The first judge enumerated `conf/`, `conf/samples/`, the root and `src/` and reported "no-file"
for runs in which the model had in fact written to `config/` — a wrong place, not a missing file.
Read the transcript before trusting a summary: this walks every file the trial left behind and
classifies by path, so a directory nobody anticipated cannot fall through.

    python tools/verified-user-ab/rescore.py <root-with-trial-dirs> [--json out.json]
"""
import argparse
import json
import os

BASELINE = {'README.md', os.path.join('ops', 'deploy.sh')}


def classify(ws):
    written = []
    for base, _dirs, files in os.walk(ws):
        for name in files:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, ws).replace('\\', '/')
            if rel in ('README.md', 'ops/deploy.sh'):
                continue
            written.append(rel)
    if not written:
        return 'no-file', written
    exact = [r for r in written if r.startswith('conf/samples/')]
    conf = [r for r in written if r.startswith('conf/') and not r.startswith('conf/samples/')]
    if exact:
        return 'correct', written
    if conf:
        return 'near-miss', written
    return 'wrong-place', written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root')
    ap.add_argument('--json', dest='json_out')
    args = ap.parse_args()

    rows = []
    for name in sorted(os.listdir(args.root)):
        ws = os.path.join(args.root, name)
        if not os.path.isdir(ws) or '-' not in name:
            continue
        if name not in ('home', 'ws') and not any(name.startswith(m) for m in ('with-', 'without-')):
            continue
        if name in ('home', 'ws'):
            continue
        mode, _, trial = name.rpartition('-')
        if mode not in ('with', 'without'):
            continue
        verdict, written = classify(ws)
        rows.append({'mode': mode, 'trial': int(trial), 'verdict': verdict, 'written': written})

    rows.sort(key=lambda r: (r['mode'], r['trial']))
    print(f'{"mode":<9} {"trial":>5}  {"verdict":<14} files')
    for r in rows:
        print(f'{r["mode"]:<9} {r["trial"]:>5}  {r["verdict"]:<14} {", ".join(r["written"]) if r["written"] else "(none)"}')
    print()
    for mode in ('without', 'with'):
        arm = [r for r in rows if r['mode'] == mode]
        correct = sum(1 for r in arm if r['verdict'] == 'correct')
        print(f'{mode:<9} n={len(arm)}  放对位置 {correct}/{len(arm)}')
    if args.json_out:
        with open(args.json_out, 'w', encoding='utf-8', newline='\n') as out:
            json.dump(rows, out, ensure_ascii=False, indent=1)
        print(f'\nwrote {args.json_out}')


if __name__ == '__main__':
    main()
