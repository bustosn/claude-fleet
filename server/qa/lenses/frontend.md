# frontend

Hunts for runtime failures in the browser.

## Checklist

- Exceptions inside DataTables callbacks (drawCallback, initComplete, render, ajax.dataSrc): they leave the processing overlay ("Loading!") up forever. Calls that assume buttons, rows, columns or elements exist on every view that runs the code (`api().button(0)` on a view with no buttons).
- Event handlers bound on every open of a modal or every draw without `.off()` first: each click then fires one POST per earlier open.
- Two pieces of code that both build or fill the same modal or element: both run, and the later one wins or they fight.
- Globals across Laravel Mix / webpack module scopes: a function defined in one bundle and called from another or from inline Blade script.
- Ajax with no error handler or timeout: what the user sees on a 500.
- Escaping of server HTML and data in `.html()`, template strings and render callbacks.
- Behaviour with zero rows, one row, and a filtered-to-empty table.
- Shared JS files loaded on pages that do not have the elements they expect.
