---
description: Generate or update docs/CODEBASE_MAP.md with project-mapper
---

Call the `project-mapper_map_codebase` tool with `root` set to !`pwd` and `attempt` set to 1.
Arguments given to this command: "$ARGUMENTS". Set `force` to true only if they contain `--force`.

Do not read, analyze or write any project file yourself: the tool does all of that.

If the tool answers RUNNING, call it again with the same `root` and `force`, increasing `attempt` by 1. Repeat until it answers DONE, UP TO DATE or FAILED. Do not stop or give up while it answers RUNNING.

Then report to the user what the tool answered, including any warnings, in at most 5 lines.
