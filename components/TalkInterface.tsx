
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { startLiveConversation } from '../services/geminiService';
import type { LiveServerMessage, Blob } from '@google/genai';
import { MicIcon, StopIcon, MuteIcon, UnmuteIcon } from './icons';

// Audio utility functions
function encode(bytes: Uint8Array) {let binary = '';const len = bytes.byteLength;for (let i = 0; i < len; i++) {binary += String.fromCharCode(bytes[i]);}return btoa(binary);}
function createBlob(data: Float32Array): Blob {const l = data.length;const int16 = new Int16Array(l);for (let i = 0; i < l; i++) {int16[i] = data[i] * 32768;}return {data: encode(new Uint8Array(int16.buffer)),mimeType: 'audio/pcm;rate=16000',};}
async function decodeAudioData(data: Uint8Array, ctx: AudioContext): Promise<AudioBuffer> {const dataInt16 = new Int16Array(data.buffer);const frameCount = dataInt16.length;const buffer = ctx.createBuffer(1, frameCount, 24000);const channelData = buffer.getChannelData(0);for (let i = 0; i < frameCount; i++) {channelData[i] = dataInt16[i] / 32768.0;}return buffer;}
function decode(base64: string): Uint8Array {const binaryString = atob(base64);const len = binaryString.length;const bytes = new Uint8Array(len);for (let i = 0; i < len; i++) {bytes[i] = binaryString.charCodeAt(i);}return bytes;}
const audioWorkletCode = `
  class AudioProcessor extends AudioWorkletProcessor {
    process(inputs, outputs, parameters) {
      const inputChannelData = inputs[0][0];
      if (inputChannelData) { this.port.postMessage(inputChannelData.slice(0)); }
      return true;
    }
  }
  registerProcessor('audio-processor', AudioProcessor);
`;

type CallState = 'idle' | 'connecting' | 'active';

interface TranscriptEntry {
    id: string;
    text: string;
    sender: 'user' | 'bot';
}

