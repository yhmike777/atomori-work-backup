import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('status_patch', ROOT / 'apply-status-history.py')
PATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCH)


class StatusPatchTests(unittest.TestCase):
    def test_only_read_render_blocks_change_and_patch_is_idempotent(self):
        before = 'control POST code stays exact\n'
        between = 'lidar and mapping implementation stays exact\n'
        after = 'navigation actions stay exact\n'
        html = before + PATCH.START + '\nOLD_STATUS\n' + PATCH.END + '\n' + between + PATCH.POSE_START + '\nOLD_POSE\n' + PATCH.POSE_END + '\n' + PATCH.COLOR + '\n' + after
        display = (ROOT / 'atomori-status-display.js').read_text(encoding='utf-8')
        localization = (ROOT / 'atomori-status-localization.js').read_text(encoding='utf-8')
        result = PATCH.render(html, display, localization)
        self.assertTrue(result.startswith(before))
        self.assertIn(PATCH.END + '\n' + between, result)
        self.assertTrue(result.endswith(after))
        self.assertIn('robotLocalizationConfidence === "none" ? "#9aa8b6"', result)
        self.assertNotIn('OLD_STATUS', result)
        self.assertNotIn('OLD_POSE', result)
        self.assertEqual(PATCH.render(result, display, localization), result)
        self.assertNotIn('method: "POST"', display + localization)

    def test_changed_structure_is_rejected(self):
        with self.assertRaises(ValueError):
            PATCH.render('<html>changed page</html>', '', '')


if __name__ == '__main__':
    unittest.main()
