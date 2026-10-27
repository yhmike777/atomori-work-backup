"""Patch only the A2 camera card, style and controller in a downloaded live page."""
from pathlib import Path
import re
import sys

root = Path(__file__).parent

def patch(page):
    joystick = 'id="a2Joystick"' in page
    css_pattern = (r'  #a2Card \{ grid-column:1 / -1; min-width:0; \}.*?(?=  #uavPhoto, #uavStop|  @media \(max-width: 600px\))'
                   if joystick else r'  \[data-a2-dir\][^\n]*\n(?:  #a2Card[^\n]*\n){4}')
    controller_start = (r'const stick = document.getElementById\(\x27a2Joystick\x27\);' if joystick
                        else r'const buttons = Array.from\(document.querySelectorAll\(\x27\[data-a2-dir\]\x27\)\);')
    patterns = [
        (css_pattern, (root / 'a2-joystick.css').read_text(encoding='utf-8')),
        (r'    <div class="card" id="a2Card">.*?(?=    <div class="card" id="leadscrewPanel">)', (root / 'a2-camera.html').read_text(encoding='utf-8') + '\n\n'),
        (r'<script>\s*\(function \(\) \{\s*\x27use strict\x27;\s*' + controller_start + r'.*?</script>', '<script>\n' + (root / 'a2-joystick.js').read_text(encoding='utf-8') + '</script>'),
    ]
    for pattern, replacement in patterns:
        page, count = re.subn(pattern, lambda _: replacement, page, flags=re.S)
        if count != 1:
            raise ValueError(f'Expected exactly one A2 block, found {count}; do not overwrite a changed upstream page.')
    return page

if __name__ == '__main__':
    source, target = map(Path, sys.argv[1:3])
    target.write_text(patch(source.read_text(encoding='utf-8')), encoding='utf-8')
