import { GoogleGenerativeAI } from "@google/generative-ai";
import { CONFIG } from "./config.ts";

export interface ModelClient {
  generate(prompt: string): Promise<string>;
}

export class GeminiModelClient implements ModelClient {
  private model;

  constructor(apiKey: string, modelName: string) {
    this.model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
    });
  }

  async generate(prompt: string) {
    const result = await this.model.generateContent(prompt);
    return result.response.text();
  }
}

export class OpenAICompatibleModelClient implements ModelClient {
  private apiKey: string;
  private modelName: string;
  private baseUrl: string;

  constructor(apiKey: string, modelName: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async generate(prompt: string) {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelName,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `OpenAI-compatible request failed: ${response.status} ${details}`
      );
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || "";
  }
}

export class ModelFactory {
  static defaultModel(provider?: string) {
    if (process.env.AI_MODEL_NAME) return process.env.AI_MODEL_NAME;
    if (provider === "openai") return process.env.OPENAI_MODEL || "gpt-4o-mini";
    if (provider === "nebius")
      return (
        process.env.NEBIUS_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini"
      );
    return CONFIG.MODEL_NAME;
  }

  static resolveApiKey(provider?: string) {
    if (process.env.AI_API_KEY) return process.env.AI_API_KEY;
    if (provider === "openai") return process.env.OPENAI_API_KEY;
    if (provider === "nebius") return process.env.NEBIUS_API_KEY;
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  }

  static create(
    provider: string,
    apiKey: string,
    modelName?: string
  ): ModelClient {
    const normalized = (provider || "gemini").toLowerCase();
    if (normalized === "openai") {
      const baseUrl = (
        process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
      ).trim();
      return new OpenAICompatibleModelClient(
        apiKey,
        modelName || ModelFactory.defaultModel(normalized),
        baseUrl
      );
    }
    if (normalized === "nebius") {
      const baseUrl = (
        process.env.NEBIUS_BASE_URL || "https://api.studio.nebius.ai/v1"
      ).trim();
      return new OpenAICompatibleModelClient(
        apiKey,
        modelName || ModelFactory.defaultModel(normalized),
        baseUrl
      );
    }
    return new GeminiModelClient(apiKey, modelName || CONFIG.MODEL_NAME);
  }
}
