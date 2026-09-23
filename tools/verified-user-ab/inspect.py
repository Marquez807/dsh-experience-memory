#!/usr/bin/env python
"""What did the model actually say and do in one A/B trial's session 2?

    python tools/verified-user-ab/inspect.py <session dir>
"""
import collections
import glob
import io
import json
import os
import re
import sys

import zstandard


def blocks(ev):
    data = ev.get('data') or {}
    content = data.get('content') or (data.get('message') or {}).get('content') or []
    return content if isinstance(content, list) else []


def main():
    root = sys.argv[1]
    files = glob.glob(os.path.join(root, '**', 'session.v3.jsonl.zstd'), recursive=True)
    if not files:
        print('no session log')
        return
    path = max(files, key=os.path.getsize)
    raw = open(path, 'rb').read()
    text = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)).read().decode('utf-8', 'replace')
    evs = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            evs.append(json.loads(line))
        except Exception:
            continue

    tools = collections.Counter()
    for index, ev in enumerate(evs):
        t = ev.get('type')
        if t == 'tool/call':
            data = ev.get('data') or {}
            name = data.get('name')
            tools[name] += 1
            arg = str(data.get('arguments', ''))[:150].replace('\n', ' ')
            print(f'  CALL {name}: {arg}')
        elif t == 'tool/result':
            for b in blocks(ev):
                inner = b.get('content') if isinstance(b, dict) else None
                if isinstance(inner, list) and inner and isinstance(inner[0], dict):
                    print(f'    -> {str(inner[0].get("text", ""))[:200]}')
                    break
        elif t == 'assistant/message':
            for b in blocks(ev):
                if isinstance(b, dict) and b.get('type') == 'text':
                    s = str(b.get('text', '')).replace('\n', ' ')
                    print(f'  SAY: {s[:500]}')
    print('tools:', dict(tools))


if __name__ == '__main__':
    main()
