"use server"

// Add more detailed logging at the top of the file
console.log("[SERVER] llm-service.ts module loaded")

// Add this to the top of the file with other imports
import { debugLog } from "@/lib/debug-logger"

import { generateText, streamText } from "ai"
import { openai } from "@ai-sdk/openai"
import type { KnowledgeEntry } from "@/lib/types"
import { extractTagsFromMarkdown } from "@/lib/utils"

// Add a withTimeout utility function to handle API timeouts
// Add this function near the top of the file, after the existing imports

// Add this utility function for handling timeouts in API calls
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
  })

  return Promise.race([promise, timeoutPromise])
}

// Define the model providers
type ModelProvider = "openai" | "openrouter"

// Define the LLM settings interface
export interface LLMSettings {
  provider: ModelProvider
  model: string
  temperature: number
  maxTokens: number
  topP: number
  frequencyPenalty: number
  presencePenalty: number
  systemFingerprint: boolean
  apiKey?: string
}

// Add this interface for streaming response chunks
export interface ResponseChunk {
  text: string
  isComplete: boolean
}

// Default settings
export const defaultSettings: LLMSettings = {
  provider: "openai",
  model: "gpt-4o",
  temperature: 0.7,
  maxTokens: 1024,
  topP: 0.9,
  frequencyPenalty: 0,
  presencePenalty: 0,
  systemFingerprint: false,
}

// Log the defaultSettings object to check for server references
console.log("[SERVER] defaultSettings defined as:", {
  ...defaultSettings,
  hasServerRef: "__server_ref" in defaultSettings,
  keys: Object.keys(defaultSettings),
  type: typeof defaultSettings,
})

// Add this utility function for retries
export async function withRetry<T>(operation: () => Promise<T>, maxRetries = 3, initialDelay = 1000): Promise<T> {
  let lastError: Error | null = null
  let delay = initialDelay

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.error(`Operation failed (attempt ${attempt + 1}/${maxRetries + 1}):`, lastError)

      // Don't delay on the last attempt
      if (attempt < maxRetries) {
        console.log(`Retrying in ${delay}ms...`)
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay *= 2 // Exponential backoff
      }
    }
  }

  throw lastError || new Error("Operation failed with unknown error")
}

