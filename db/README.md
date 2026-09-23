## db/ 文件与线上版本对应

**这是当前线上库的真实状态。** 按你实际执行 SQL 的顺序推出：
后执行的 `CREATE OR REPLACE` 覆盖先执行的，所以每个函数的生效版本 =
**最后一次定义它的那个文件**。

⚠️ `list-joinable-rooms.sql` 与 `room-snapshot-updatedat.sql` 你尚未执行。
执行后本表即完全对齐线上。

### 生效版本表

| 函数 | 生效文件 |
|---|---|
| `room_snapshot` | `room-snapshot-updatedat.sql`（待执行）|
| `move_pot` | `fix-settle-trigger.sql` |
| `offline_settle` | `fix-total-games.sql`（待执行）|
| `rotate_blinds` | `_rotate_blinds_patch.sql` |
| `set_blinds` | `_set_blinds_only.sql` |
| `set_auto_blind` | `fix-auto-blind-shared.sql` |
| `reset_blinds` | `blind-autopost.sql` |
| `reorder_seats` | `blind-rotation.sql` |
| `account_ledger_rows` | `fix-seed-accounting-v2.sql` |
| `account_seed_transfer` | `fix-seed-accounting-v2.sql` |
| `clear_account_ledger_row` | `fix-seed-accounting-v2.sql` |
| `register_account` | `_accounts_regex_fix.sql` |
| `account_available` | `_accounts_regex_fix.sql` |
| `login_account` / `logout_account` / `my_account` / `update_my_account` | `accounts.sql` |
| `is_room_member` / `touch_updated_at` / `transfer_seeds` / `clear_seed_ledger_entry` / `cleanup_stale_rooms` / `leave_online_room` | `schema.sql` |
| `list_joinable_rooms` | `list-joinable-rooms.sql`（待执行）|

### 危险：不要重跑这些文件

`offline-functions.sql` 和 `schema.sql` 定义的是**旧版** `move_pot` /
`offline_settle` / `room_snapshot` / `is_room_member`。

重跑任一文件会让线上函数**退化**，前端会报：

```
p_guest 参数不存在         ← room_snapshot 退化
round_status 字段消失      ← room_snapshot 退化
收款人归零检测失效         ← move_pot 退化
结算按旧口径重复记账       ← offline_settle 退化
```

### 已知的坑（verifed）

- `fix-seed-accounting.sql`（v1）**执行失败**：`seed_ledger.user_id` 被视图
  `user_seed_stats` 引用，无法改类型。已由 v2 绕开。**不要再执行。**
- `pot-log-sync.sql` 第 150 行 `END IF` 缺分号，整文件报错。
  库里实际生效的是 `_rotate_blinds_patch.sql`，行为一致所以没出事。
- `db/wipe-all-data.sql` 会连 `accounts` 一起清空，金瓜子归零。
