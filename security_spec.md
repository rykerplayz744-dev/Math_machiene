# Security Specification: Plus10 Sprint

## 1. Data Invariants
1. **Closed Roster Identity**: No unapproved usernames can ever be created or referenced in `/accountStatuses/{accountId}` or `/leaderboardScores/{scoreId}`. Only `'Carter'`, `'Ryker'`, `'Michael'`, and `'Admin'` are valid roster usernames.
2. **Strict Schema Enforcement**: Neither `/accountStatuses` nor `/leaderboardScores` accepts shadow/extra fields (`hasAll` + `hasOnly` enforced on all creates, `affectedKeys().hasOnly(...)` enforced on all updates).
3. **Score Math & Mode Bounds**: Every `leaderboardScores` entry must have `timeLimitSeconds in [30, 60, 120]`, bounded integer counters (`correctCount >= 0 && correctCount <= 300`, `wrongCount >= 0 && wrongCount <= 300`, `timeoutCount >= 0 && timeoutCount <= 300`), `accuracy >= 0 && accuracy <= 100`, `bestStreak >= 0 && bestStreak <= 300`, and `score == (correctCount * 10) - ((wrongCount + timeoutCount) * 5)`.
4. **Immutable Score Facts**: Once a score document is created in `/leaderboardScores/{scoreId}`, its core gameplay facts (`username`, `score`, `timeLimitSeconds`, `correctCount`, `wrongCount`, `timeoutCount`, `accuracy`, `bestStreak`, `playedAtIso`) are strictly immutable. Only moderation flags (`flagged`, `verified`) may be updated during Admin fair-play monitoring.
5. **Path Variable Hardening**: Document IDs (`accountId`, `scoreId`) must pass `isValidId()` (`size() <= 128` and `matches('^[a-zA-Z0-9_\\-]+$')`). For `/accountStatuses/{accountId}`, `accountId` must strictly equal `incoming().username`.

## 2. The "Dirty Dozen" Payloads
1. **Unregistered Username Creation (`leaderboardScores`)**: `{ "username": "HackerBob", "score": 100, ... }` -> Rejected by `username in ['Carter', 'Ryker', 'Michael', 'Admin']`.
2. **Shadow Field Injection (`leaderboardScores`)**: `{ "username": "Carter", "score": 50, ..., "isSuperAdmin": true }` -> Rejected by `data.keys().hasOnly(...)`.
3. **Forged Score Arithmetic (`leaderboardScores`)**: `{ "username": "Ryker", "score": 9999, "correctCount": 5, "wrongCount": 0, "timeoutCount": 0, ... }` -> Rejected by `data.score == (data.correctCount * 10) - ((data.wrongCount + data.timeoutCount) * 5)`.
4. **Invalid Time Limit Mode (`leaderboardScores`)**: `{ "username": "Michael", "timeLimitSeconds": 999, ... }` -> Rejected by `data.timeLimitSeconds in [30, 60, 120]`.
5. **Post-Game Score Tampering (`leaderboardScores` update)**: Attempting to update `score` from `50` to `500` on an existing document -> Rejected because `allow update` only permits `affectedKeys().hasOnly(['flagged', 'verified'])`.
6. **Oversized String Denial-of-Wallet (`playedAtIso`)**: `{ "playedAtIso": "<10KB string>" }` -> Rejected by `data.playedAtIso.size() <= 40`.
7. **Unauthorized Account Creation (`accountStatuses`)**: Creating `/accountStatuses/RandomUser` -> Rejected because `accountId in ['Carter', 'Ryker', 'Michael', 'Admin']` and `incoming().username == accountId`.
8. **Role Escalation (`accountStatuses`)**: Setting `role: "admin"` for `Carter` -> Rejected by `(data.username == 'Admin' ? data.role == 'admin' : data.role == 'player')`.
9. **Oversized Admin Notes (`accountStatuses`)**: `notes` exceeding 160 chars -> Rejected by `data.notes.size() <= 160`.
10. **Path ID Poisoning**: Creating `/leaderboardScores/bad$id!with/slashes` -> Rejected by `isValidId(scoreId)`.
11. **Value Poisoning on Update (`leaderboardScores`)**: Updating `flagged` to a string `"yes"` instead of boolean -> Rejected by `isValidLeaderboardScore(incoming())` wrapping the update block.
12. **Unbounded Negative/Impossible Counters**: `correctCount: -5` or `accuracy: 150` -> Rejected by integer boundary checks.