// Direct implementation for OpenRouter API
async function callOpenRouterAPI(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  temperature: number = defaultSettings.temperature,
  max_tokens: number = defaultSettings.maxTokens,
  top_p: number = defaultSettings.topP,
  frequency_penalty: number = defaultSettings.frequencyPenalty,
  presence_penalty: number = defaultSettings.presencePenalty,
) {
  console.log("[SERVER] Calling OpenRouter API with model:", model)
  console.log("[SERVER] OpenRouter API key length:", apiKey.length)
  console.log("[SERVER] OpenRouter API key first 5 chars:", apiKey.substring(0, 5))
  console.log("[SERVER] OpenRouter parameters:", {
    temperature,
    max_tokens,
    top_p,
    frequency_penalty,
    presence_penalty,
  })

  try {
    const requestBody = {
      model,
      messages,
      temperature,
      max_tokens,
      top_p,
      frequency_penalty,
      presence_penalty,
    }

    console.log("[SERVER] Request body:", JSON.stringify(requestBody))

    // Add timeout to the fetch request (60 seconds)
    const fetchPromise = fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://vercel.com",
        "X-Title": "Multi-agent UI Design Grid World",
      },
      body: JSON.stringify(requestBody),
    })

    const response = await withTimeout(fetchPromise, 60000, "OpenRouter API request timed out after 60 seconds")

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[SERVER] OpenRouter API error response:", errorText)
      console.error("[SERVER] Response status:", response.status, response.statusText)
      console.error("[SERVER] Request headers:", {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.substring(0, 5)}...`,
        "HTTP-Referer": "https://vercel.com",
        "X-Title": "Multi-agent UI Design Grid World",
      })

      let errorData
      try {
        errorData = JSON.parse(errorText)
      } catch (e) {
        errorData = { error: { message: errorText } }
      }

      throw new Error(
        `OpenRouter API error: ${response.status} ${response.statusText}${
          errorData ? ` - ${JSON.stringify(errorData)}` : ""
        }`,
      )
    }

    // Add timeout to the JSON parsing (5 seconds)
    const data = await response.json()

    return data.choices[0].message.content
  } catch (error) {
    console.error("[SERVER] Error calling OpenRouter API:", error)
    throw error
  }
}

// Generate a response using a system prompt
export async function generateResponse(
  systemPrompt: string,
  userPrompt: string,
  settings: LLMSettings,
): Promise<string> {
  // CRITICAL FIX: Add detailed logging for provider and API key
  debugLog(`[LLM SERVICE] generateResponse called with provider: ${settings.provider}`)
  debugLog(`[LLM SERVICE] API key available: ${!!settings.apiKey}, length: ${settings.apiKey?.length || 0}`)

  // Ensure provider is set
  if (!settings.provider) {
    debugLog("[LLM SERVICE] No provider specified, defaulting to openai")
    settings.provider = "openai"
  }

  try {
    // Log the incoming settings to check for server references
    console.log("[SERVER] generateResponse called with settings:", {
      ...settings,
      apiKey: settings.apiKey ? `[Length: ${settings.apiKey.length}]` : undefined,
      hasServerRef: "__server_ref" in settings,
      keys: Object.keys(settings),
    })

    // Ensure we have complete settings by merging with defaults
    const completeSettings = { ...defaultSettings, ...settings }

    console.log("[SERVER] completeSettings after merge:", {
      ...completeSettings,
      apiKey: completeSettings.apiKey ? `[Length: ${completeSettings.apiKey.length}]` : undefined,
      hasServerRef: "__server_ref" in completeSettings,
      keys: Object.keys(completeSettings),
    })

    console.log("[SERVER] generateResponse called with settings:", {
      provider: completeSettings.provider,
      model: completeSettings.model,
      temperature: completeSettings.temperature,
      maxTokens: completeSettings.maxTokens,
      topP: completeSettings.topP,
      frequencyPenalty: completeSettings.frequencyPenalty,
      presencePenalty: completeSettings.presencePenalty,
      apiKeyLength: completeSettings.apiKey ? completeSettings.apiKey.length : 0,
    })

    // Check if API key is available
    if (!completeSettings.apiKey) {
      throw new Error(`API key is required for ${completeSettings.provider} provider`)
    }

    // For OpenRouter, use our direct implementation
    if (completeSettings.provider === "openrouter") {
      console.log("[SERVER] Using OpenRouter implementation")
      const messages = []
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt })
      }
      messages.push({ role: "user", content: userPrompt })

      // Add retry logic for OpenRouter calls
      return await withRetry(
        () =>
          callOpenRouterAPI(
            completeSettings.apiKey!,
            completeSettings.model,
            messages,
            completeSettings.temperature,
            completeSettings.maxTokens,
            completeSettings.topP,
            completeSettings.frequencyPenalty,
            completeSettings.presencePenalty,
          ),
        2, // Max 2 retries
        1000, // Initial delay of 1 second
      )
    } else if (completeSettings.provider === "openai") {
      console.log("[SERVER] Using OpenAI implementation")
      // For OpenAI, use the AI SDK
      const model = openai(completeSettings.model, {
        apiKey: completeSettings.apiKey,
        temperature: completeSettings.temperature,
        maxTokens: completeSettings.maxTokens,
        topP: completeSettings.topP,
        frequencyPenalty: completeSettings.frequencyPenalty,
        presencePenalty: completeSettings.presencePenalty,
        systemFingerprint: completeSettings.systemFingerprint,
      })

      // Add timeout to the OpenAI call
      const generateTextPromise = generateText({
        model,
        system: systemPrompt,
        prompt: userPrompt,
      })

      const result = await withTimeout(
        generateTextPromise,
        60000, // 60 second timeout
        "OpenAI API request timed out after 60 seconds",
      )

      return result.text
    } else {
      throw new Error(`Unsupported provider: ${completeSettings.provider}`)
    }
  } catch (error) {
    console.error("[SERVER] Error generating response:", error)
    // Return a meaningful error message that can be displayed to the user
    return `Error: ${error instanceof Error ? error.message : "Unknown error occurred while generating response"}`
  }
}

// Add more detailed logging to streamGenerateResponse function
export async function* streamGenerateResponse(
  systemPrompt: string,
  userPrompt: string,
  settings: LLMSettings,
): AsyncGenerator<ResponseChunk, void, unknown> {
  try {
    console.log("[SERVER] streamGenerateResponse function called")
    console.log("[SERVER] streamGenerateResponse parameters:", {
      systemPromptLength: systemPrompt?.length,
      userPromptLength: userPrompt?.length,
      settingsProvider: settings?.provider,
      settingsModel: settings?.model,
    })

    // Ensure we have complete settings by merging with defaults
    const completeSettings = { ...defaultSettings, ...settings }

    console.log("[SERVER] streamGenerateResponse called with settings:", {
      provider: completeSettings.provider,
      model: completeSettings.model,
      temperature: completeSettings.temperature,
      apiKeyLength: completeSettings.apiKey ? completeSettings.apiKey.length : 0,
    })

    // Rest of the function...
    // Improved streaming response generation with better async iterable implementation
    // export async function* streamGenerateResponse(
    //   systemPrompt: string,
    //   userPrompt: string,
    //   settings: LLMSettings,
    // ): AsyncGenerator<ResponseChunk, void, unknown> {
    //   try {
    //     // Ensure we have complete settings by merging with defaults
    //     const completeSettings = { ...defaultSettings, ...settings }

    //     console.log("[SERVER] streamGenerateResponse called with settings:", {
    //       provider: completeSettings.provider,
    //       model: completeSettings.model,
    //       temperature: completeSettings.temperature,
    //       apiKeyLength: completeSettings.apiKey ? completeSettings.apiKey.length : 0,
    //     })

    // Check if API key is available
    if (!completeSettings.apiKey) {
      yield {
        text: `Error: API key is required for ${completeSettings.provider} provider`,
        isComplete: true,
      }
      return
    }

    if (completeSettings.provider === "openai") {
      console.log("[SERVER] Using OpenAI streaming implementation")

      try {
        const model = openai(completeSettings.model, {
          apiKey: completeSettings.apiKey,
          temperature: completeSettings.temperature,
          maxTokens: completeSettings.maxTokens,
          topP: completeSettings.topP,
          frequencyPenalty: completeSettings.frequencyPenalty,
          presencePenalty: completeSettings.presencePenalty,
          systemFingerprint: completeSettings.systemFingerprint,
        })

        // Use a fallback mechanism in case streaming fails
        let streamFailed = false
        let fullText = ""

        try {
          const stream = await streamText({
            model,
            system: systemPrompt,
            prompt: userPrompt,
          })

          for await (const chunk of stream) {
            fullText += chunk.text
            yield {
              text: chunk.text,
              isComplete: false,
            }
          }
        } catch (streamError) {
          console.error("[SERVER] Error in OpenAI streaming, falling back to non-streaming:", streamError)
          streamFailed = true
        }

        // If streaming failed, fall back to non-streaming
        if (streamFailed) {
          const { text } = await generateText({
            model,
            system: systemPrompt,
            prompt: userPrompt,
          })

          yield {
            text,
            isComplete: false,
          }
        }

        yield {
          text: "",
          isComplete: true,
        }
      } catch (error) {
        console.error("[SERVER] Error in OpenAI response generation:", error)
        yield {
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isComplete: true,
        }
      }
    } else if (completeSettings.provider === "openrouter") {
      // For OpenRouter, implement streaming using their API
      console.log("[SERVER] Using OpenRouter streaming implementation")

      try {
        const messages = []
        if (systemPrompt) {
          messages.push({ role: "system", content: systemPrompt })
        }
        messages.push({ role: "user", content: userPrompt })

        // First try streaming
        let streamFailed = false
        let fullResponse = ""

        try {
          const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${completeSettings.apiKey}`,
              "HTTP-Referer": "https://vercel.com",
              "X-Title": "Multi-agent UI Design Grid World",
            },
            body: JSON.stringify({
              model: completeSettings.model,
              messages,
              temperature: completeSettings.temperature,
              max_tokens: completeSettings.maxTokens,
              top_p: completeSettings.topP,
              frequency_penalty: completeSettings.frequencyPenalty,
              presence_penalty: completeSettings.presencePenalty,
              stream: true, // Enable streaming
            }),
          })

          if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`OpenRouter API error: ${response.status} ${response.statusText} - ${errorText}`)
          }

          if (!response.body) {
            throw new Error("Response body is null")
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder("utf-8")
          let buffer = ""

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              const chunk = decoder.decode(value, { stream: true })
              buffer += chunk

              // Process complete lines from the buffer
              let lineEnd = buffer.indexOf("\n")
              while (lineEnd !== -1) {
                const line = buffer.substring(0, lineEnd).trim()
                buffer = buffer.substring(lineEnd + 1)

                if (line.startsWith("data: ")) {
                  const data = line.slice(6)
                  if (data === "[DONE]") continue

                  try {
                    const parsed = JSON.parse(data)
                    const content = parsed.choices[0]?.delta?.content || ""
                    if (content) {
                      fullResponse += content
                      yield {
                        text: content,
                        isComplete: false,
                      }
                    }
                  } catch (e) {
                    console.error("Error parsing streaming response:", e)
                  }
                }

                lineEnd = buffer.indexOf("\n")
              }
            }
          } finally {
            reader.releaseLock()
          }
        } catch (streamError) {
          console.error("[SERVER] Error in OpenRouter streaming, falling back to non-streaming:", streamError)
          streamFailed = true
        }

        // If streaming failed, fall back to non-streaming
        if (streamFailed) {
          const nonStreamingResponse = await callOpenRouterAPI(
            completeSettings.apiKey,
            completeSettings.model,
            messages,
            completeSettings.temperature,
            completeSettings.maxTokens,
            completeSettings.topP,
            completeSettings.frequencyPenalty,
            completeSettings.presencePenalty,
          )

          yield {
            text: nonStreamingResponse,
            isComplete: false,
          }
        }

        yield {
          text: "",
          isComplete: true,
        }
      } catch (error) {
        console.error("[SERVER] Error in OpenRouter response generation:", error)
        yield {
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isComplete: true,
        }
      }
    } else {
      yield {
        text: `Error: Unsupported provider: ${completeSettings.provider}`,
        isComplete: true,
      }
    }
  } catch (error) {
    console.error("[SERVER] Error in streamGenerateResponse:", error)
    yield {
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isComplete: true,
    }
  }
}

