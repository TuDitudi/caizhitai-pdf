# Office conversions

Browser-only modules: `presentation.ts` uses web-ppt for legacy/modern slides and PptxGenJS for PDF page-image decks; `spreadsheet.ts` reads values/formatted strings with SheetJS CE and modern styles/images with ExcelJS; `pdf-spreadsheet.ts` groups PDF text/OCR boxes into reviewable tables or embeds page images into XLSX. All libraries, OCR assets and fonts are hosted on the same site.

PDF fonts: run `scripts/prepare-office-font.py INPUT.ttf` with fonttools. Use the public Noto Sans SC variable font from google/fonts/ofl/notosanssc. The script makes a static regular face and pads glyph records to 4 bytes. This alignment is required for fontkit 1.1.1 subset correctness: unaligned glyph records can cause invisible characters despite correct text extraction. Keep OFL.txt and licenses.html with the bundle.

Formula cells lacking cached results can arrive from SheetJS with type `z`, value 0. They must be explicitly marked as missing rather than exported as zero. Valid cached numeric zero remains zero.

ExcelJS 4.4 emits an invalid `editAs` attribute on `oneCellAnchor`. Image-mode XLSX export removes that attribute from its generated drawing XML so independent readers retain the images.

Validation covered PPTX/PPT to PDF, PDF page order and PPTX schema, reopening the generated deck, multi-sheet XLSX/XLS, Chinese glyph rendering (not just text extraction), merged cells/images, image-only workbooks, pagination, hidden rows/sheets, cached and missing formula results, number formats and leading-zero IDs, editable table corrections, literal formula-looking strings, scanned-page OCR, image XLSX compatibility, invalid page ranges, cancel/retry and mobile overflow. Browser tests inspect actual downloaded files and block third-party document-dependent requests. No private user test documents are included in the release.

Legacy PPT with invisible text: uniform rendered canvases containing text are blocked. The user can explicitly opt into dark text on a white slide background; no automatic recoloring is applied. Regression includes the Apache POI 54880_chinese.ppt fixture and verifies actual rendered ink after conversion.
