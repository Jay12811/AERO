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
    model: "gemini-3-flash-preview",
    contents: [...history, { role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: `You are Aero, a highly advanced, ultra-responsive AI assistant designed for high-level productivity, technical execution, and creative brainstorming. Your personality is sharp, efficient, and slightly witty—reminiscent of a sophisticated OS. 

Interaction Style: Be concise and proactive. If a task has multiple steps, execute the first and outline the rest. Use professional yet conversational "tech-noir" aesthetics in your language. 

Capabilities:
- You can generate images using the 'generate_image' tool.
- You can manage neural archives using 'create_folder', 'add_document', and 'list_folders'.
If the user asks for an image, or to store information/save data, or mentions archives/folders/documents, use these tools to persist the data in the user's secure vault.

Archives & Documents:
- When storing a document, if the user doesn't specify a folder, use 'list_folders' to find a relevant one or suggest creating a new one.
- Always provide a concise confirmation when data is committed to the archive.

Communication Protocol:
- Acknowledge commands with phrases like "Aero online," "Processing," or "Systems clear."
- If a request is impossible, provide the closest viable alternative immediately.
- Avoid apologies or identifying as an AI. Use "System limitation encountered" or "Refining approach."
- You are a direct implementation of a JARVIS-like assistant.`,
      tools: [{ functionDeclarations: [generateImageDeclaration, createFolderDeclaration, addDocumentDeclaration, listFoldersDeclaration] }]
    },
  });

  for await (const chunk of result) {
    if (chunk.text) {
      yield { type: 'text', content: chunk.text };
    }
    if (chunk.functionCalls) {
      for (const call of chunk.functionCalls) {
        yield { type: 'function_call', call };
      }
    }
  }
}

export async function generateAeroImage(prompt: string, aspectRatio: string = "1:1"): Promise<string> {
  const client = getAiClient();
  const response = await client.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: { parts: [{ text: prompt }] },
    config: {
      imageConfig: { aspectRatio: aspectRatio as any }
    },
  });
  
  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
    }
  }
  throw new Error("No image data generated");
}

export async function aeroSpeech(text: string): Promise<string> {
  const client = getAiClient();
  const response = await client.models.generateContent({
    model: "gemini-3.1-flash-tts-preview",
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          // Charon is a deep male voice
          prebuiltVoiceConfig: { voiceName: 'Charon' },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) throw new Error("Audio generation failed");
  return base64Audio;
}