// Add response validation function
export function validateResponse(response: string): { valid: boolean; reason?: string } {
  // Basic validation to ensure response meets quality standards
  if (!response || response.trim().length === 0) {
    return { valid: false, reason: "Empty response" }
  }

  // Check for error messages that might have leaked into the response
  if (
    response.toLowerCase().includes("error") &&
    (response.toLowerCase().includes("api") || response.toLowerCase().includes("key"))
  ) {
    return { valid: false, reason: "Response contains error messages" }
  }

  // Check for minimum length (adjust as needed)
  if (response.length < 10) {
    return { valid: false, reason: "Response too short" }
  }

  return { valid: true }
}

// Enhanced implementation for extracting beliefs
export async function extractBeliefs(
  conversationText: string,
  agentName: string,
  extractionPriorities: string,
  settings: LLMSettings,
): Promise<string> {
  try {
    console.log("[SERVER] extractBeliefs called with priorities:", extractionPriorities)

    // Create a prompt using the belief extraction template
    const systemPrompt = `You are an AI assistant that analyzes conversations and extracts potential new knowledge or beliefs.
Your task is to identify information, facts, or beliefs that should be added to an agent's knowledge base.
Focus on extracting factual information, preferences, opinions, and relationships mentioned in the conversation.

IMPORTANT: Format your response using Obsidian-style markdown. Use [[double brackets]] around important concepts, entities, and categories that should be tagged.`

    const userPrompt = `The following is a conversation involving ${agentName}. 
Extract potential new knowledge or beliefs that ${agentName} should remember from this conversation.
Pay special attention to: ${extractionPriorities}

CONVERSATION:
${conversationText}

List the extracted beliefs in bullet points. Each belief should be a concise statement of fact or opinion.
For each belief:
1. Use [[double brackets]] around key concepts that should be tagged
2. Indicate the confidence level (High/Medium/Low) based on how explicitly it was stated
3. Format the belief as a complete, well-structured markdown note

Example format:
- ${agentName} believes that [[quantum computing]] will revolutionize [[cryptography]] within the next decade. (High)
- ${agentName} seems to prefer [[coffee]] over [[tea]] based on their ordering habits. (Medium)`

    // Call the LLM service to generate a response
    return await generateResponse(systemPrompt, userPrompt, settings)
  } catch (error) {
    console.error("[SERVER] Error in extractBeliefs:", error)
    throw error
  }
}

