"""Apply responsive CSS and static status groups without altering control scripts."""

import argparse
import hashlib
import os
from pathlib import Path
import re
import tempfile
from datetime import datetime, timezone

STYLE_ID = "atomori-responsive-control"
PATTERN = re.compile(r'<style id="' + STYLE_ID + r'">.*?</style>\s*', re.DOTALL)
STATUS_START = '    <div class="card">\n      <h2>状态</h2>'
STATUS_END = '    <div class="card" id="a2Card">'


def group_status(html):
    if 'class="card atomori-status-grid"' in html:
        return html
    if html.count(STATUS_START) != 1 or html.count(STATUS_END) != 1:
        raise ValueError("Unexpected status-card structure; no change made")
    start = html.index(STATUS_START)
    end = html.index(STATUS_END, start)
    original = html[start:end]
    headings = re.findall(r'<h2(?:\s[^>]*)?>.*?</h2>', original)
    if len(headings) != 4 or not all(label in headings[index] for index, label in enumerate(['状态', '环境温湿度', '环境感应', 'GPS'])):
        raise ValueError("Unexpected status sections; no change made")
    updated = original.replace('class="card"', 'class="card atomori-status-grid"', 1)
    classes = ['atomori-vehicle-status', 'atomori-environment-status', 'atomori-digital-status', 'atomori-gps-status']
    for index, heading in enumerate(headings):
        boundary = '</section>\n      ' if index else ''
        updated = updated.replace(heading, boundary + f'<section class="atomori-status-group {classes[index]}">\n      ' + heading, 1)
    last_closing = updated.rfind('    </div>')
    if last_closing < 0:
        raise ValueError("Missing status-card closing element; no change made")
    updated = updated[:last_closing] + '      </section>\n' + updated[last_closing:]
    return html[:start] + updated + html[end:]


def render(html, css):
    if "<div id=\"grid\">" not in html or 'id="a2Card"' not in html:
        raise ValueError("Unexpected control-page structure; no change made")
    if "</head>" not in html:
        raise ValueError("Missing head element; no change made")
    cleaned = group_status(PATTERN.sub("", html.replace('\r\n', '\n')))
    return cleaned.replace("</head>", f'<style id="{STYLE_ID}">\n{css.strip()}\n</style>\n</head>', 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html", type=Path, required=True)
    parser.add_argument("--css", type=Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    args = parser.parse_args()
    target = args.html.resolve(strict=True)
    original = target.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if digest != args.expected_sha256:
        raise SystemExit("HTML changed since inspection; no change made")
    updated = render(original.decode("utf-8-sig"), args.css.read_text(encoding="utf-8-sig")).encode("utf-8")
    if updated == original:
        print("Layout already current; no change made")
        return
    backup_dir = target.parent / ".atomori-layout-backups"
    backup_dir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = backup_dir / f"index.{stamp}.{digest[:12]}.html"
    with backup.open("xb") as handle:
        handle.write(original)
    descriptor, temporary = tempfile.mkstemp(prefix=".index-layout-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(updated)
        os.chmod(temporary, target.stat().st_mode)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f"Applied layout only; backup: {backup}")
    print(f"SHA256: {hashlib.sha256(updated).hexdigest()}")


if __name__ == "__main__":
    main()
