"""Remove the UAV camera card and its independent CSS/controller from a live page."""
from pathlib import Path
import re
import sys


def patch(page):
    replacements = [
        (r'  #uavCard \{ grid-column: 1 / -1; \}.*?(?=  #a2Card \{)', ''),
        (r'  #uavPhoto, #uavStop \{[^\n]*\}\n', ''),
        (r'\.uav-layout \{ grid-template-columns: 1fr; \} ', ''),
        (r'    <div class="card" id="uavCard">.*?(?=    <div class="card">\s*<h2>雷达扫描</h2>)', ''),
        (r'<script>\s*\(function \(\) \{\s*\x27use strict\x27;\s*const video = document.getElementById\(\x27uavVideo\x27\);.*?</script>\s*', ''),
    ]
    for pattern, replacement in replacements:
        page, count = re.subn(pattern, replacement, page, flags=re.S)
        if count != 1:
            raise ValueError(f'Expected one UAV camera block, found {count}; inspect the current page before applying.')
    if re.search(r'/api/uav/|uavCard|uavVideo|uav-layout|uav-pad|data-uav-dir', page):
        raise ValueError('Unexpected remaining UAV camera references; inspect before deploying.')
    return page


if __name__ == '__main__':
    source, target = map(Path, sys.argv[1:3])
    target.write_text(patch(source.read_text(encoding='utf-8')), encoding='utf-8')