// Enhanced implementation for generating knowledge entries
export async function generateKnowledgeEntries(beliefs: string, settings: LLMSettings): Promise<KnowledgeEntry[]> {
  try {
    console.log("[SERVER] generateKnowledgeEntries called")

    // Parse the beliefs string to extract individual beliefs
    const beliefLines = beliefs
      .split("\n")
      .filter((line) => line.trim().startsWith("-"))
      .map((line) => line.trim().substring(1).trim())

    // Create knowledge entries from the beliefs
    return beliefLines.map((belief) => {
      // Extract tags using the existing utility
      const tags = extractTagsFromMarkdown(belief)

      // Generate a title based on the first tag or the first few words
      const title = tags.length > 0 ? `Knowledge about ${tags[0]}` : belief.split(" ").slice(0, 3).join(" ")

      return {
        id: `knowledge-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        title,
        content: belief,
        timestamp: new Date(),
        tags,
      }
    })
  } catch (error) {
    console.error("[SERVER] Error in generateKnowledgeEntries:", error)
    return [
      {
        id: `error-${Date.now()}`,
        title: "Error",
        content: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date(),
        tags: ["error"],
      },
    ]
  }
}

// Mock implementation for validating API key
export async function validateApiKey(
  provider: "openai" | "openrouter",
  apiKey: string,
): Promise<{ valid: boolean; message?: string }> {
  console.log("[SERVER] validateApiKey called (mock implementation)")
  return { valid: true, message: `API key validation successful for ${provider}. (This is a mock)` }
}

// Mock implementation for saving LLM settings
export async function saveLLMSettings(settings: LLMSettings): Promise<boolean> {
  console.log("[SERVER] saveLLMSettings called")
  console.log("[SERVER] Saving settings:", {
    ...settings,
    apiKey: settings.apiKey ? `[Length: ${settings.apiKey.length}]` : undefined,
    provider: settings.provider,
  })

  try {
    // In a real app, we would save to a database here
    // For now, we'll just return true to indicate success
    // The client-side code will handle saving to localStorage
    return true
  } catch (error) {
    console.error("[SERVER] Error saving settings:", error)
    return false
  }
}
