# input

Hunts for values that break parsing, matching or rendering.

## Checklist

- Every column or request field the diff parses, normalises, compares or renders: run it in your head against this hostile set and say what the code does with each: null; empty string; whitespace only; leading/trailing whitespace; a value wrapped in quotes; quotes in the middle (`'A','B'`, `O'Brien`); comma lists; `IN ('A','B')`; numbers as strings; very long text; unicode; HTML and `<script>`; JSON objects and arrays nested inside JSON values; JSON `null`.
- String functions that look at only the ends (trim, strip one pair of quotes, substr of the first and last char) applied to values that can hold several quoted items: show the exact input and the stored output.
- `(string)` casts, string interpolation or implode on values that can be arrays or objects (decoded JSON): PHP throws "Array to string conversion"; say where it is called and what fails (a whole page, one row, a job).
- Normalisation that runs on every save, so editing an unrelated field (notes, priority) rewrites a value the user did not touch.
- Escaping on every HTML output: server-built HTML strings, DataTables render callbacks, `.html()` with data, Blade `{!! !!}`.
- Values sampled or written by another system (an ETL job wrapping values in quotes, a processor's format): does the parsing match what is actually stored?