const TalkInterface: React.FC = () => {
    const [callState, setCallState] = useState<CallState>('idle');
    const [isBotSpeaking, setIsBotSpeaking] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
    const [timeLeft, setTimeLeft] = useState(600); // 10 minutes in seconds

    const sessionPromiseRef = useRef<ReturnType<typeof startLiveConversation> | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const inputAudioContextRef = useRef<AudioContext | null>(null);
    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const audioWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
    const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const nextStartTimeRef = useRef(0);
    const sourcesRef = useRef(new Set<AudioBufferSourceNode>());
    const isLiveRef = useRef(false);
    const chatEndRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [transcript]);

    const handleStopLive = useCallback(() => {
        if (!isLiveRef.current) return;
        isLiveRef.current = false;
        setCallState('idle');
        setIsBotSpeaking(false);
        setIsMuted(false);

        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        setTimeLeft(600);
        
        sessionPromiseRef.current?.then(session => session.close()).catch(e => console.error("Error closing live session:", e));
        streamRef.current?.getTracks().forEach(track => track.stop());
        
        if (audioWorkletNodeRef.current) {
            audioWorkletNodeRef.current.port.onmessage = null;
            audioWorkletNodeRef.current.disconnect();
            audioWorkletNodeRef.current = null;
        }
        if (mediaStreamSourceRef.current) {
            mediaStreamSourceRef.current.disconnect();
            mediaStreamSourceRef.current = null;
        }

        inputAudioContextRef.current?.close().catch(e => {});
        outputAudioContextRef.current?.close().catch(e => {});

        sessionPromiseRef.current = null;
        streamRef.current = null;
    }, []);

    const handleStartLive = async () => {
        if (isLiveRef.current) return;
        setTranscript([]);

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            isLiveRef.current = true;
            setCallState('connecting');

            timerRef.current = setInterval(() => {
                setTimeLeft(prev => {
                    if (prev <= 1) {
                        handleStopLive();
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);

            inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            
            const workletBlob = new Blob([audioWorkletCode], { type: 'application/javascript' });
            const workletURL = URL.createObjectURL(workletBlob);
            await inputAudioContextRef.current.audioWorklet.addModule(workletURL);

            const callbacks = {
                onopen: () => {
                    setCallState('active');
                    const source = inputAudioContextRef.current!.createMediaStreamSource(streamRef.current!);
                    mediaStreamSourceRef.current = source;
                    const workletNode = new AudioWorkletNode(inputAudioContextRef.current!, 'audio-processor');
                    audioWorkletNodeRef.current = workletNode;

                    workletNode.port.onmessage = (event) => {
                        sessionPromiseRef.current?.then((session) => {
                            if (!isMuted && isLiveRef.current) {
                                session.sendRealtimeInput({ media: createBlob(event.data) });
                            }
                        });
                    };
                    source.connect(workletNode);
                    workletNode.connect(inputAudioContextRef.current!.destination);
                },
                onmessage: async (message: LiveServerMessage) => {
                     try {
                        const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                        if (base64Audio && outputAudioContextRef.current?.state === 'running') {
                            setIsBotSpeaking(true);
                            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContextRef.current.currentTime);
                            const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContextRef.current);
                            const sourceNode = outputAudioContextRef.current.createBufferSource();
                            sourceNode.buffer = audioBuffer;
                            sourceNode.connect(outputAudioContextRef.current.destination);
                            sourceNode.addEventListener('ended', () => {
                                sourcesRef.current.delete(sourceNode);
                                if (sourcesRef.current.size === 0) { setIsBotSpeaking(false); }
                            });
                            sourceNode.start(nextStartTimeRef.current);
                            nextStartTimeRef.current += audioBuffer.duration;
                            sourcesRef.current.add(sourceNode);
                        }

                        if (message.serverContent?.interrupted) {
                            for (const source of sourcesRef.current.values()) { source.stop(); }
                            sourcesRef.current.clear();
                            setIsBotSpeaking(false);
                            nextStartTimeRef.current = 0;
                        }

                        const userInputText = message.serverContent?.inputTranscription?.text;
                        const botOutputText = message.serverContent?.outputTranscription?.text;

                        if (userInputText || botOutputText) {
                            setTranscript(prevTranscript => {
                                let currentTranscript = [...prevTranscript];

                                // Handle user transcription
                                if (userInputText) {
                                    const lastEntry = currentTranscript[currentTranscript.length - 1];
                                    if (lastEntry && lastEntry.sender === 'user') {
                                        // Update last user message
                                        currentTranscript[currentTranscript.length - 1] = { ...lastEntry, text: userInputText };
                                    } else {
                                        // Add new user message
                                        currentTranscript.push({ id: `user-${Date.now()}`, text: userInputText, sender: 'user' });
                                    }
                                }
                                
                                // Handle bot transcription
                                if (botOutputText) {
                                    const lastEntry = currentTranscript[currentTranscript.length - 1];
                                    if (lastEntry && lastEntry.sender === 'bot') {
                                        // Update last bot message
                                        currentTranscript[currentTranscript.length - 1] = { ...lastEntry, text: botOutputText };
                                    } else {
                                        // Add new bot message
                                        currentTranscript.push({ id: `bot-${Date.now()}`, text: botOutputText, sender: 'bot' });
                                    }
                                }
                                
                                return currentTranscript;
                            });
                        }

                    } catch (error) {
                        console.error("Error processing live message:", error);
                        handleStopLive();
                    }
                },
                onerror: (e: ErrorEvent) => {
                    console.error('Live conversation error:', e);
                    handleStopLive();
                },
                onclose: () => { handleStopLive(); },
            };
            sessionPromiseRef.current = startLiveConversation(callbacks);
        } catch (error) {
            console.error('Error getting user media:', error);
            setCallState('idle');
        }
    };

    useEffect(() => {
        return () => { handleStopLive(); };
    }, [handleStopLive]);

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    };

    const statusText = callState === 'idle' ? 'Tap the mic to start a voice call' : callState === 'connecting' ? 'Connecting...' : isBotSpeaking ? 'Rani is speaking...' : isMuted ? 'You are muted' : 'Listening...';

    return (
        <div className="flex flex-col h-[80vh] bg-brand-surface rounded-lg shadow-2xl overflow-hidden border border-brand-bg-alt relative">
            <div className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-center p-4 transition-all duration-500 ease-in-out ${callState !== 'idle' ? 'bg-brand-surface/90 border-b border-brand-bg-alt' : ''}`}>
                <div className={`flex flex-col items-center transition-all duration-500 ease-in-out ${callState === 'idle' ? 'scale-100 translate-y-48' : 'scale-100'}`}>
                    <div className="relative">
                        <div className={`w-12 h-12 rounded-full bg-brand-primary flex items-center justify-center text-white font-bold text-2xl font-serif ring-4 ring-brand-primary/20 transition-all duration-500 ease-in-out ${callState === 'idle' ? 'w-40 h-40 text-7xl' : 'w-14 h-14 text-2xl'}`}>R</div>
                        <div className={`absolute inset-0 rounded-full border-4 border-brand-primary transition-all duration-300 ${isBotSpeaking ? 'animate-pulse' : 'opacity-0'}`}></div>
                    </div>
                    <div className={`text-center transition-all duration-500 ease-in-out ${callState === 'idle' ? 'opacity-0 h-0' : 'opacity-100 mt-2'}`}>
                        <h2 className="text-lg font-bold text-brand-secondary">Rani Bhat</h2>
                        <p className="text-sm text-brand-secondary/70">Live Conversation {callState === 'active' && `(${formatTime(timeLeft)})`}</p>
                    </div>
                </div>
            </div>

            <div className="flex-grow pt-32 overflow-y-auto space-y-4 bg-brand-bg-light px-6 pb-40">
                {callState === 'idle' && (
                    <div className="flex flex-col items-center justify-center h-full text-center text-brand-secondary/60">
                         {/* This space is intentionally kept for the large profile pic */}
                    </div>
                )}
                {callState !== 'idle' && transcript.map((entry) => (
                    // Only render if there is text to prevent empty bubbles
                    entry.text.trim() && (
                        <div key={entry.id} className={`flex items-end gap-2 ${entry.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`w-fit max-w-lg p-3 px-4 rounded-2xl shadow-sm ${entry.sender === 'user' ? 'bg-brand-primary text-white rounded-br-none' : 'bg-brand-bg-alt text-brand-secondary rounded-bl-none'}`}>
                                <p className="whitespace-pre-wrap">{entry.text}</p>
                            </div>
                        </div>
                    )
                ))}
                <div ref={chatEndRef} />
            </div>

            <div className="absolute bottom-0 left-0 right-0 p-6 bg-brand-surface/90 border-t border-brand-bg-alt flex flex-col items-center justify-center space-y-4">
                <p className="text-center text-lg h-8 transition-all duration-300 text-brand-secondary/80">{statusText}</p>
                <div className="flex items-center space-x-6">
                    <div className="w-16 h-16"></div> {/* Spacer */}
                    <button
                        onClick={callState !== 'idle' ? handleStopLive : handleStartLive}
                        className={`w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300 ease-in-out shadow-lg text-white ${callState === 'active' ? 'bg-red-500 hover:bg-red-600 animate-pulse' : 'bg-brand-primary hover:bg-brand-primary-light'}`}
                    >
                        {callState !== 'idle' ? <StopIcon className="w-10 h-10" /> : <MicIcon className="w-10 h-10" />}
                    </button>
                    <button 
                        onClick={() => setIsMuted(prev => !prev)}
                        disabled={callState !== 'active'}
                        className="w-16 h-16 rounded-full flex items-center justify-center bg-brand-bg-alt text-brand-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        {isMuted ? <UnmuteIcon className="w-8 h-8"/> : <MuteIcon className="w-8 h-8"/>}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default TalkInterface;
