# OCR 资源来源

- `worker.min.js` 来自 [Tesseract.js 6.0.1](https://github.com/naptha/tesseract.js/tree/v6.0.1)，许可及打包依赖声明见 `LICENSE-tesseract.js.md` 和 `worker.min.js.LICENSE.txt`。
- `core/` 中的 WebAssembly 和加载脚本来自 [Tesseract.js Core 6.1.2](https://github.com/naptha/tesseract.js-core/tree/v6.1.2)，许可见 `LICENSE-tesseract.js-core`。
- `lang/` 中的中文和英文模型来自 [Tesseract.js 数据包](https://github.com/naptha/tessdata/tree/gh-pages) `@tesseract.js-data/chi_sim@1.0.0` 和 `@tesseract.js-data/eng@1.0.0` 的 `4.0.0_best_int` 目录。本站保留相同模型内容的解压版和 gzip 压缩版。模型上游 [tessdata_best](https://github.com/tesseract-ocr/tessdata_best) 的许可见 `lang/LICENSE-tessdata_best`。
