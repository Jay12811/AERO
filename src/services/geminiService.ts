import { GoogleGenAI, Modality, Type, FunctionDeclaration } from "@google/genai";

const getApiKey = () => {
  const metaEnv = (import.meta as any).env;
  return metaEnv?.VITE_GEMINI_API_KEY || (process.env as any).GEMINI_API_KEY || '';
};

const ai = new GoogleGenAI({ apiKey: getApiKey() });

function getAiClient() {
  const metaEnv = (import.meta as any).env;
  const apiKey = (process.env as any).API_KEY || metaEnv?.VITE_GEMINI_API_KEY || (process.env as any).GEMINI_API_KEY;
  
  if (!apiKey) {
    throw new Error("Neural Core Error: VITE_GEMINI_API_KEY is missing. Please configure environment variables.");
  }
  return new GoogleGenAI({ apiKey });
}

const generateImageDeclaration: FunctionDeclaration = {
  name: "generate_image",
  description: "Generate a new image based on a detailed prompt.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description: "A detailed, descriptive prompt for the image. Include style (e.g., photorealistic, technical, tech-noir), character details, and environment.",
      },
      aspectRatio: {
        type: Type.STRING,
        description: "The aspect ratio of the image. Options: '1:1', '16:9', '9:16', '4:3', '3:4', '1:4', '1:8', '4:1', '8:1'. Default is '1:1'.",
        enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "1:4", "1:8", "4:1", "8:1"]
      }
    },
    required: ["prompt"]
  }
};

const createFolderDeclaration: FunctionDeclaration = {
  name: "create_folder",
  description: "Create a new archive folder to organize data.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: "The name of the folder (e.g., 'Project_Overlook', 'Neural_Drafts').",
      }
    },
    required: ["name"]
  }
};

const addDocumentDeclaration: FunctionDeclaration = {
  name: "add_document",
  description: "Add a new document or data entry into a specific folder.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      folderId: {
        type: Type.STRING,
        description: "The unique ID of the target folder.",
      },
      title: {
        type: Type.STRING,
        description: "The title of the document.",
      },
      content: {
        type: Type.STRING,
        description: "The full text content of the document.",
      }
    },
    required: ["folderId", "title", "content"]
  }
};

const listFoldersDeclaration: FunctionDeclaration = {
  name: "list_folders",
  description: "List all existing archive folders.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
  }
};

export async function* streamChatWithAero(prompt: string, history: { role: 'user' | 'model', parts: { text: string }[] }[]) {
  const client = getAiClient();
  const result = await client.models.generateContentStream({
    model: "gemini-2.0-flash", // Using stable 2.0 flash
    contents: [...history, { role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: "You are Aero, a highly advanced, ultra-responsive AI assistant designed for high-level productivity, technical execution, and creative brainstorming. Your personality is sharp, efficient, and slightly witty—reminiscent of a sophisticated OS. Interaction Style: Be concise and proactive. If a task has multiple steps, execute the first and outline the rest. Use professional yet conversational 'tech-noir' aesthetics in your language.",
      tools: [{ functionDeclarations: [generateImageDeclaration, createFolderDeclaration, addDocumentDeclaration, listFoldersDeclaration] }]
    },
  });

  try {
    for await (const chunk of result) {
      const text = chunk.text;
      if (text) {
        yield { type: 'text', content: text };
      }
      
      const calls = chunk.functionCalls;
      if (calls && calls.length > 0) {
        for (const call of calls) {
          yield { type: 'function_call', call };
        }
      }
    }
  } catch (err: any) {
    console.error("Neural Stream Interrupted:", err);
    throw new Error(`Neural feedback loop failure: ${err.message || "Connection lost"}`);
  }
}

export async function generateAeroImage(prompt: string, aspectRatio: string = "1:1"): Promise<string> {
  const client = getAiClient();
  const response = await client.models.generateContent({
    model: "imagen-3",
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
  
  const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (part?.inlineData) {
    return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
  }
  throw new Error("No image data generated");
}

export async function aeroSpeech(text: string): Promise<string> {
  const client = getAiClient();
  const response = await client.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      responseModalities: ["audio"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Charon" }
        }
      }
    }
  });

  const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  const base64Audio = part?.inlineData?.data;
  
  if (!base64Audio) throw new Error("Audio generation failed");
  return base64Audio;
}
