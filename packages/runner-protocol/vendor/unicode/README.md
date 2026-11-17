# Vendored Unicode data

Two files, both Unicode 18.0.0 and both under the Unicode License v3 (the full text is in `LICENSE` in this folder and in the repository's
`THIRD-PARTY-NOTICES`). The copyright and permission notice travels with every copy of the data.

- `confusables.txt` is the UTS #39 (Unicode Security Mechanisms) confusables data (file dated 2026-08-06), fetched once from
  `https://www.unicode.org/Public/security/latest/confusables.txt` (763128 bytes) and checked in unchanged.
- `DefaultIgnorable.txt` is the header and the `Default_Ignorable_Code_Point` section of `DerivedCoreProperties.txt` (file dated 2026-08-07, 1159889
  bytes, SHA-256 `09c928886a178fcafd93c29e4bd59073a058e5a100b716d425cb563ab50f68c9`), fetched from
  `https://www.unicode.org/Public/18.0.0/ucd/DerivedCoreProperties.txt`. The whole file holds sixty other properties and is not needed, so only this
  section is kept (3701 bytes), with its header lines, unchanged.

Nothing downloads either file at build or test time. The generator (`scripts/generate-confusables.mjs`) refuses a file whose SHA-256 differs from the one
pinned in the script, and a test regenerates the table in memory and requires it to match byte for byte.

To move to a newer Unicode version: replace `confusables.txt`, then cut a new extract with
`node scripts/generate-confusables.mjs --extract <path to the new DerivedCoreProperties.txt>` (it checks the download against the pinned hash first, so
update `DCP_FULL_SHA256` and `UNICODE_VERSION`), update the pinned hashes and version in the generator, run `node scripts/generate-confusables.mjs`, and
commit all of it. To check the extract against a fresh download, run the test with `FX_DERIVED_CORE_PROPERTIES=<path>` set.
