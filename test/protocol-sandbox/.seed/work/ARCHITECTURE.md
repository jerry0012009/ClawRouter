# Synthetic task service architecture

The storage layer owns persistence-shaped records and exposes `all()`. The service layer owns filtering and business operations such as `listOpen()`. The formatting layer converts records to display strings and must not be imported by storage. Tests may construct the three layers independently.

Constraints:

- `TaskStore` must remain unaware of formatting.
- `TaskService.listOpen()` returns records, not strings.
- No external dependencies are allowed.
