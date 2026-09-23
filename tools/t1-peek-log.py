import glob, io, os, sys, re
import zstandard

root = os.path.join(os.environ.get('APPDATA', ''), 'dsh-desktop', 'harness', 'sessions')
shown = 0
for log in sorted(glob.glob(os.path.join(root, '**', '*.jsonl.zstd'), recursive=True)):
    try:
        text = zstandard.ZstdDecompressor().stream_reader(open(log, 'rb')).read().decode('utf-8', 'replace')
    except Exception:
        continue
    for line in text.split('\n'):
        if '"name":"memory_remember"' not in line and '"name": "memory_remember"' not in line:
            continue
        print('=' * 70)
        print('文件:', os.path.basename(os.path.dirname(log)))
        print('行长:', len(line))
        print(line[:2500])
        shown += 1
        if shown >= 3:
            sys.exit(0)
