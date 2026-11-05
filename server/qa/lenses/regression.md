# regression

Hunts for existing behaviour the diff changes.

## Checklist

- For every shared file, function, method, global, route or query the diff touches: list its other callers (callers.md, then the source snapshot) and what each one now gets.
- Existing pages and tabs that now exclude or include different rows; their menus, dropdowns and counts that no longer match the table.
- Code moved between files: is it really unchanged? Diff the moved block against the base version (base/ in the pack). Does every old page still load the new file, and in the right order?
- Shared JS changes running on the old page: elements, buttons or globals the old page does not have.
- Constants, helpers or classes used but not defined or imported in this commit.
- Pre-existing bugs the change makes reachable on a new path.
- Behaviour that changes on save or edit for existing records (a normaliser rewriting stored values).
