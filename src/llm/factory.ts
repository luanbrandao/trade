import { config } from '../config/config';
import { LlmDecider } from './types';
import { ClaudeClient } from './claude-client';
import { OpenAIClient } from './openai-client';
import { GeminiClient } from './gemini-client';
import { DeepSeekClient } from './deepseek-client';

export function createLlmDecider(): LlmDecider {
  switch (config.llm.provider) {
    case 'anthropic':
      return new ClaudeClient();
    case 'openai':
      return new OpenAIClient();
    case 'gemini':
      return new GeminiClient();
    case 'deepseek':
      return new DeepSeekClient();
  }
}
