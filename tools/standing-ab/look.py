"""把隔离 home 里的会话日志解开，找 'managed-by' / '常驻规矩' 到底出现在哪里。
用法：python look.py <sessions 目录> [关键词]
"""
import sys, os, json
from pathlib import Path

root = Path(sys.argv[1])
needles = sys.argv[2:] or ['managed-by', '常驻规矩']

def decompress(path: Path) -> str | None:
    raw = path.read_bytes()
    if raw[:1] == b'\x28':  # zstd magic 0x28B52FFD
        try:
            import zstandard
            return zstandard.ZstdDecompressor().decompressobj().decompress(raw).decode('utf-8', 'replace')
        except Exception as exc:
            return f'<zstd 解不开: {exc}>'
    try:
        return raw.decode('utf-8', 'replace')
    except Exception:
        return None

files = sorted(root.rglob('*'), key=lambda p: p.stat().st_mtime if p.is_file() else 0)
files = [p for p in files if p.is_file()]
lines = [f'会话文件 {len(files)} 个']
for path in files:
    text = decompress(path)
    if text is None:
        continue
    hits = {n: text.count(n) for n in needles if n in text}
    rel = path.relative_to(root)
    lines.append(f'--- {rel} ({path.stat().st_size} 字节) 命中: {hits if hits else "无"}')
    for n in needles:
        idx = text.find(n)
        if idx >= 0:
            lines.append(f'    「{n}」上下文: ...{text[max(0,idx-300):idx+200]}...'.replace('\n', ' ⏎ '))
            break
out = Path(r'F:\dsh主工作区\scratch\standing-ab\look-report.txt')
out.write_text('\n'.join(lines), encoding='utf-8', newline='\n')
print('report written:', out, 'files:', len(files))
print('arms with hits:', sum(1 for l in lines if '命中: 无' not in l and '命中' in l))
