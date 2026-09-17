#!/usr/bin/env python3
"""Check translation coverage and selected WCAG contrast pairs; no dependencies."""
import hashlib
import json
import math
from pathlib import Path
import re
import sys
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
LOCALES = ("ja-JP", "ko-KR", "en-US")
STRING = r'"(?:\\.|[^"\\])*"'


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def messages(source, variable):
    # ponytail: scans ordinary literal assignments/fail calls, not a C++ AST.
    # Replace with compiler extraction if macros/raw strings construct messages.
    source = re.sub(STRING + r'|//[^\n]*|/\*[\s\S]*?\*/',
                    lambda m: m[0] if m[0].startswith('"') else '', source)
    expressions = re.findall(r'\b(?:' + variable + r')\s*=(?!=)\s*('
                             + r'(?:' + STRING + r'|[^";])*);', source)
    result = {json.loads(s) for e in expressions for s in re.findall(STRING, e)}
    result.update(json.loads(s) for s in re.findall(r'\bfail\s*\(\s*(' + STRING + ')', source))
    return result


def luminance(color):
    if not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
        raise ValueError(f"expected opaque #RRGGBB color: {color!r}")
    channels = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return sum(c * weight for c, weight in zip(linear, (0.2126, 0.7152, 0.0722)))


def contrast(a, b):
    light, dark = sorted((luminance(a), luminance(b)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def self_check():
    assert math.isclose(contrast('#FFFFFF', '#000000'), 21)
    assert contrast('#526579', '#526579') == 1
    assert messages('m_message=ok?"yes":"no"; error="failure"; fail("bad"); '
                    '// m_message="comment";\n auto path="ignore";',
                    r'm_message|error') == {'yes', 'no', 'failure', 'bad'}
    try:
        json.loads('{"same":1,"same":2}', object_pairs_hook=unique_object)
    except ValueError:
        pass
    else:
        raise AssertionError('duplicate key was accepted')


def main():
    self_check()
    failures, inputs = [], {}

    def read(relative):
        value = (ROOT / relative).read_bytes()
        inputs[relative] = hashlib.sha256(value).hexdigest()
        return value.decode('utf-8')

    result = {'checked_at_utc': datetime.now(timezone.utc).isoformat(),
              'scope': 'catalog coverage and selected semantic color pairs only',
              'apca': 'pending; not measured',
              'human_ime_accessibility': 'pending', 'failures': failures}
    try:
        catalog = json.loads(read('qml/strings.json'), object_pairs_hook=unique_object)
        theme = json.loads(read('qml/theme.json'), object_pairs_hook=unique_object)
        if set(catalog) != set(LOCALES):
            failures.append('locale set must be exactly ja-JP, ko-KR, en-US')
        keys = set(catalog.get('ja-JP', {}))
        if not keys:
            failures.append('ja-JP catalog is empty')
        for locale in LOCALES:
            translations = catalog.get(locale, {})
            missing, extra = keys - translations.keys(), translations.keys() - keys
            if missing or extra:
                failures.append(f'{locale} key mismatch: missing={sorted(missing)}, extra={sorted(extra)}')
            for key, text in translations.items():
                if not isinstance(text, str) or not text.strip():
                    failures.append(f'{locale}: empty/non-string translation for {key}')

        core = messages(read('src/document.cpp'), r'error_?|m_error_?')
        canvas = messages(read('src/canvas.cpp') + '\n' + read('src/canvas.h'), 'm_message')
        if not core or not canvas:
            failures.append('source message extraction returned no keys')
        qml = '\n'.join(read(str(path.relative_to(ROOT))) for path in sorted((ROOT / 'qml').glob('*.qml')))
        qml_keys = {json.loads(s) for s in re.findall(r'\bt\s*\(\s*(' + STRING + r')\s*\)', qml)}
        # Dynamic tool/layer modelData and tool+"Hint" use this fixed spike vocabulary.
        qml_keys.update(('select', 'line', 'arc', 'text', 'pan', 'layer0', 'layer1', 'layer2'))
        qml_keys.update(tool + 'Hint' for tool in ('select', 'line', 'arc', 'text', 'pan'))
        for locale in LOCALES:
            missing = (core | canvas | qml_keys) - catalog.get(locale, {}).keys()
            if missing:
                failures.append(f'{locale} missing source messages: {sorted(missing)}')
        result['catalog'] = {'locales': list(LOCALES), 'keys_per_locale': len(keys),
                             'core_error_keys': sorted(core), 'canvas_message_keys': sorted(canvas),
                             'qml_required_keys': sorted(qml_keys), 'duplicate_keys': 'rejected'}

        colors = theme['colors']
        if colors['brandSurface'].upper() != '#C9E2FF':
            failures.append('Fresco Sky seed must be #C9E2FF')
        pairs = [('ink', bg, 4.5) for bg in ('surface', 'canvas', 'brandSurface')]
        pairs += [('muted', bg, 4.5) for bg in ('surface', 'canvas')]
        pairs += [('onPrimary', 'primary', 4.5), ('focus', 'surface', 3),
                  ('focus', 'brandSurface', 3), ('danger', 'surface', 4.5)]
        ratios = []
        for foreground, background, minimum in pairs:
            ratio = contrast(colors[foreground], colors[background])
            passed = ratio >= minimum  # Never round a threshold into a pass.
            ratios.append({'foreground': foreground, 'background': background,
                           'ratio': ratio, 'minimum': minimum, 'passed': passed})
            if not passed:
                failures.append(f'{foreground}/{background}: {ratio:.6f} < {minimum}')
        result['contrast'] = ratios
        result['disabled'] = {'status': 'exempt only for inactive controls',
                              'color': colors['disabled'],
                              'note': 'Do not use this exemption for active text or actions.'}
        result['wcag_sources'] = ['https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
                                  'https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html']
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        failures.append(str(error))
    result['input_sha256'] = inputs
    result['passed'] = not failures
    evidence = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if len(sys.argv) > 1:
        output = Path(sys.argv[1])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(evidence, encoding='utf-8')
    print(evidence, end='')
    return bool(failures)


if __name__ == '__main__':
    raise SystemExit(main())
