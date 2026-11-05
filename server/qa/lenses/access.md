# access

Hunts for data or actions reaching the wrong user.

## Checklist

- Every query path for each permission level (admin, manager, regular user, client-scoped user): is the user or client scope applied on every view, tab and branch, not just one? A controller action that serves several views from one parameter (`view`, `tab`, `type`) often scopes only one branch: read every branch.
- Counts, menus and dropdown option lists scoped the same way as the table they describe.
- Can a user act on a row id they cannot see? Look for a route-level or query-level check, not only hidden buttons. IDs in URLs and request bodies.
- New routes: which middleware and Gate checks apply, compared with the routes next to them.
- CSRF on new POST routes and Ajax calls.
- Rows from other clients reachable through a join added by the diff (a new table joined without the client filter the old query had).
