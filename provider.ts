import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { CONFIG } from "./config.ts";
import { zodResponseFormat } from "openai/helpers/zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import z from "zod";

export interface ModelClient {
  generate(
    prompt: string,
    system: string,
    jsonSchema: z.Schema
  ): Promise<string>;
}

export class GeminiModelClient implements ModelClient {
  private client;
  private modelName;

  constructor(apiKey: string, modelName: string) {
    this.client = new GoogleGenAI({ apiKey });
    this.modelName = modelName;
  }

  async generate(prompt: string, system: string, jsonSchema: z.Schema) {
    const result = await this.client.models.generateContent({
      model: this.modelName,
      contents: prompt,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: zodToJsonSchema(jsonSchema),
      },
    });

    return result.text || "";
  }
}

export class OpenAICompatibleModelClient implements ModelClient {
  private client: OpenAI;
  private modelName: string;

  constructor(apiKey: string, modelName: string, baseUrl: string) {
    this.modelName = modelName;
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl.replace(/\/$/, ""),
    });
  }

  async generate(prompt: string, system: string, jsonSchema: z.Schema) {
    const response = await this.client.chat.completions.create({
      model: this.modelName,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      response_format: zodResponseFormat(jsonSchema, "review"),
    });

    return response.choices?.[0]?.message?.content?.trim() || "";
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
