#!/usr/bin/env python
"""Pull every `memory_remember` call out of every session log, with its correction quotes.

    python .exp-scan-all.py --out .exp-all-calls.json
"""
import argparse
import glob
import io
import json
import os
import sys

import zstandard


def events(path):
    raw = open(path, 'rb').read()
    text = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)).read().decode('utf-8', 'replace')
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except Exception:
            continue


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sessions', default=os.path.join(os.environ['APPDATA'], 'dsh-desktop', 'harness', 'sessions'))
    ap.add_argument('--out', default='.exp-all-calls.json')
    args = ap.parse_args()

    files = glob.glob(os.path.join(args.sessions, '*', '*', 'session.v3.jsonl.zstd'))
    files.sort(key=os.path.getsize, reverse=True)
    print(f'{len(files)} session logs', file=sys.stderr)

    calls = []
    corrections = []
    for index, path in enumerate(files):
        try:
            for ev in events(path):
                if ev.get('type') != 'tool/call':
                    continue
                data = ev.get('data') or {}
                name = data.get('name')
                if name not in ('memory_remember', 'memory_correct'):
                    continue
                raw = data.get('arguments')
                if isinstance(raw, str):
                    try:
                        raw = json.loads(raw)
                    except Exception:
                        continue
                if not isinstance(raw, dict):
                    continue
                raw['_session'] = os.path.basename(os.path.dirname(path))
                raw['_time'] = ev.get('time')
                if name == 'memory_remember':
                    calls.append(raw)
                else:
                    corrections.append(raw)
        except Exception as exc:
            print(f'  ! {path}: {type(exc).__name__} {exc}', file=sys.stderr)
        if index % 20 == 0:
            print(f'  ..{index}', file=sys.stderr)

    # Latest first, so a later re-record wins when the same title appears twice.
    calls.sort(key=lambda c: c.get('_time') or 0, reverse=True)
    payload = {'calls': calls, 'corrections': corrections}
    with open(args.out, 'w', encoding='utf-8', newline='\n') as out:
        json.dump(payload, out, ensure_ascii=False, indent=1)
    print(f'remember calls: {len(calls)}  corrections: {len(corrections)} -> {args.out}')


if __name__ == '__main__':
    main()
