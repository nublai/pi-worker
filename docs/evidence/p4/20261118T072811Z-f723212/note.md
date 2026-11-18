# Failed attempt (not counted): purge refused a running supervisor's state

The p4-install journey at `f723212`. `uninstall --purge` refused `which: state` ("it holds an entry pi-worker does not
write") because the new state-ownership check did not list `journal.lock-journal`, the lock's SQLite rollback journal
that exists while the supervisor holds the lock. Fixed in `1155ac8` (with a unit test that purges while a supervisor
holds the state); the journey passed there (`20261118T072957Z-1155ac8`).
