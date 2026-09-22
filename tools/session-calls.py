#!/usr/bin/env python
"""Turn DSH session logs into the compact call log `tools/replay.mjs` reads.

Read-only. A session log is zstd frames without a content size, so it has to be read with
a stream reader rather than a one-shot decompress. This is the only file that knows that
format, so everything downstream sees plain JSONL.

One line per tool call:

    {"time": <ms>, "turn": n, "name": "edit", "callId": "...",
     "arguments": {...}, "failed": true, "error": "first error text", "session": "..."}

`failed` is the harness's own `isError`, so the mistake side comes from the runtime rather
than from a model's account of what happened.

    python tools/session-calls.py --out tools/calls.jsonl [--limit 12] [--workspace-fragment F-dsh]
"""
import argparse
import glob
import io
import json
import os
import sys

try:
    import zstandard
except ImportError:
    sys.exit('need: pip install zstandard')


def decode(path):
    raw = open(path, 'rb').read()
    return zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)).read().decode('utf-8', 'replace')


def calls_of(path):
    events = []
    for line in decode(path).splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            # A frame boundary can split a line; the next one parses.
            continue

    errors = {}
    for ev in events:
        if ev.get('type') != 'tool/result':
            continue
        message = (ev.get('data') or {}).get('message') or {}
        blocks = message.get('content')
        if not isinstance(blocks, list):
            continue
        if not any(isinstance(b, dict) and b.get('isError') is True for b in blocks):
            continue
        call_id = (message.get('source') or {}).get('callId')
        if not isinstance(call_id, str):
            continue
        text = ''
        for block in blocks:
            inner = block.get('content') if isinstance(block, dict) else None
            if isinstance(inner, list) and inner and isinstance(inner[0], dict):
                text = str(inner[0].get('text', ''))[:300]
                break
        errors[call_id] = text

    for ev in events:
        if ev.get('type') != 'tool/call':
            continue
        data = ev.get('data') or {}
        raw_arguments = data.get('arguments')
        try:
            parsed = json.loads(raw_arguments) if isinstance(raw_arguments, str) else raw_arguments
        except Exception:
            parsed = raw_arguments
        call_id = data.get('callId')
        yield {
            'time': ev.get('time'),
            'turn': data.get('turn'),
            'name': data.get('name'),
            'callId': call_id,
            'arguments': parsed,
            'failed': isinstance(call_id, str) and call_id in errors,
            'error': errors.get(call_id, '') if isinstance(call_id, str) else '',
        }


def main():
    default_sessions = os.path.join(os.environ.get('APPDATA', ''), 'dsh-desktop', 'harness', 'sessions')
    ap = argparse.ArgumentParser()
    ap.add_argument('--sessions', default=default_sessions)
    ap.add_argument('--workspace-fragment', default='F-dsh',
                    help='only session directories whose name contains this')
    ap.add_argument('--out', default=os.path.join('tools', 'calls.jsonl'))
    ap.add_argument('--limit', type=int, default=0, help='0 = every matching session, else the N largest')
    args = ap.parse_args()

    files = []
    for directory in glob.glob(os.path.join(args.sessions, '*')):
        if args.workspace_fragment not in os.path.basename(directory):
            continue
        for path in glob.glob(os.path.join(directory, '*', 'session.v3.jsonl.zstd')):
            files.append((os.path.getsize(path), path))
    files.sort(reverse=True)
    if args.limit:
        files = files[:args.limit]
    if not files:
        sys.exit(f'没有匹配的会话日志：{args.sessions} 里名字含 {args.workspace_fragment!r} 的目录')

    total = 0
    with open(args.out, 'w', encoding='utf-8', newline='\n') as out:
        for size, path in files:
            session = os.path.basename(os.path.dirname(path))
            count = 0
            try:
                for call in calls_of(path):
                    call['session'] = session
                    out.write(json.dumps(call, ensure_ascii=False) + '\n')
                    count += 1
            except Exception as exc:
                print(f'  ! {session}: {type(exc).__name__} {exc}', file=sys.stderr)
            total += count
            print(f'  {session[:44]:46s} {size / 1e6:7.1f}MB  calls {count}')
    print(f'wrote {total} calls from {len(files)} sessions -> {args.out}')


if __name__ == '__main__':
    main()
