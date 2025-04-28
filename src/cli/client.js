#!/usr/bin/env node

const WebSocket = require("ws")
const readline = require("readline")
const chalk = require("chalk")
const axios = require("axios")
const { program } = require("commander")

// Default server configuration
const DEFAULT_SERVER = "localhost"
const DEFAULT_PORT = 3789

// Debug mode flag
const DEBUG_MODE = process.env.CLINE_DEBUG === "true"

// Create a readline interface for user input
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
})

// Message buffer to store assistant responses
let messageBuffer = []
let waitingForResponse = false
let waitingForYesNo = false

/**
 * Connect to the Cline server via WebSocket
 */
function connectToServer(host, port) {
	const ws = new WebSocket(`ws://${host}:${port}`)

	// Flag to track if we're currently in the process of shutting down
	let isShuttingDown = false

	ws.on("open", () => {
		console.log(chalk.green(`Connected to Cline server at ${host}:${port}`))
		console.log(chalk.blue('Type your task or message and press Enter. Type "exit" to quit.'))
		console.log(chalk.blue("-----------------------------------------------------------"))

		// Start the REPL
		promptUser(ws)
	})

	ws.on("message", (data) => {
		try {
			// Skip processing if we're shutting down
			if (isShuttingDown) return

			const message = JSON.parse(data.toString())
			handleServerMessage(message, ws)
		} catch (error) {
			if (!isShuttingDown) {
				console.error(chalk.red(`Error parsing message: ${error.message}`))
			}
		}
	})

	ws.on("close", () => {
		if (!isShuttingDown) {
			isShuttingDown = true
			console.log(chalk.yellow("Disconnected from Cline server"))

			// Close readline interface gracefully
			if (rl) {
				rl.close()
			}

			// Exit after a short delay to allow cleanup
			setTimeout(() => process.exit(0), 100)
		}
	})

	ws.on("error", (error) => {
		if (!isShuttingDown) {
			isShuttingDown = true
			console.error(chalk.red(`WebSocket error: ${error.message}`))
			console.log(chalk.yellow("Make sure the Cline extension is running in VSCode"))

			// Close readline interface gracefully
			if (rl) {
				rl.close()
			}

			// Exit after a short delay to allow cleanup
			setTimeout(() => process.exit(1), 100)
		}
	})

	// Handle process termination signals
	process.on("SIGINT", () => {
		if (!isShuttingDown) {
			isShuttingDown = true
			console.log(chalk.yellow("\nGracefully shutting down..."))

			// Close WebSocket connection
			ws.close()

			// Close readline interface
			if (rl) {
				rl.close()
			}

			// Exit after a short delay to allow cleanup
			setTimeout(() => process.exit(0), 100)
		}
	})

	return ws
}

/**
 * Handle messages from the server
 */
function handleServerMessage(message, ws) {
	// Log all messages in debug mode
	if (DEBUG_MODE) {
		console.log("Received message:", JSON.stringify(message))
	}

	switch (message.type) {
		case "status":
			console.log(chalk.blue(`Server: ${message.status}`))
			break

		case "error":
			console.error(chalk.red(`Error: ${message.error}`))
			waitingForResponse = false
			promptUser(ws)
			break

		case "action":
			if (message.action === "showYesNoButtons") {
				waitingForYesNo = true
				console.log(chalk.yellow('\nCline is asking for confirmation. Type "y" for Yes or "n" for No:'))
				promptUser(ws)
			} else {
				// Log other actions in debug mode
				if (DEBUG_MODE) {
					console.log(chalk.blue(`Action: ${message.action}`))
				}
			}
			break

		case "invoke":
			if (message.invoke === "sendMessage" && message.text) {
				// This is a message from the user, we can ignore it
			} else if (message.invoke === "primaryButtonClick") {
				console.log(chalk.blue("Primary button clicked (Yes)"))
			} else if (message.invoke === "secondaryButtonClick") {
				console.log(chalk.blue("Secondary button clicked (No)"))
			}
			break

		case "state":
			// Extract and display relevant information from state updates
			if (message.state && message.state.clineMessages) {
				const lastMessage = message.state.clineMessages.filter((msg) => msg.type === "say" && msg.text).pop()

				if (lastMessage && lastMessage.text) {
					if (messageBuffer.length === 0) {
						console.log(chalk.green("\nCline: "))
					}

					// Only display if we haven't already shown this message
					if (!messageBuffer.includes(lastMessage.text)) {
						process.stdout.write(lastMessage.text)
						messageBuffer.push(lastMessage.text)

						// If this is a complete message, end the response
						if (!lastMessage.partial) {
							console.log("\n")
							waitingForResponse = false
							messageBuffer = []
							promptUser(ws)
						}
					}
				}

				// Check for Yes/No options
				const hasYesNoOptions = message.state.clineMessages.some(
					(msg) => msg.type === "ask" && (msg.ask === "plan_mode_respond" || msg.ask === "followup"),
				)

				if (hasYesNoOptions && !waitingForYesNo) {
					waitingForYesNo = true
					console.log(chalk.yellow('\nCline is asking for confirmation. Type "y" for Yes or "n" for No:'))
					promptUser(ws)
				}
			}
			break

		case "response":
			if (message.response) {
				// Print the assistant's response
				if (messageBuffer.length === 0) {
					console.log(chalk.green("\nCline: "))
				}

				process.stdout.write(message.response)
				messageBuffer.push(message.response)
			}
			break

		case "responseEnd":
			console.log("\n")
			waitingForResponse = false
			messageBuffer = []
			promptUser(ws)
			break

		default:
			// Log unknown message types in debug mode
			if (DEBUG_MODE) {
				console.log(`Received unknown message type: ${message.type}`, message)
			}
			break
	}
}

