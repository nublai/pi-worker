# Failed attempt (not counted): wrong runner

Started with the generic `harness/run.sh p4-install` instead of `harness/journeys/p4-install/run.sh`. The generic
runner builds on the VM and runs the default, Go and kernel suites before the journey. It stopped at setup: the kernel
suite failed one case, `kernel: a linked worktree child cannot move another branch, a symbolic or packed ref, a reflog,
HEAD or another worktree's admin dir` (`WROTE packed-refs`), in both attempts. That test and the P2-5 Git sandbox code
it covers are on main and not changed by PR #31. The p4-install journey itself did not run.
