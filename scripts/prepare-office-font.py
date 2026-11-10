"""Prepare the bundled PDF font. Requires fonttools (build-time only).

Input: NotoSansSC[wght].ttf from google/fonts/ofl/notosanssc (OFL-1.1).
Use a static weight and 4-byte glyph alignment: fontkit's TTF subset encoder
otherwise truncates odd-length glyph records, causing invisible characters.
No user document text is involved in preparing this public asset.
"""
import sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
font=TTFont(sys.argv[1])
if 'fvar' in font:instantiateVariableFont(font,{'wght':400},inplace=True)
font['glyf'].padding=4
font.save(Path(__file__).resolve().parents[1]/'public/office-assets/NotoSansSC-Regular.ttf')