/**
 * Prompt the user for input
 */
function promptUser(ws) {
	// Don't prompt if we're waiting for a response or if readline is closed
	if (waitingForResponse || !rl || rl.closed) {
		return
	}

	try {
		if (waitingForYesNo) {
			rl.question(chalk.yellow("(y/n)> "), (answer) => {
				try {
					waitingForYesNo = false

					if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
						ws.send(JSON.stringify({ type: "pressPrimaryButton" }))
						console.log(chalk.blue("Sending: Yes"))
					} else {
						ws.send(JSON.stringify({ type: "pressSecondaryButton" }))
						console.log(chalk.blue("Sending: No"))
					}

					waitingForResponse = true
				} catch (error) {
					if (DEBUG_MODE) {
						console.error(chalk.red(`Error processing Y/N input: ${error.message}`))
					}
				}
			})
		} else {
			rl.question(chalk.cyan("You> "), (input) => {
				try {
					if (input.toLowerCase() === "exit") {
						console.log(chalk.yellow("Goodbye!"))

						// Close WebSocket connection
						if (ws && ws.readyState === WebSocket.OPEN) {
							ws.close()
						}

						// Close readline interface
						rl.close()

						// Exit after a short delay to allow cleanup
						setTimeout(() => process.exit(0), 100)
						return
					}

					if (input.trim() === "") {
						promptUser(ws)
						return
					}

					// Check if this is a new task or a message to an existing task
					if (!waitingForResponse && messageBuffer.length === 0) {
						console.log(chalk.blue("Starting new task..."))
						ws.send(JSON.stringify({ type: "startTask", task: input }))
					} else {
						ws.send(JSON.stringify({ type: "sendMessage", message: input }))
					}

					waitingForResponse = true
				} catch (error) {
					if (DEBUG_MODE) {
						console.error(chalk.red(`Error processing input: ${error.message}`))
					}

					// Try to recover by prompting again
					waitingForResponse = false
					promptUser(ws)
				}
			})
		}
	} catch (error) {
		if (DEBUG_MODE) {
			console.error(chalk.red(`Error in promptUser: ${error.message}`))
		}

		// If readline has an error, wait a bit and try again
		setTimeout(() => {
			waitingForResponse = false
			promptUser(ws)
		}, 1000)
	}
}

/**
 * Start a new task via HTTP API
 */
async function startTask(host, port, task) {
	try {
		const response = await axios.post(`http://${host}:${port}/api/start-task`, { task })

		if (response.data.success) {
			console.log(chalk.green("Task started successfully"))
		} else {
			console.error(chalk.red(`Failed to start task: ${response.data.error}`))
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error.message}`))
		console.log(chalk.yellow("Make sure the Cline extension is running in VSCode"))
	}
}

/**
 * Send a message via HTTP API
 */
async function sendMessage(host, port, message) {
	try {
		const response = await axios.post(`http://${host}:${port}/api/send-message`, { message })

		if (response.data.success) {
			console.log(chalk.green("Message sent successfully"))
		} else {
			console.error(chalk.red(`Failed to send message: ${response.data.error}`))
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error.message}`))
		console.log(chalk.yellow("Make sure the Cline extension is running in VSCode"))
	}
}

/**
 * Start an interactive REPL session
 */
function startInteractiveSession(host, port) {
	console.log(chalk.blue("Starting interactive Cline session..."))
	connectToServer(host, port)
}

// Set up command line interface
program.name("cline-cli").description("Command line interface for Cline").version("1.0.0")

program
	.option("-s, --server <server>", "Server hostname", DEFAULT_SERVER)
	.option("-p, --port <port>", "Server port", DEFAULT_PORT)

program
	.command("start <task>")
	.description("Start a new task")
	.action((task, options) => {
		const { server, port } = program.opts()
		startTask(server, port, task)
	})

program
	.command("send <message>")
	.description("Send a message to the current task")
	.action((message, options) => {
		const { server, port } = program.opts()
		sendMessage(server, port, message)
	})

program
	.command("chat")
	.description("Start an interactive chat session")
	.action((options) => {
		const { server, port } = program.opts()
		startInteractiveSession(server, port)
	})

// Default command is chat if no command is specified
if (process.argv.length <= 2) {
	startInteractiveSession(DEFAULT_SERVER, DEFAULT_PORT)
} else {
	program.parse(process.argv)
}
