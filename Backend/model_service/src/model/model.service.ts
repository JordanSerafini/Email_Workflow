import { Injectable } from '@nestjs/common';

interface ModelResponse {
  choices: Array<{
    text: string;
  }>;
}

@Injectable()
export class AppService {
  async callModel(query: string): Promise<string> {
    try {
      const modelUrl = process.env.MODEL_URL;
      if (!modelUrl) {
        throw new Error('MODEL_URL environment variable is not set');
      }

      const response = await fetch(modelUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: query,
          max_tokens: 1000,
          temperature: 0.2,
        }),
      });
      const data = (await response.json()) as ModelResponse;
      return data.choices[0].text;
    } catch (error) {
      console.error('Error calling model:', error);
      throw error;
    }
  }
}
