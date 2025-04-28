import * as http from "http"
import express, { RequestHandler } from "express"
import cors from "cors"
import WebSocket from "ws"
import * as vscode from "vscode"
import { WebSocketManager } from "./websocket-manager"
import { Controller } from "../core/controller"
import { ClineAPI } from "../exports/cline"
import { createClineAPI } from "../exports/index"
import { ExtensionMessage } from "../shared/ExtensionMessage"
import { Request, Response } from "express"

// Import the WebSocket Server constructor
const WebSocketServer = require("ws").Server

/**
 * Cline Web API Server
 * Provides HTTP and WebSocket interfaces to interact with Cline outside of VSCode
 */
export class ClineServer {
	private server: http.Server
	private app: express.Express
	private wss: any // WebSocket.Server
	private wsManager: WebSocketManager
	private api: ClineAPI
	private port = 3789 // Default port for Cline Web API
	private isRunning = false

	constructor(
		private outputChannel: vscode.OutputChannel,
		private controller: Controller,
	) {
		this.app = express()
		this.server = http.createServer(this.app)
		// Use the WebSocket.Server constructor
		this.wss = new WebSocketServer({ server: this.server })
		this.wsManager = new WebSocketManager(outputChannel)
		this.api = createClineAPI(outputChannel, controller)

		this.setupMiddleware()
		this.setupRoutes()
		this.setupWebSocket()
	}

	/**
	 * Set up Express middleware
	 */
	private setupMiddleware(): void {
		this.app.use(cors())
		this.app.use(express.json())
		this.app.use(express.urlencoded({ extended: true }))
	}

	/**
	 * Set up WebSocket server
	 */
	private setupWebSocket(): void {
		this.wss.on("connection", (ws: WebSocket) => {
			this.wsManager.addConnection(ws)

			ws.on("message", (data: any) => {
				try {
					const message = JSON.parse(data.toString())
					this.handleWebSocketMessage(ws, message)
				} catch (error: any) {
					this.outputChannel.appendLine(`Error parsing WebSocket message: ${error.message}`)
					this.wsManager.sendToClient(ws, {
						type: "error",
						error: "Invalid message format",
					})
				}
			})
		})

		// Set up a message listener on the controller
		// This will allow us to capture all messages from the controller and broadcast them to clients
		const originalPostMessage = this.controller.postMessageToWebview.bind(this.controller)
		this.controller.postMessageToWebview = async (message: ExtensionMessage) => {
			// Process the message before broadcasting
			this.wsManager.processControllerMessage(message)

			// Special handling for specific message types that CLI clients need
			if (message.type === "state" && message.state?.clineMessages) {
				// Find the last message from the agent
				const lastAgentMessage = [...message.state.clineMessages].reverse().find((msg) => msg.type === "say" && msg.text)

				if (lastAgentMessage?.text) {
					// Clean up the text by removing JSON-like content
					let cleanText = lastAgentMessage.text

					// Try to detect and clean JSON-like content
					try {
						// Look for patterns like {"question":"...","options":[...]}
						const jsonPattern = /\{(?:"question"|'question'):.+?\}/g
						cleanText = cleanText.replace(jsonPattern, "")

						// Remove any remaining JSON artifacts
						cleanText = cleanText.replace(/\}\{/g, " ")
					} catch (error) {
						// If cleaning fails, use the original text
						this.outputChannel.appendLine(`Error cleaning message text: ${error.message}`)
					}

					// Send the agent's response to clients if there's content after cleaning
					if (cleanText.trim()) {
						this.wsManager.broadcast({
							type: "response",
							response: cleanText,
						})
					}

					// If this is the end of a response, send a responseEnd message
					if (!lastAgentMessage.partial) {
						this.wsManager.broadcast({
							type: "responseEnd",
						})
					}
				}

				// Check if there are any Yes/No options to show
				const hasYesNoOptions = message.state.clineMessages.some(
					(msg) => msg.type === "ask" && (msg.ask === "plan_mode_respond" || msg.ask === "followup"),
				)

				// Also check for JSON-formatted questions with options
				const hasJsonOptions = message.state.clineMessages.some((msg) => {
					if (msg.type === "say" && msg.text) {
						return msg.text.includes('"question"') && msg.text.includes('"options"')
					}
					return false
				})

				if (hasYesNoOptions || hasJsonOptions) {
					this.wsManager.broadcast({
						type: "action",
						action: "showYesNoButtons",
					})
				}
			}

			// Call the original method
			return await originalPostMessage(message)
		}
	}

