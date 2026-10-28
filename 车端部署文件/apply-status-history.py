"""Patch only status display/polling in the inspected live car page, with a hash guard."""

import argparse
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import tempfile

START = '  // 状态轮询（2Hz）'
END = '  // 雷达扫描图（5Hz 轮询 /api/scan.json，canvas 极坐标绘制）'
POSE_START = '  // 小车定位标记轮询（2Hz，与状态轮询同频；定位由 AMCL 提供 map 系位姿）'
POSE_END = '  function drawNavMap()'
MARKER = '  // ATOMORI_STATUS_HISTORY_V1'
COLOR = 'var markerColor = robotLocalizationConfidence === "low" ? "#e0a040" : "#40c080";'


def render(html, display, localization):
    html = html.replace('\r\n', '\n')
    if MARKER in html:
        return html
    for anchor in (START, END, POSE_START, POSE_END):
        if html.count(anchor) != 1:
            raise ValueError(f'Unexpected live HTML structure: {anchor}; no change made')
    first, last = html.index(START), html.index(END)
    html = html[:first] + display.rstrip() + '\n\n' + html[last:]
    first, last = html.index(POSE_START), html.index(POSE_END)
    html = html[:first] + localization.rstrip() + '\n\n' + html[last:]
    if html.count(COLOR) != 1:
        raise ValueError('Unexpected map-marker render; no change made')
    return html.replace(COLOR, 'var markerColor = robotLocalizationConfidence === "none" ? "#9aa8b6" : robotLocalizationConfidence === "low" ? "#e0a040" : "#40c080";', 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--html', required=True, type=Path)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--display', type=Path, default=Path(__file__).with_name('atomori-status-display.js'))
    parser.add_argument('--localization', type=Path, default=Path(__file__).with_name('atomori-status-localization.js'))
    args = parser.parse_args()
    target = args.html.resolve(strict=True)
    original = target.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if digest != args.expected_sha256:
        raise SystemExit('Live HTML changed since inspection; no change made')
    updated = render(original.decode('utf-8-sig'), args.display.read_text(encoding='utf-8-sig'), args.localization.read_text(encoding='utf-8-sig')).encode('utf-8')
    if updated == original:
        print('Status history already installed; no change made')
        return
    backup_dir = target.parent / '.atomori-status-backups'
    backup_dir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = backup_dir / f'index.{stamp}.{digest[:12]}.html'
    with backup.open('xb') as handle:
        handle.write(original)
    descriptor, temporary = tempfile.mkstemp(prefix='.index-status-', dir=target.parent)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(updated)
        os.chmod(temporary, target.stat().st_mode)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f'Applied display-only history and serialized GET polling; backup: {backup}')
    print(f'SHA256: {hashlib.sha256(updated).hexdigest()}')


if __name__ == '__main__':
    main()
