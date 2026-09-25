#!/usr/bin/env python3
"""Unit check for the backend's dice-number scrubber. Run: python3 tests/test_scrub_dice.py"""
import ast
from pathlib import Path

# Pull scrub_dice and its patterns out of app.py without importing the backend (no models needed).
src = (Path(__file__).parent.parent / "backend" / "app.py").read_text()
tree = ast.parse(src)
keep = [n for n in tree.body if (isinstance(n, ast.Assign) and any(getattr(t, "id", "") == "_DICE" for t in n.targets))
        or (isinstance(n, ast.FunctionDef) and n.name == "scrub_dice")]
ns = {"re": __import__("re")}
exec(compile(ast.Module(body=keep, type_ignores=[]), "app.py", "exec"), ns)
scrub = ns["scrub_dice"]

CASES = [
    # Real Mistral output from the knight test (2026-09-25)
    ("dealing a total of 116 damage with his weapons Talon", "dealing damage with his weapons Talon"),
    ("strikes back with Talon, deals 22 slashing damage and 16 lightning damage (total of 38)",
     "strikes back with Talon, deals slashing damage and lightning damage"),
    ("Aladar strikes back with Talon, hitting for 23 and dealing 22 slashing damage", "Aladar strikes back with Talon, hitting and dealing slashing damage"),
    ("I attack, that is a 23 to hit.", "I attack."),
    ("The ogre has 30 hit points left.", "The ogre has hit points left."),
    ("She rolled a 17 on perception.", "She rolled on perception."),
    # Must survive untouched
    ("They found 300 gold and 2 potions.", "They found 300 gold and 2 potions."),
    ("Hollis paid them 50 gold pieces.", "Hollis paid them 50 gold pieces."),
    ("The letter must reach Greywater by the new moon.", "The letter must reach Greywater by the new moon."),
]

failed = 0
for given, want in CASES:
    got = scrub(given)
    if got != want:
        failed += 1
        print(f"FAIL\n  in:   {given}\n  want: {want}\n  got:  {got}")
print(f"{len(CASES) - failed}/{len(CASES)} passed")
raise SystemExit(1 if failed else 0)