	/**
	 * Handle WebSocket messages from clients
	 */
	private handleWebSocketMessage(ws: WebSocket, message: any): void {
		this.outputChannel.appendLine(`WebSocket message received: ${JSON.stringify(message)}`)

		// Handle different message types from clients
		switch (message.type) {
			case "ping":
				this.wsManager.sendToClient(ws, { type: "pong", timestamp: Date.now() })
				break
			case "startTask":
				if (message.task) {
					this.api.startNewTask(message.task, message.images).catch((error) => {
						this.outputChannel.appendLine(`Error starting task: ${error.message}`)
						this.wsManager.sendToClient(ws, {
							type: "error",
							error: `Failed to start task: ${error.message}`,
						})
					})
				}
				break
			case "sendMessage":
				if (message.message) {
					this.api.sendMessage(message.message, message.images).catch((error) => {
						this.outputChannel.appendLine(`Error sending message: ${error.message}`)
						this.wsManager.sendToClient(ws, {
							type: "error",
							error: `Failed to send message: ${error.message}`,
						})
					})
				}
				break
			case "pressPrimaryButton":
				this.api.pressPrimaryButton().catch((error) => {
					this.outputChannel.appendLine(`Error pressing primary button: ${error.message}`)
					this.wsManager.sendToClient(ws, {
						type: "error",
						error: `Failed to press primary button: ${error.message}`,
					})
				})
				break
			case "pressSecondaryButton":
				this.api.pressSecondaryButton().catch((error) => {
					this.outputChannel.appendLine(`Error pressing secondary button: ${error.message}`)
					this.wsManager.sendToClient(ws, {
						type: "error",
						error: `Failed to press secondary button: ${error.message}`,
					})
				})
				break
			default:
				this.outputChannel.appendLine(`Unknown message type: ${message.type}`)
				this.wsManager.sendToClient(ws, {
					type: "error",
					error: `Unknown message type: ${message.type}`,
				})
		}
	}

