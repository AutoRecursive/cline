import WebSocket from "ws"
import { ExtensionMessage } from "../shared/ExtensionMessage"
import * as vscode from "vscode"

/**
 * Manages WebSocket connections and message broadcasting
 */
export class WebSocketManager {
	private connections: Set<WebSocket> = new Set()
	private messageHistory: any[] = [] // Store recent messages for new connections
	private readonly MAX_HISTORY = 50 // Maximum number of messages to keep in history

	constructor(private outputChannel: vscode.OutputChannel) {}

	/**
	 * Add a new WebSocket connection
	 */
	addConnection(ws: WebSocket): void {
		this.connections.add(ws)

		// Send message history to new connection
		if (this.messageHistory.length > 0) {
			this.messageHistory.forEach((message) => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify(message))
				}
			})
		}

		ws.on("close", () => {
			this.connections.delete(ws)
		})

		// Send a welcome message
		this.sendToClient(ws, {
			type: "status",
			status: "Connected to Cline server",
		})
	}

	/**
	 * Send a message to a specific client
	 */
	sendToClient(ws: WebSocket, message: any): void {
		if (ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify(message))
			} catch (error: any) {
				this.outputChannel.appendLine(`Error sending message to client: ${error.message}`)
			}
		}
	}

	/**
	 * Broadcast a message to all connected clients
	 */
	broadcast(message: any): void {
		// Add message to history
		this.messageHistory.push(message)

		// Trim history if needed
		if (this.messageHistory.length > this.MAX_HISTORY) {
			this.messageHistory = this.messageHistory.slice(this.messageHistory.length - this.MAX_HISTORY)
		}

		// Send to all connected clients
		this.connections.forEach((ws) => {
			if (ws.readyState === WebSocket.OPEN) {
				try {
					ws.send(JSON.stringify(message))
				} catch (error: any) {
					this.outputChannel.appendLine(`Error broadcasting message: ${error.message}`)
				}
			}
		})
	}

	/**
	 * Process a message from the controller before broadcasting
	 * Transforms ExtensionMessage to a format that CLI clients can understand
	 */
	processControllerMessage(message: ExtensionMessage): any {
		this.outputChannel.appendLine(`Processing controller message: ${message.type}`)

		// Transform the message based on its type
		switch (message.type) {
			case "state":
				// Extract relevant state information for CLI clients
				if (message.state?.clineMessages) {
					// Process each message in the state
					message.state.clineMessages.forEach((clineMessage) => {
						if (clineMessage.type === "say" && clineMessage.text) {
							// Clean up the text by removing JSON-like content
							let cleanText = clineMessage.text

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

							// Send cleaned agent responses to clients
							if (cleanText.trim()) {
								this.broadcast({
									type: "response",
									response: cleanText,
								})
							}
						}
					})
				}
				break

			case "action":
				// Handle action messages
				// For CLI clients, we need to check if there are any Yes/No options to show
				this.broadcast({
					type: "action",
					action: message.action,
				})
				break

			case "partialMessage":
				// Handle streaming responses
				if (message.partialMessage?.text) {
					// Clean up the text by removing JSON-like content
					let cleanText = message.partialMessage.text

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

					// Send cleaned agent responses to clients
					if (cleanText.trim()) {
						this.broadcast({
							type: "response",
							response: cleanText,
						})
					}
				}
				break

			case "invoke":
				// Handle invoke messages (like sending a message)
				if (message.invoke === "sendMessage" && message.text) {
					// This is a message from the user, we can ignore it or forward it
					this.broadcast({
						type: "invoke",
						invoke: message.invoke,
						text: message.text,
					})
				}
				break
		}

		// Return the original message for the controller to process
		return message
	}
}
