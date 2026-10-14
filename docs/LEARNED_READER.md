# Learned question reader (R25)

A small model reads a question and predicts the *shape* of the plan (what to count or add up, which kind of paper, which period, grouping, ranking). It never writes a value. Donovan's own code copies names, cities, dates and amounts from the question and the company's records, checks the plan, and the existing query engine runs it and cites the records.

It is **on by default** at the strictest-but-one setting (target 0.995) because the R25 measurements showed no added wrong answer and 100 percent of the newly answered questions right; `DONOVAN_LEARNED_READER=0` is the kill switch. It runs only for a question the rules engine has already released, and never replaces a rules answer. Any doubt releases the question to the model, exactly as before.

## How a question is handled

1. Anonymize (`reader-ml/anon.js`): the company's names, cities, stored values, kinds of paper, dates, amounts and numbers become role tokens (`<ENT> <CITY> <DT> <YEAR> <MONEY> <NUM> ...`). Same code as the trainer.
2. Predict (`model.js` for the CPU model, `onnx.js` for the GPU model): nine heads (op, entity, doc-type role, measure, time, group-by, filters, args, rest), each with a probability.
3. Gate: every head's *miss mass* (1 - probability) and their sum must be under the calibrated thresholds (`data/calibration.json`); no head may say `<OTHER>`; the nine parts must form a skeleton seen in training (`data/trsk.bin`); every literal must be a closed structural word or one of the company's own words.
4. Fill (`fill.js`): placeholders are replaced by the question's own mentions; a period becomes dates.
5. Map (`map.js`) to the translator's plan shape and validate (`translator/validate.js`): values anchored to words of the question, every word explained (the coverage rule), nothing invented, private papers never.
6. Agreement: the validated plan's period and values must equal the filler's.
7. Execute with the DQL executor and cite as usual (`translator/index.js`, `runTranslated`).

Supported plan kinds today: count, exists, sum/avg/median/min/max of the total, count-distinct, group-by (count or sum), top-n, over documents or visits, with equality filters (customer, city, technician, vendor, status, service type, brand), money bounds and a period. Everything else (lookups, customers, comparisons, shares, text search, follow-ups, multi-part) is released.

## Settings (environment)

| name | meaning |
|---|---|
| `DONOVAN_LEARNED_READER` | `0` off (kill switch), `1` on; unset follows `DEFAULT_ON` in `reader-ml/index.js` (on) |
| `DONOVAN_LEARNED_TARGET` | `0.99`, `0.995` or `0.999` (default `0.995`; `0.999` is the strictest); `open` is for measurement only |
| `DONOVAN_LEARNED_FOLD` | `fold0` / `fold1` / `all` (default `all`); the folds are for honest measurement only |
| `DONOVAN_LEARNED_BACKEND` | `cpu` or `onnx` (default: `onnx` when `data/model.onnx` exists, else `cpu`) |
| `DONOVAN_LEARNED_MODEL_DIR` | read the model files from another folder |

## The CPU model (shipped)

`data/model-cpu.bin` (27 MB) is E2's hashed n-gram embedding bag plus a 128-512-512 MLP and nine heads, quantized to int8 (embedding rows seen in at least 50 training questions, per-row scales). Built by `scripts/learned-reader/export_cpu_model.py` from `net_M.pt`; pure Node, no native package, about 15-20 ms per question. `data/classes.json.gz` holds the class names. `data/trsk.bin` is the table of 178 thousand trained skeletons; `data/lit.json.gz` the closed literals; `data/rel_table.json` the relative periods.

## Dropping in the GPU model

The training kit on the owner's desktop writes `output\model.onnx`, `labels.json`, `calibration.json` (and `calibration.md`, plus `tokenizer\` for a Hugging Face encoder). To use it:

1. Copy `model.onnx`, `labels.json`, `calibration.json` and the `tokenizer` folder into `api/_lib/dql/reader-ml/data/` (the CPU files can stay; the reader prefers `model.onnx`). Keep `trsk.bin`, `lit.json.gz`, `rel_table.json`: they are the same for either model, and so are the class lists (the kit trains on the same labels).
2. Size: a fp32 DistilRoBERTa is about 330 MB, over Vercel's 250 MB function limit. Quantize first and calibrate again on the quantized model (the kit's `dev_scores.npz` lets the calibration be re-run without the GPU):
   `python -c "from onnxruntime.quantization import quantize_dynamic, QuantType; quantize_dynamic('model.onnx','model.int8.onnx',weight_type=QuantType.QInt8)"` gives about 96 MB and about 3x the speed on CPU. A smaller encoder (MiniLM) gives about 25 MB. If it still does not fit, serve it from its own inference route and have this code call it; only the anonymized text leaves the function, never a company word.
3. Runtime: `onnx.js` imports `onnxruntime-node` or, failing that, `onnxruntime-web` (WebAssembly; about 13 MB of wasm; about 165 ms per question for the fp32 model on one thread). Neither is in `package.json`. `onnxruntime-node` is about 247 MB unpacked with every platform, so it does not fit a Vercel function unless trimmed to linux-x64; the wasm package does. Add the one you choose to `dependencies` and to `functions["api/ask.js"].includeFiles` in `vercel.json` (the model files are read from disk, like `api/_lib/wording/*.json`).
4. Calibration: the kit's `calibration.json` thresholds are on `conf` = product of the head probabilities; the reader reads `calibration["0.999"].thr_all` and answers only when 1 - conf is at most 1 - thr (a total miss). A target with no threshold (null) never answers.
5. Measure before turning it on: `plansweep7r.mjs` style sweep (see the R25 report) on never-seen wordings; turn it on only if wrong + wrong-decline does not rise anywhere and newly answered precision is at least 99 percent.

Known issue found while testing the kit: the kit's `--smoke` model (from-scratch encoder) is exported with the sequence length baked in (it only runs for length 16); the DistilRoBERTa export is dynamic in length and batch and runs for any question.

## Files

`api/_lib/dql/reader-ml/{index,model,anon,fill,map,onnx}.js`, `data/*`, `scripts/learned-reader/export_cpu_model.py`, `scripts/verify-learned-reader-r25.mjs` (`npm run verify:learned-reader-r25`), `scripts/golden/learned-reader-fixture.json`, `scripts/golden/roberta-tokenizer.json.gz`. Wired in `api/_lib/dql/translator/index.js` (`classifyTranslate`, `runTranslated`).
