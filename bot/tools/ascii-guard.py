#!/usr/bin/env python3
"""Rewrite every non-ASCII character in the bot's JS sources as a \\uXXXX escape.

The handoff is explicit that these files have been corrupted before by transfer
pipes that mangle raw UTF-8, so the convention is that the source on disk is
pure ASCII and all emoji / dashes live as escapes. Doing that by hand is how
the mangling creeps back in, so run this instead:

    python3 tools/ascii-guard.py            # rewrite in place
    python3 tools/ascii-guard.py --check    # exit 1 if anything is non-ASCII

Astral-plane characters (emoji) become surrogate pairs, which is exactly what
JavaScript string escapes need.
"""
import sys
import pathlib

TARGETS = ["*.js", "stats/*.js", "web/*.js", "integration/*.js", "public/*.js"]
ROOT = pathlib.Path(__file__).resolve().parent.parent


def escape(text: str) -> str:
    out = []
    for ch in text:
        cp = ord(ch)
        if cp < 128:
            out.append(ch)
        elif cp > 0xFFFF:
            cp -= 0x10000
            out.append("\\u%04X\\u%04X" % (0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)))
        else:
            out.append("\\u%04X" % cp)
    return "".join(out)


def main() -> int:
    check = "--check" in sys.argv
    bad, changed = [], []
    for pattern in TARGETS:
        for path in sorted(ROOT.glob(pattern)):
            raw = path.read_text(encoding="utf-8")
            esc = escape(raw)
            if esc == raw:
                continue
            rel = path.relative_to(ROOT)
            if check:
                bad.append(str(rel))
            else:
                path.write_text(esc, encoding="ascii")
                changed.append(str(rel))
    if check:
        for f in bad:
            print("non-ASCII: %s" % f)
        print("%d file(s) with non-ASCII" % len(bad))
        return 1 if bad else 0
    for f in changed:
        print("escaped: %s" % f)
    print("%d file(s) rewritten" % len(changed))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