	/**
	 * Set up HTTP routes
	 */
	private setupRoutes(): void {
		// Health check endpoint
		this.app.get("/health", (_req: Request, res: Response) => {
			res.status(200).json({ status: "ok" })
		})

		// API documentation endpoint
		this.app.get("/api", (_req: Request, res: Response) => {
			res.status(200).json({
				endpoints: [
					{ path: "/health", method: "GET", description: "Check server health" },
					{ path: "/api/custom-instructions", method: "GET", description: "Get custom instructions" },
					{ path: "/api/custom-instructions", method: "POST", description: "Set custom instructions" },
					{ path: "/api/start-task", method: "POST", description: "Start a new task" },
					{ path: "/api/send-message", method: "POST", description: "Send a message to the current task" },
					{ path: "/api/press-primary-button", method: "POST", description: "Press the primary button (Yes)" },
					{ path: "/api/press-secondary-button", method: "POST", description: "Press the secondary button (No)" },
				],
			})
		})

		// Get custom instructions
		this.app.get("/api/custom-instructions", async (_req: Request, res: Response) => {
			try {
				const instructions = await this.api.getCustomInstructions()
				res.status(200).json({ success: true, instructions })
			} catch (err: any) {
				this.outputChannel.appendLine(`Error getting custom instructions: ${err.message}`)
				res.status(500).json({ success: false, error: err.message })
			}
		})

		// Set custom instructions
		this.app.post("/api/custom-instructions", ((req: Request, res: Response): void => {
			try {
				if (!req.body.instructions) {
					res.status(400).json({ success: false, error: "Missing required parameter: instructions" })
					return
				}

				this.api
					.setCustomInstructions(req.body.instructions)
					.then(() => {
						res.status(200).json({ success: true })
					})
					.catch((err: any) => {
						this.outputChannel.appendLine(`Error setting custom instructions: ${err.message}`)
						res.status(500).json({ success: false, error: err.message })
					})
			} catch (err: any) {
				this.outputChannel.appendLine(`Error setting custom instructions: ${err.message}`)
				res.status(500).json({ success: false, error: err.message })
			}
		}) as RequestHandler)

		// Start a new task
		this.app.post("/api/start-task", ((req: Request, res: Response): void => {
			try {
				if (!req.body.task) {
					res.status(400).json({ success: false, error: "Missing required parameter: task" })
					return
				}

				this.outputChannel.appendLine(`Starting new task via API: ${req.body.task.substring(0, 50)}...`)
				this.api
					.startNewTask(req.body.task, req.body.images)
					.then(() => {
						res.status(200).json({ success: true })
					})
					.catch((err: any) => {
						this.outputChannel.appendLine(`Error starting task: ${err.message}`)
						res.status(500).json({ success: false, error: err.message })
					})
			} catch (err: any) {
				this.outputChannel.appendLine(`Error starting task: ${err.message}`)
				res.status(500).json({ success: false, error: err.message })
			}
		}) as RequestHandler)

		// Send a message to the current task
		this.app.post("/api/send-message", ((req: Request, res: Response): void => {
			try {
				if (!req.body.message) {
					res.status(400).json({ success: false, error: "Missing required parameter: message" })
					return
				}

				this.outputChannel.appendLine(`Sending message via API: ${req.body.message.substring(0, 50)}...`)
				this.api
					.sendMessage(req.body.message, req.body.images)
					.then(() => {
						res.status(200).json({ success: true })
					})
					.catch((err: any) => {
						this.outputChannel.appendLine(`Error sending message: ${err.message}`)
						res.status(500).json({ success: false, error: err.message })
					})
			} catch (err: any) {
				this.outputChannel.appendLine(`Error sending message: ${err.message}`)
				res.status(500).json({ success: false, error: err.message })
			}
		}) as RequestHandler)

		// Press the primary button (Yes)
		this.app.post("/api/press-primary-button", ((_req: Request, res: Response): void => {
			try {
				this.outputChannel.appendLine("Pressing primary button via API")
				this.api
					.pressPrimaryButton()
					.then(() => {
						res.status(200).json({ success: true })
					})
					.catch((err: any) => {
						this.outputChannel.appendLine(`Error pressing primary button: ${err.message}`)
						res.status(500).json({ success: false, error: err.message })
					})
			} catch (err: any) {
				this.outputChannel.appendLine(`Error pressing primary button: ${err.message}`)
				res.status(500).json({ success: false, error: err.message })
			}
		}) as RequestHandler)

		// Press the secondary button (No)
		this.app.post("/api/press-secondary-button", ((_req: Request, res: Response): void => {
			try {
				this.outputChannel.appendLine("Pressing secondary button via API")
				this.api
					.pressSecondaryButton()
					.then(() => {
						res.status(200).json({ success: true })
					})
					.catch((err: any) => {
						this.outputChannel.appendLine(`Error pressing secondary button: ${err.message}`)
						res.status(500).json({ success: false, error: err.message })
					})
			} catch (err: any) {
				this.outputChannel.appendLine(`Error pressing secondary button: ${err.message}`)
				res.status(500).json({ success: false, error: err.message })
			}
		}) as RequestHandler)
	}

	/**
	 * Start the server
	 */
	start(): void {
		if (this.isRunning) {
			this.outputChannel.appendLine(`Cline Web API server already running on port ${this.port}`)
			return
		}

		this.server.listen(this.port, () => {
			this.isRunning = true
			this.outputChannel.appendLine(`Cline Web API server started on port ${this.port}`)

			// Log instructions for using the API
			this.outputChannel.appendLine("")
			this.outputChannel.appendLine("To use the Cline Web API:")
			this.outputChannel.appendLine(`1. Connect to WebSocket: ws://localhost:${this.port}`)
			this.outputChannel.appendLine(`2. Or use HTTP endpoints: http://localhost:${this.port}/api`)
			this.outputChannel.appendLine('3. Start a new task: POST /api/start-task with {"task": "Your task description"}')
			this.outputChannel.appendLine("")
		})

		this.server.on("error", (error: any) => {
			this.outputChannel.appendLine(`Server error: ${error.message}`)
			if (error.code === "EADDRINUSE") {
				this.outputChannel.appendLine(`Port ${this.port} is already in use. The server may already be running.`)
			}
		})
	}

	/**
	 * Stop the server
	 */
	stop(): void {
		if (!this.isRunning) {
			return
		}

		this.server.close(() => {
			this.isRunning = false
			this.outputChannel.appendLine("Cline Web API server stopped")
		})
	}
}
