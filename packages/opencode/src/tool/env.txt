Inspect the environment — OS info, environment variables, paths, and system configuration. Use this when you need to understand the system context the agent is running in.

Great for:
- Checking what OS / platform is in use (`process.platform`, `os.release()`)
- Inspecting environment variables (`PATH`, `HOME`, `SHELL`, etc.)
- Checking available disk space or memory
- Verifying tool/command availability
- Debugging why a command isn't working by checking env state

Use this BEFORE the shell tool when debugging environment issues.
