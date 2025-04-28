# Cline CLI

A command line interface for interacting with Cline outside of VSCode.

## Installation

```bash
# Install globally
npm install -g ./src/cli

# Or run directly
node ./src/cli/client.js
```

## Usage

### Interactive Mode

Start an interactive chat session with Cline:

```bash
cline-cli chat
```

Or simply:

```bash
cline-cli
```

### Start a New Task

Start a new task with a specific prompt:

```bash
cline-cli start "Create a React component that displays a list of users"
```

### Send a Message

Send a message to the current task:

```bash
cline-cli send "Can you add pagination to the component?"
```

### Options

- `-s, --server <server>`: Server hostname (default: localhost)
- `-p, --port <port>`: Server port (default: 3789)

Example:

```bash
cline-cli --server 192.168.1.100 --port 3789 chat
```

## Interactive Commands

In interactive mode:

- Type your message and press Enter to send
- Type `y` or `n` when prompted for confirmation
- Type `exit` to quit the session

## Requirements

- Node.js 14 or higher
- The Cline VSCode extension must be running

## Debugging

To enable debug mode and see detailed message logs:

```bash
CLINE_DEBUG=true cline-cli chat
```

This will show all messages received from the server, which can be helpful for troubleshooting.
