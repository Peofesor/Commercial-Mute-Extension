# Third-party notices

Commercial Mute bundles the following third-party software and models, unmodified unless noted.
All are licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).

| Component | Version | Files | Source |
|---|---|---|---|
| TensorFlow.js | 4.22.0 | `ext/vendor/tf.min.js` | https://github.com/tensorflow/tfjs |
| YAMNet (TF.js graph model) | 1 | `ext/model/` | https://www.kaggle.com/models/google/yamnet (class map from https://github.com/tensorflow/models) |
| Tesseract.js | 5.1.1 | `ext/vendor/tesseract/tesseract.min.js`, `worker.min.js` | https://github.com/naptha/tesseract.js |
| tesseract.js-core | 5.1.1 | `ext/vendor/tesseract/tesseract-core-*.wasm.js` | https://github.com/naptha/tesseract.js-core |
| Tesseract English model (`best_int`) | 4.0.0 | `ext/vendor/tesseract/lang/eng.traineddata.gz` | https://github.com/naptha/tessdata |

**Modification:** `ext/vendor/tf.min.js` has one changed line. The bundled regenerator polyfill's
fallback `Function("r", "regeneratorRuntime = r")(t)` is replaced with
`globalThis.regeneratorRuntime=t`, because Chrome's extension Content Security Policy blocks
`Function(...)` and TF.js would otherwise stop loading partway.
