# Customer directory — disposable product acceptance fixture

Python standard library only. Run `python3 -m unittest discover -v`; start with
`DIRECTORY_DB=/tmp/ship-directory.sqlite PORT=8080 python3 app.py`.
This is isolated test data, not a production service. The server binds localhost.

Use the existing appearance and wording unless the task explicitly changes them.
Keep API validation and SQLite persistence working. Read-only tasks must not edit
or publish files. Do not weaken tests to obtain a passing result.

Acceptance tasks, evaluated independently outside this repository:
1. Explain how adding a contact validates and stores data; cite implementation.
2. Plan a name/email search without implementing it.
3. Change the submit button from “Add contact” to “Save customer”.
4. Implement case-insensitive search by name/email with a visible empty state.
5. Revise the search to ignore surrounding whitespace; retain the same PR.
