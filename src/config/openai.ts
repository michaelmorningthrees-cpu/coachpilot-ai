import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

export const openai = new OpenAI({
  baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});
