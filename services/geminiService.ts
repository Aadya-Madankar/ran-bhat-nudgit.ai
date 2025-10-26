
// Fix: Removed non-exported type `LiveSession` from import.
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { RANI_BHAT_CHAT_PROMPT, RANI_BHAT_VOICE_PROMPT } from '../constants';
import type { GroundingSource } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });

export async function streamTextResponse(
    prompt: string,
    history: { role: 'user' | 'model'; parts: { text: string }[] }[],
    useSearchGrounding: boolean
): Promise<AsyncGenerator<{ textChunk?: string; sources?: GroundingSource[] }>> {
    try {
        const model = 'gemini-2.5-flash';
        const contents = [...history, { role: 'user' as const, parts: [{ text: prompt }] }];

        const responseStream = await ai.models.generateContentStream({
            model: model,
            contents: contents,
            config: {
                systemInstruction: RANI_BHAT_CHAT_PROMPT,
                ...(useSearchGrounding && { tools: [{ googleSearch: {} }] }),
            },
        });

        async function* generator() {
            let finalSources: GroundingSource[] = [];
            for await (const chunk of responseStream) {
                if (chunk.text) {
                    yield { textChunk: chunk.text };
                }
                
                const groundingChunks = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
                if (groundingChunks) {
                    const sources: GroundingSource[] = groundingChunks.map((chunk: any) => (
                        chunk.web ? {
                            uri: chunk.web.uri,
                            title: chunk.web.title,
                        } : null
                    )).filter((source: GroundingSource | null): source is GroundingSource => source !== null && !!source.uri && !!source.title);
                    finalSources.push(...sources);
                }
            }
            
            // De-duplicate sources
            const uniqueSources = Array.from(new Map(finalSources.map(item => [item.uri, item])).values());
            if (uniqueSources.length > 0) {
                 yield { sources: uniqueSources };
            }
        }
        return generator();

    } catch (error) {
        console.error("Error generating streaming text response:", error);
        async function* errorGenerator() {
            yield { textChunk: "Apologies, I seem to be having trouble connecting. Let's try again in a moment." };
        }
        return errorGenerator();
    }
}

// Fix: Removed explicit return type `Promise<LiveSession>` as `LiveSession` is not exported.
// The return type is now correctly inferred by TypeScript.
export const startLiveConversation = (callbacks: {
    onopen: () => void;
    onmessage: (message: LiveServerMessage) => void;
    onerror: (e: ErrorEvent) => void;
    onclose: (e: CloseEvent) => void;
}) => {
    const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks,
        config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Laomedeia' } },
            },
            systemInstruction: RANI_BHAT_VOICE_PROMPT,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: [{ googleSearch: {} }],
        },
    });
    return sessionPromise;
};
